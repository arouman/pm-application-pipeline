#!/usr/bin/env python3
"""ledger.py — 6-month dedup ledger for the application pipeline.

Single source of truth for "have we already applied here?" Companion to
queue.py; uses the same flock-guarded read/write pattern so concurrent
callers (bridge server shelling out, watcher daemon, run-batch hooks) never
corrupt the file.

Entry schema (PINNED — downstream consumers depend on this exact shape):
  {
    "key":         str,                         # canonical dedup key (see below)
    "company":     str,
    "title":       str,
    "ats":         str | null,
    "jobId":       str | null,
    "applyUrl":    str,
    "folder":      str | null,
    "status":      "new|queued|built|submitted|screener|interview|offer|"
                   "accepted|rejected|no-response|withdrew|passed|skipped",
    "referral":    bool,                        # was a referral used? (conversion lever)
    "statusHistory": [ {"status": str, "date": "YYYY-MM-DD"}, ... ],  # the funnel trail
    "firstSeen":   "YYYY-MM-DD",
    "appliedDate": "YYYY-MM-DD" | null,
    "coverage":    int | null                   # JD keyword-coverage % at build
  }

  The lifecycle outcome (status) is a free-form string — the dropdown in the UI
  drives it; this module records every transition into statusHistory so we can
  later see the funnel (submitted→screener→interview→offer) and time-in-stage.

Canonical key rules:
  - When both ats AND jobId are known: "{ats}:{jobId}"
  - Otherwise: norm(company) + "|" + norm(title)
    where norm = lowercase, strip punctuation (keep hyphens), collapse
    whitespace to single hyphen.

Duplicate window: 183 days from the EARLIER of firstSeen / appliedDate.

CLI contract (PINNED — watcher workstream shells out to these exactly):
  ledger.py <ledger.json> check <key>
      exits 0; prints JSON {"duplicate": true/false, "entry": ...}
      duplicate=true only when an entry with that key has firstSeen or
      appliedDate within the last 183 days.

  ledger.py <ledger.json> add --json '<entry json>'
      upsert by key (merge — supplied fields overwrite; omitted fields kept)

  ledger.py <ledger.json> mark <key> [--status <s>] [--date YYYY-MM-DD] [--referral true|false]
      update status (appends to statusHistory); set appliedDate if --date given
      or status==submitted and no appliedDate yet. --referral sets the referral
      flag. At least one of --status / --referral is required.

  ledger.py <ledger.json> list [--status X]
      print all entries as a JSON array; optional status filter.
"""
import argparse
import fcntl
import json
import os
import re
import sys
from contextlib import contextmanager
from datetime import date, timedelta
from typing import Optional


# ---------------------------------------------------------------------------
# Key normalisation
# ---------------------------------------------------------------------------

def norm(text: str) -> str:
    """Lowercase, strip punctuation (except hyphens), collapse spaces → hyphens."""
    t = text.lower()
    # Remove characters that are neither alphanumeric, space, nor hyphen
    t = re.sub(r"[^\w\s-]", "", t)
    # Collapse whitespace runs and replace with hyphens
    t = re.sub(r"[\s_]+", "-", t.strip())
    return t


def canonical_key(ats: Optional[str], job_id: Optional[str],
                  company: str, title: str) -> str:
    """Return the canonical dedup key for an entry."""
    if ats and job_id:
        return f"{ats}:{job_id}"
    return f"{norm(company)}|{norm(title)}"


# ---------------------------------------------------------------------------
# Flock-safe file access (same pattern as queue.py)
# ---------------------------------------------------------------------------

@contextmanager
def locked(path: str, write: bool):
    """Open the ledger with an advisory lock; yield (entries_list, save_fn)."""
    if not os.path.exists(path):
        with open(path, "w") as fh:
            json.dump({"version": 1, "entries": []}, fh)
    fh = open(path, "r+")
    fcntl.flock(fh, fcntl.LOCK_EX if write else fcntl.LOCK_SH)
    try:
        fh.seek(0)
        data = json.load(fh)

        def save():
            fh.seek(0)
            fh.truncate()
            json.dump(data, fh, indent=2, ensure_ascii=False)
            fh.flush()
            os.fsync(fh.fileno())

        yield data, save
    finally:
        fcntl.flock(fh, fcntl.LOCK_UN)
        fh.close()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

WINDOW_DAYS = 183


def _within_window(entry: dict) -> bool:
    """Return True if either firstSeen or appliedDate is within 183 days."""
    today = date.today()
    cutoff = today - timedelta(days=WINDOW_DAYS)
    for field in ("firstSeen", "appliedDate"):
        val = entry.get(field)
        if val:
            try:
                d = date.fromisoformat(val)
                if d >= cutoff:
                    return True
            except ValueError:
                pass
    return False


def _find(entries: list, key: str) -> Optional[dict]:
    for e in entries:
        if e.get("key") == key:
            return e
    return None


