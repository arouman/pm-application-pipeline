#!/usr/bin/env python3
"""rescore-all.py — Bulk re-scorer for the application ledger.

Iterates every non-terminal ledger entry, resolves its stored JD file from the
matching queue item, and re-runs the watcher fit-scorer (_score_job) on it.
Writes the new fitScore back to both the ledger entry and the queue item
in-place (flock'd), exactly mirroring the per-row /control/rescore route.

Run directly (detached) by POST /control/rescore-all.  Never call directly
from the UI — use the bridge endpoint which guards single-instance execution.

Usage:
    python3 scripts/rescore-all.py [--concurrency N]

Env overrides:
    RESCORE_NO_WRITE=1   Dry-run: score but skip disk writes (for testing).
    QUEUE_PATH           Override queue.json location.
    LEDGER_PATH          Override applied-ledger.json location.
"""

import argparse
import asyncio
import fcntl
import json
import logging
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Optional

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

REPO = Path(__file__).resolve().parent.parent

# env-overridable so the test suite can point at a temp sandbox
QUEUE_JSON  = Path(os.environ.get("QUEUE_PATH",  str(REPO / "applied" / "_queue" / "queue.json")))
LEDGER_JSON = Path(os.environ.get("LEDGER_PATH", str(REPO / "applied" / "applied-ledger.json")))
LOCK_FILE   = REPO / "applied" / "_queue" / ".rescore-all.lock"
LOG_FILE    = REPO / "applied" / "_queue" / "rescore-all.log"

WATCH_SCRIPT = REPO / "scripts" / "watch-jobs.py"
LEDGER_PY    = REPO / "scripts" / "lib" / "ledger.py"

# launchd spawns with a bare PATH; claude lives in ~/.local/bin
os.environ["PATH"] = (
    f"{Path.home()}/.local/bin:/opt/homebrew/bin:" + os.environ.get("PATH", "")
)

# ---------------------------------------------------------------------------
# Terminal statuses — rescoring these is pointless (role is dead or done)
# ---------------------------------------------------------------------------

TERMINAL_STATUSES = frozenset({
    "rejected",
    "withdrew",
    "no-response",
    "submitted",   # already applied; score won't change anything
    "passed",      # Rob explicitly declined
    "expired",
    "skipped",
    "accepted",
})

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

def _setup_logging() -> None:
    level = getattr(logging, os.environ.get("WATCH_LOG_LEVEL", "INFO").upper(), logging.INFO)
    fmt = "[%(asctime)s %(levelname)s] %(message)s"
    # Log to stderr AND to LOG_FILE so the bridge can surface progress
    handlers: list[logging.Handler] = [logging.StreamHandler(sys.stderr)]
    try:
        LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
        fh = logging.FileHandler(str(LOG_FILE), mode="a", encoding="utf-8")
        fh.setFormatter(logging.Formatter(fmt, datefmt="%Y-%m-%dT%H:%M:%S"))
        handlers.append(fh)
    except OSError:
        pass
    logging.basicConfig(format=fmt, datefmt="%Y-%m-%dT%H:%M:%S", level=level, handlers=handlers)


log = logging.getLogger("rescore-all")


# ---------------------------------------------------------------------------
# Data helpers
# ---------------------------------------------------------------------------

def _load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _canonical_key(ats: Optional[str], job_id: Optional[str], company: str, title: str) -> str:
    """Mirror server.js canonicalKey: ats:jobId preferred, else company|title slug."""
    if ats and job_id:
        return f"{ats}:{job_id}"
    def _norm(s: str) -> str:
        import re
        s = s.lower()
        s = re.sub(r"[^\w\s-]", "", s)
        s = re.sub(r"[\s_]+", "-", s).strip()
        return s
    return f"{_norm(company)}|{_norm(title)}"


