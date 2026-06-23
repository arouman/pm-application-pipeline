#!/usr/bin/env python3
"""cloud_scrape.py — GitHub Actions cloud finder.

Runs on ubuntu-latest every 30 minutes (see .github/workflows/cloud-find.yml).
Scrapes every verified company in bridge/targets.json, applies the SAME cheap
title/location pre-filters used locally, and appends new postings (with full
JD text) to cloud/found.json. Seen-job deduplication is persisted in
cloud/seen-jobs.json so each posting is captured exactly once.

Design principles:
  - Pure Python stdlib (urllib) — no third-party packages.
  - NO anthropic package, NO API key, NO LLM. The cloud side is a dumb
    discovery buffer; all scoring happens locally on Rob's Mac.
  - Idempotent: re-running is safe; already-seen keys are skipped.
  - Path-agnostic: all paths are derived from __file__, not from any
    any user-specific prefix, so it runs correctly on any machine.

Output files (committed back by the workflow):
  cloud/found.json      — {"version":1, "postings":[...]}
  cloud/seen-jobs.json  — {"ats:jobId": "ISO-timestamp", ...}
"""

import json
import logging
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

# ---------------------------------------------------------------------------
# Paths — relative to this file so they work on any machine
# ---------------------------------------------------------------------------

_HERE = Path(__file__).resolve().parent
REPO = _HERE.parent
TARGETS_JSON = REPO / "bridge" / "targets.json"
CLOUD_DIR = REPO / "cloud"
CLOUD_FOUND = CLOUD_DIR / "found.json"
CLOUD_SEEN = CLOUD_DIR / "seen-jobs.json"

# Shared module — on the runner it lives at scripts/lib/ats_fetch.py
sys.path.insert(0, str(_HERE / "lib"))
from ats_fetch import fetch_company, fetch_full_jd, matches_title, matches_location
from url_normalize import normalize_url_for_dedup

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

logging.basicConfig(
    format="[%(asctime)s %(levelname)s] %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
    level=logging.INFO,
    stream=sys.stderr,
)
log = logging.getLogger("cloud-scrape")

# ---------------------------------------------------------------------------
# State helpers
# ---------------------------------------------------------------------------


def _load_found() -> dict:
    """Load cloud/found.json or return a fresh envelope."""
    if CLOUD_FOUND.exists():
        try:
            return json.loads(CLOUD_FOUND.read_text())
        except Exception as exc:
            log.warning("cloud/found.json unreadable (%s) — starting fresh", exc)
    return {"version": 1, "postings": []}


_FOUND_MAX = 500  # max postings to retain; older entries are dropped on compaction

def _save_found(data: dict) -> None:
    """Atomically write cloud/found.json, compacting to the newest _FOUND_MAX entries.

    Compaction drops the oldest postings (lowest indices) when the list exceeds
    the cap. The local watcher cursor (cloud-cursor.json) is reset to 0 on
    compaction — safe because the watcher's ledger + seen-jobs dedup skips any
    posting it has already ingested, so replaying from index 0 is idempotent.
    """
    CLOUD_DIR.mkdir(parents=True, exist_ok=True)
    postings = data.get("postings", [])
    compacted = len(postings) > _FOUND_MAX
    if compacted:
        data = {**data, "postings": postings[-_FOUND_MAX:]}
        # Reset the local cursor so the watcher doesn't try to index past the
        # (now shorter) list. Dedup in the watcher makes replay safe.
        cursor_path = REPO / "applied" / "_queue" / "cloud-cursor.json"
        if cursor_path.exists():
            try:
                cursor_path.write_text("0")
                log.info("cloud/found.json compacted to %d entries; cursor reset to 0", _FOUND_MAX)
            except Exception as exc:
                log.warning("Could not reset cloud cursor after compaction: %s", exc)
    tmp = CLOUD_FOUND.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False))
    tmp.rename(CLOUD_FOUND)


def _load_seen() -> dict:
    """Load cloud/seen-jobs.json or return {}."""
    if CLOUD_SEEN.exists():
        try:
            return json.loads(CLOUD_SEEN.read_text())
        except Exception as exc:
            log.warning("cloud/seen-jobs.json unreadable (%s) — starting fresh", exc)
    return {}