def _today() -> str:
    return date.today().isoformat()


def _append_history(entry: dict, status: str, when: Optional[str] = None) -> None:
    """Record a status transition in entry['statusHistory'].

    No-op when the most recent recorded status is already this one, so repeated
    marks/reconciles don't bloat the trail. This is what gives us the funnel.
    """
    hist = entry.setdefault("statusHistory", [])
    if hist and hist[-1].get("status") == status:
        return
    hist.append({"status": status, "date": when or _today()})


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

def cmd_check(data: dict, key: str):
    entry = _find(data["entries"], key)
    if entry is None:
        print(json.dumps({"duplicate": False, "entry": None}))
    else:
        is_dup = _within_window(entry)
        print(json.dumps({"duplicate": is_dup, "entry": entry}))


def cmd_add(data: dict, save, raw_json: str):
    new = json.loads(raw_json)
    # Ensure the key field is present
    if "key" not in new:
        new["key"] = canonical_key(
            new.get("ats"), new.get("jobId"),
            new.get("company", ""), new.get("title", "")
        )

    existing = _find(data["entries"], new["key"])
    if existing is None:
        new.setdefault("firstSeen", _today())
        new.setdefault("appliedDate", None)
        new.setdefault("status", "queued")
        new.setdefault("referral", False)
        new.setdefault("statusHistory",
                       [{"status": new["status"], "date": new["firstSeen"]}])
        data["entries"].append(new)
    else:
        prev_status = existing.get("status")
        # An upsert must not silently clobber lifecycle metadata the caller
        # didn't mean to touch — referral, the history trail, and firstSeen are
        # owned by the ledger, not by a re-add from the watcher/reconcile.
        for protected in ("referral", "statusHistory", "firstSeen"):
            new.pop(protected, None)
        existing.update(new)
        if new.get("status") and new["status"] != prev_status:
            if "statusHistory" not in existing:
                existing["statusHistory"] = [
                    {"status": prev_status or new["status"],
                     "date": existing.get("firstSeen", _today())}]
            _append_history(existing, new["status"])
    save()
    print(json.dumps({"ok": True, "key": new["key"]}))


def cmd_mark(data: dict, save, key: str, status: Optional[str],
             date_str: Optional[str], referral: Optional[bool] = None):
    entry = _find(data["entries"], key)
    if entry is None:
        print(json.dumps({"ok": False, "error": f"key not found: {key}"}),
              file=sys.stderr)
        sys.exit(1)
    if status:
        # Backfill a starting point for legacy entries that predate the trail,
        # so their first transition still shows where they came from.
        if "statusHistory" not in entry and entry.get("status"):
            entry["statusHistory"] = [{"status": entry["status"],
                                       "date": entry.get("firstSeen") or _today()}]
        entry["status"] = status
        _append_history(entry, status, date_str)
        if date_str:
            entry["appliedDate"] = date_str
        elif status == "submitted" and not entry.get("appliedDate"):
            entry["appliedDate"] = _today()
    if referral is not None:
        entry["referral"] = referral
    save()
    print(json.dumps({"ok": True, "key": key,
                      "status": entry.get("status"),
                      "referral": entry.get("referral")}))


def cmd_list(data: dict, status_filter: Optional[str]):
    entries = data["entries"]
    if status_filter:
        entries = [e for e in entries if e.get("status") == status_filter]
    print(json.dumps(entries, indent=2, ensure_ascii=False))


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(
        description="Ledger CLI — 6-month dedup store for the application pipeline."
    )
    ap.add_argument("path", help="Path to ledger JSON file")
    ap.add_argument("cmd", choices=["check", "add", "mark", "list"],
                    help="Command to run")
    ap.add_argument("key", nargs="?", help="Canonical key (check/mark)")
    ap.add_argument("--json", dest="json_str",
                    help="Entry JSON for add command")
    ap.add_argument("--status", help="Status value for mark/list")
    ap.add_argument("--date", dest="date_str",
                    help="Applied date YYYY-MM-DD for mark command")
    ap.add_argument("--referral", choices=["true", "false"],
                    help="Set the referral flag (mark)")
    args = ap.parse_args()

    referral = None if args.referral is None else (args.referral == "true")

    write = args.cmd in ("add", "mark")

    with locked(args.path, write) as (data, save):
        if args.cmd == "check":
            if not args.key:
                ap.error("check requires a key argument")
            cmd_check(data, args.key)

        elif args.cmd == "add":
            if not args.json_str:
                ap.error("add requires --json")
            cmd_add(data, save, args.json_str)

        elif args.cmd == "mark":
            if not args.key:
                ap.error("mark requires a key argument")
            if not args.status and referral is None:
                ap.error("mark requires --status and/or --referral")
            cmd_mark(data, save, args.key, args.status, args.date_str, referral)

        elif args.cmd == "list":
            cmd_list(data, args.status)


if __name__ == "__main__":
    main()