def _score_one(jd_path: Path) -> Optional[dict]:
    """Run watch-jobs.py --score-one and return parsed score dict, or None on failure."""
    try:
        r = subprocess.run(
            [sys.executable, str(WATCH_SCRIPT), "--score-one", str(jd_path)],
            capture_output=True, text=True, timeout=120,
        )
        if r.returncode != 0:
            log.warning("scorer exited %d for %s; stderr: %s",
                        r.returncode, jd_path.name, r.stderr[:300])
            return None
        return json.loads(r.stdout.strip())
    except subprocess.TimeoutExpired:
        log.warning("scorer timed out for %s", jd_path.name)
        return None
    except json.JSONDecodeError as exc:
        log.warning("scorer returned non-JSON for %s: %s", jd_path.name, exc)
        return None
    except Exception as exc:
        log.warning("scorer error for %s: %s", jd_path.name, exc)
        return None


def _write_score_to_ledger(key: str, fit_score: int, role_type: Optional[str]) -> None:
    """Upsert fitScore (and roleType if present) into the ledger entry."""
    payload: dict = {"key": key, "fitScore": fit_score}
    if role_type:
        payload["roleType"] = role_type
    subprocess.run(
        [sys.executable, str(LEDGER_PY), str(LEDGER_JSON), "add",
         "--json", json.dumps(payload)],
        capture_output=True, text=True, timeout=10,
    )


def _write_score_to_queue(queue_path: Path, item_id: str, fit_score: int) -> None:
    """Flock'd in-place patch of fitScore on the matching queue item."""
    patch = ";".join([
        "import sys,json,fcntl",
        "path,item_id,score_str=sys.argv[1],sys.argv[2],sys.argv[3]",
        "score=int(score_str)",
        "f=open(path,'r+')",
        "fcntl.flock(f,fcntl.LOCK_EX)",
        "data=json.load(f)",
        "[it.update({'fitScore':score}) for it in data['items'] if it['id']==item_id]",
        "f.seek(0);json.dump(data,f,indent=2);f.truncate()",
    ])
    subprocess.run(
        [sys.executable, "-c", patch, str(queue_path), item_id, str(fit_score)],
        capture_output=True, text=True, timeout=10,
    )


# ---------------------------------------------------------------------------
# Rate-limit detection
# ---------------------------------------------------------------------------

_RATE_LIMIT_PHRASES = (
    "rate limit",
    "rate_limit",
    "overloaded",
    "429",
    "too many requests",
    "usage limit",
)

def _looks_like_rate_limit(text: str) -> bool:
    t = text.lower()
    return any(p in t for p in _RATE_LIMIT_PHRASES)


# ---------------------------------------------------------------------------
# Core rescore loop
# ---------------------------------------------------------------------------

async def _rescore_row(
    entry: dict,
    queue_items_by_key: dict,
    queue_items_by_url: dict,
    semaphore: asyncio.Semaphore,
    no_write: bool,
) -> str:
    """Score one ledger entry.  Returns a brief status string for logging."""
    key = entry.get("key", "")
    apply_url = (entry.get("applyUrl") or "").rstrip("/")
    company = entry.get("company", "?")
    title = entry.get("title", "?")

    # Resolve queue item
    queue_item = queue_items_by_key.get(key)
    if queue_item is None and apply_url:
        queue_item = queue_items_by_url.get(apply_url)
    if queue_item is None:
        return f"SKIP (no queue item): {company} — {title}"

    jd_path_str = queue_item.get("jdPath") or ""
    if not jd_path_str:
        return f"SKIP (no jdPath): {company} — {title}"

    jd_path = Path(jd_path_str)
    if not jd_path.exists():
        return f"SKIP (jd missing): {company} — {title}"

    async with semaphore:
        # Run the blocking scorer in a thread so we don't block the event loop
        loop = asyncio.get_event_loop()
        score = await loop.run_in_executor(None, _score_one, jd_path)

    if score is None:
        # Check stderr for rate-limit signals — already logged by _score_one.
        # We can't distinguish rate-limit from other failures here without
        # re-running; just return an error marker. The caller treats a run of
        # consecutive None results as a signal to abort.
        return f"ERROR (scorer): {company} — {title}"

    fit_score = score.get("fitScore")
    if fit_score is None:
        return f"ERROR (no fitScore field): {company} — {title}"

    role_type = score.get("roleType") or score.get("master")

    if not no_write:
        _write_score_to_ledger(key, fit_score, role_type)
        _write_score_to_queue(QUEUE_JSON, queue_item["id"], fit_score)

    return f"OK {fit_score}%: {company} — {title}"


