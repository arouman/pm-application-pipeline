#!/usr/bin/env python3
"""migrate-redesign.py — one-shot, idempotent migration to the
queue=decision-inbox / ledger=lifecycle schema.

What it does (after backing up both files to *.bak-YYYY-MM-DD):

  LEDGER  add `referral` (default False) and a backfilled `statusHistory`
          ([{status, date}]) to every entry that lacks them. Purely additive —
          no entry is removed, no status changed.

  QUEUE   keep only items in the live set {new, pending, building}. Terminal
          items (built / skipped / passed / error) are dropped: every "built"
          item is already recorded in the ledger, and the others are declined
          or failed and represented there too — so the inbox starts clean and
          the watcher repopulates it with fresh "new" finds.

Safe to run repeatedly: a second run finds nothing to change.

Usage:  python3 scripts/migrate-redesign.py [--dry-run]
"""
import argparse
import fcntl
import json
import os
import shutil
import sys
from contextlib import contextmanager
from datetime import date
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
QUEUE = REPO / "applied" / "_queue" / "queue.json"
LEDGER = REPO / "applied" / "applied-ledger.json"

LIVE_QUEUE_STATES = {"new", "pending", "building"}


@contextmanager
def locked(path: Path):
    """Exclusive flock on the file, matching queue.py/ledger.py so we never
    race the running bridge mid-write."""
    fh = open(path, "r+")
    fcntl.flock(fh, fcntl.LOCK_EX)
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


def backup(path: Path) -> Path:
    b = path.with_name(path.name + f".bak-{date.today().isoformat()}")
    if not b.exists():
        shutil.copy2(path, b)
    return b


def migrate_ledger(dry: bool):
    with locked(LEDGER) as (data, save):
        entries = data.get("entries", [])
        added_ref = added_hist = 0
        for e in entries:
            if "referral" not in e:
                if not dry:
                    e["referral"] = False
                added_ref += 1
            if "statusHistory" not in e:
                when = e.get("firstSeen") or e.get("appliedDate") or date.today().isoformat()
                if not dry:
                    e["statusHistory"] = [{"status": e.get("status", "queued"), "date": when}]
                added_hist += 1
        if not dry:
            save()
        return len(entries), added_ref, added_hist


def migrate_queue(dry: bool):
    with locked(QUEUE) as (data, save):
        items = data.get("items", [])
        kept = [it for it in items if it.get("status", "pending") in LIVE_QUEUE_STATES]
        dropped = [it for it in items if it.get("status", "pending") not in LIVE_QUEUE_STATES]
        if not dry:
            data["items"] = kept
            save()
        return len(items), len(kept), dropped


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true",
                    help="report what would change without writing")
    args = ap.parse_args()
    dry = args.dry_run

    if not QUEUE.exists() or not LEDGER.exists():
        print("queue.json or applied-ledger.json missing — nothing to do", file=sys.stderr)
        sys.exit(1)

    if not dry:
        print(f"backup → {backup(QUEUE).name}")
        print(f"backup → {backup(LEDGER).name}")

    total_l, ref, hist = migrate_ledger(dry)
    print(f"ledger: {total_l} entries — +referral on {ref}, +statusHistory on {hist}")

    total_q, kept, dropped = migrate_queue(dry)
    print(f"queue: {total_q} items → {kept} kept (live), {len(dropped)} dropped (terminal)")
    for it in dropped:
        print(f"    drop [{it.get('status')}] {it.get('company')} — {it.get('title')}")

    print("DRY RUN — no files written" if dry else "migration complete")


if __name__ == "__main__":
    main()