def _save_seen(seen: dict) -> None:
    """Atomically write cloud/seen-jobs.json."""
    CLOUD_DIR.mkdir(parents=True, exist_ok=True)
    tmp = CLOUD_SEEN.with_suffix(".tmp")
    tmp.write_text(json.dumps(seen, indent=2, ensure_ascii=False, sort_keys=True))
    tmp.rename(CLOUD_SEEN)


# ---------------------------------------------------------------------------
# Canonical key (mirrors watch-jobs.py)
# ---------------------------------------------------------------------------

def _canonical_key(job: dict) -> str:
    """Return 'ats:jobId' — the same key used by watch-jobs and the ledger."""
    return f"{job['ats']}:{job['jobId']}"


# ---------------------------------------------------------------------------
# Main scrape
# ---------------------------------------------------------------------------


def run_scrape() -> int:
    """Scrape all verified targets and append new matches to the cloud buffer.

    Returns the count of newly captured postings.
    """
    # Load targets
    try:
        raw = json.loads(TARGETS_JSON.read_text())
        companies = [c for c in (raw.get("companies") or []) if c.get("verified")]
    except Exception as exc:
        log.error("Failed to load targets.json: %s", exc)
        return 0

    log.info("Loaded %d verified targets", len(companies))

    seen = _load_seen()
    found_data = _load_found()
    postings = found_data.get("postings") or []

    is_seeding = len(seen) == 0
    if is_seeding:
        log.info("FIRST RUN — seeding cloud/seen-jobs.json. No postings captured this pass.")

    now_iso = datetime.now(timezone.utc).isoformat()
    new_count = 0

    for company in companies:
        try:
            jobs = fetch_company(company, log)
            log.info("%s (%s): %d jobs fetched", company["name"], company["ats"], len(jobs))
        except Exception as exc:
            log.warning("Fetch failed for %s (%s): %s — skipping",
                        company["name"], company.get("ats"), exc)
            continue

        for job in jobs:
            key = _canonical_key(job)

            if is_seeding:
                # Seed pass: record every visible key to seen, capture nothing.
                if key not in seen:
                    seen[key] = now_iso
                continue

            # --- Cheap pre-filter 1: title ---
            # We only mark a posting as "seen" after it passes both pre-filters.
            # This lets filter-keyword changes recapture roles that previously
            # failed the filter — they won't be in seen, so they're re-evaluated.
            if not matches_title(job["title"]):
                log.debug("Skip (title): %s — %s", job["company"], job["title"])
                continue

            # --- Cheap pre-filter 2: location ---
            if not matches_location(job["location"]):
                log.debug("Skip (location): %s — %s @ %s",
                          job["company"], job["title"], job["location"])
                continue

            # --- Dedup against already-captured postings ---
            # seen[key] is only set after a posting passes the filters (see above),
            # so a prior-run timestamp here means "was captured in found.json before."
            if key in seen:
                log.debug("Skip (seen): %s", key)
                continue

            # Mark as seen (filter-passing) so we don't re-capture next run.
            seen[key] = now_iso

            # --- Fetch full JD text ---
            log.info("Fetching JD: %s — %s", job["company"], job["title"])
            jd_text = fetch_full_jd(job, log)

            # --- Capture to buffer ---
            posting = {
                "company": job["company"],
                "title": job["title"],
                "url": job["jdUrl"],
                "ats": job["ats"],
                "slug": job.get("slug") or "",
                "jobId": job["jobId"],
                "tier": job.get("tier") or 0,
                "location": job["location"],
                "jd_text": jd_text,
                "found_at": now_iso,
            }
            postings.append(posting)
            new_count += 1
            log.info("Captured: %s — %s", job["company"], job["title"])

    # Persist updated state
    found_data["postings"] = postings
    _save_found(found_data)
    _save_seen(seen)

    if is_seeding:
        log.info("Seeded %d keys into cloud/seen-jobs.json. Next run will capture new postings.",
                 len(seen))
    else:
        log.info("Done. %d new posting(s) added to cloud/found.json (total: %d)",
                 new_count, len(postings))

    return new_count


if __name__ == "__main__":
    run_scrape()