async def _run(concurrency: int, no_write: bool) -> int:
    """Main async loop.  Returns exit code (0=success, 1=error)."""
    log.info("rescore-all starting (concurrency=%d, no_write=%s)", concurrency, no_write)

    # Load queue and ledger
    try:
        queue_data = _load_json(QUEUE_JSON)
    except Exception as exc:
        log.error("Cannot read queue.json: %s", exc)
        return 1

    try:
        ledger_data = _load_json(LEDGER_JSON)
    except Exception as exc:
        log.error("Cannot read ledger: %s", exc)
        return 1

    all_queue_items: list[dict] = queue_data.get("items") or []
    all_ledger_entries: list[dict] = ledger_data.get("entries") or []

    # Build lookup tables for queue items
    queue_items_by_key: dict[str, dict] = {}
    queue_items_by_url: dict[str, dict] = {}
    for it in all_queue_items:
        k = _canonical_key(it.get("ats"), it.get("jobId"), it.get("company", ""), it.get("title", ""))
        queue_items_by_key[k] = it
        url = (it.get("jdUrl") or "").rstrip("/")
        if url:
            queue_items_by_url[url] = it

    # Filter: skip terminal statuses; also skip "new" (unreviewed inbox items —
    # the watcher will score them as they land, so bulk rescoring is noisy/wasteful)
    SKIP_STATUSES = TERMINAL_STATUSES | {"new"}
    candidates = [e for e in all_ledger_entries if e.get("status") not in SKIP_STATUSES]

    total = len(candidates)
    log.info("%d candidate rows to rescore (of %d total ledger entries)", total, len(all_ledger_entries))
    if total == 0:
        log.info("Nothing to rescore — all entries are in terminal/inbox states.")
        return 0

    semaphore = asyncio.Semaphore(concurrency)
    tasks = [
        asyncio.create_task(_rescore_row(entry, queue_items_by_key, queue_items_by_url, semaphore, no_write))
        for entry in candidates
    ]

    done_count = 0
    error_streak = 0
    MAX_ERROR_STREAK = 3  # abort if 3 consecutive scorer failures (likely rate-limited)

    for coro in asyncio.as_completed(tasks):
        result = await coro
        done_count += 1
        log.info("rescored %d/%d — %s", done_count, total, result)

        if result.startswith("ERROR"):
            error_streak += 1
            if error_streak >= MAX_ERROR_STREAK:
                log.error(
                    "Aborting: %d consecutive scorer errors — likely rate-limited. "
                    "Rescored %d/%d rows. Re-run when the rate limit clears.",
                    MAX_ERROR_STREAK, done_count, total,
                )
                # Cancel remaining tasks cleanly
                for t in tasks:
                    t.cancel()
                return 1
        else:
            error_streak = 0

    log.info("rescore-all complete: %d/%d rows processed.", done_count, total)
    return 0


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> None:
    _setup_logging()

    ap = argparse.ArgumentParser(description="Bulk re-score all active ledger entries")
    ap.add_argument("--concurrency", type=int, default=3,
                    help="Max parallel Claude calls (default: 3)")
    args = ap.parse_args()

    no_write = os.environ.get("RESCORE_NO_WRITE", "").strip() == "1"
    if no_write:
        log.info("RESCORE_NO_WRITE=1 — dry-run mode: scores computed but not written")

    exit_code = asyncio.run(_run(args.concurrency, no_write))
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
