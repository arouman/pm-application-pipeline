#!/usr/bin/env python3
"""queue.py — tiny, dependency-free state store for the application pipeline.

The queue file (applied/_queue/queue.json) is the single source of truth for
"what's left to build." It lets the orchestrator (Claude) and the headless
supervisor (run-batch.sh spawning `claude -p`) share state on disk, so context
can be cleared/restarted between batches with nothing lost — resume = "next
pending item."

All mutations take an exclusive flock so concurrent `claude -p` workers never
corrupt the file.

Item status: new → pending → building → built | error | skipped | passed

  new      scraped role awaiting Rob's Build/Pass decision (the review inbox);
           `next` does NOT claim these, so the watcher can never auto-build.
  pending  approved for building (Rob clicked Build, or a manual /intake URL)
  building → built | error      (run-batch lifecycle)
  passed   Rob declined the role from the inbox
  skipped  declined a pending/errored build

Usage:
  queue.py path status                         # counts by status
  queue.py path list [STATUS]                  # ids (default: pending)
  queue.py path get ID                          # one item as JSON
  queue.py path next                            # claim+print next pending (sets building); empty if none
  queue.py path claim ID                        # set building
  queue.py path build ID                        # new → pending (Rob approved it for building)
  queue.py path pass ID                         # → passed (Rob declined it from the inbox)
  queue.py path complete ID --folder F --coverage N
  queue.py path fail ID --error "msg"
  queue.py path skip ID --error "msg"
  queue.py path add  --json '<item>'           # append an item (id required, dedup by id)
  queue.py path reset-building                  # building → pending (recover after a crash)
  queue.py path stale-building [--older-than N] # building items with startedAt > N seconds ago → pending
  queue.py path dedup                           # drop pending/new/error dupes sharing a jdUrl (keeps built/building)
"""
import argparse, fcntl, json, os, sys
from contextlib import contextmanager


@contextmanager
def locked(path, write):
    """Open the queue with an advisory lock; yield the parsed object + a saver."""
    if not os.path.exists(path):
        with open(path, "w") as fh:
            json.dump({"version": 1, "items": []}, fh)
    fh = open(path, "r+")
    fcntl.flock(fh, fcntl.LOCK_EX if write else fcntl.LOCK_SH)
    try:
        fh.seek(0)
        data = json.load(fh)
        def save():
            fh.seek(0); fh.truncate()
            json.dump(data, fh, indent=2, ensure_ascii=False)
            fh.flush(); os.fsync(fh.fileno())
        yield data, save
    finally:
        fcntl.flock(fh, fcntl.LOCK_UN); fh.close()


def find(data, _id):
    for it in data["items"]:
        if it["id"] == _id:
            return it
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("path")
    ap.add_argument("cmd")
    ap.add_argument("id", nargs="?")
    ap.add_argument("--folder"); ap.add_argument("--coverage")
    ap.add_argument("--error"); ap.add_argument("--json")
    ap.add_argument("--older-than", type=int, default=900,
                    help="stale-building: reset items started more than N seconds ago (default 900)")
    a = ap.parse_args()
    write = a.cmd in {"next", "claim", "build", "pass", "complete", "fail",
                      "skip", "add", "reset-building", "stale-building", "dedup"}

    with locked(a.path, write) as (data, save):
        items = data["items"]
        if a.cmd == "status":
            from collections import Counter
            c = Counter(it.get("status", "pending") for it in items)
            print(json.dumps({"total": len(items), **c}))
        elif a.cmd == "list":
            want = a.id or "pending"
            print("\n".join(it["id"] for it in items if it.get("status", "pending") == want))
        elif a.cmd == "get":
            it = find(data, a.id); print(json.dumps(it) if it else ""); sys.exit(0 if it else 1)
        elif a.cmd == "next":
            it = next((x for x in items if x.get("status", "pending") == "pending"), None)
            if not it:
                print(""); return
            import time as _time
            it["status"] = "building"
            it["startedAt"] = int(_time.time())
            save(); print(json.dumps(it))
        elif a.cmd == "claim":
            import time as _time
            it = find(data, a.id)
            it["status"] = "building"
            it["startedAt"] = int(_time.time())
            save()
        elif a.cmd in ("build", "pass"):
            it = find(data, a.id)
            if not it:
                print("not found " + str(a.id), file=sys.stderr); sys.exit(1)
            # build: approve a "new" inbox item for building (→ pending so `next`
            # picks it up). pass: decline it (→ passed; never builds).
            it["status"] = "pending" if a.cmd == "build" else "passed"
            save(); print(f"{a.cmd} {a.id}")
        elif a.cmd == "complete":
            it = find(data, a.id); it["status"] = "built"
            if a.folder: it["folder"] = a.folder
            if a.coverage: it["coverage"] = a.coverage
            it.pop("startedAt", None)  # clear build-start timestamp on completion
            save()
        elif a.cmd in ("fail", "skip"):
            it = find(data, a.id); it["status"] = "error" if a.cmd == "fail" else "skipped"
            if a.error: it["error"] = a.error
            save()
        elif a.cmd == "add":
            new = json.loads(a.json); new.setdefault("status", "pending")
            if not find(data, new["id"]):
                items.append(new); save(); print("added " + new["id"])
            else:
                print("dup " + new["id"])
        elif a.cmd == "reset-building":
            n = 0
            for it in items:
                if it.get("status") == "building":
                    it["status"] = "pending"; n += 1
            save(); print(f"reset {n}")
        elif a.cmd == "stale-building":
            # Reset building items whose startedAt is older than --older-than seconds.
            # Items with no startedAt are treated as stale (legacy orphans).
            import time as _time
            now_ts = int(_time.time())
            threshold = getattr(a, 'older_than', 900)
            n = 0
            for it in items:
                if it.get("status") != "building":
                    continue
                started = it.get("startedAt")
                if started is None or (now_ts - int(started)) > threshold:
                    it["status"] = "pending"
                    it.pop("startedAt", None)
                    n += 1
            save(); print(f"reset {n}")
        elif a.cmd == "dedup":
            # Remove duplicate items sharing a jdUrl, keeping the most-advanced
            # one. NEVER removes built/building items (preserves done + in-flight
            # work); only prunes pending/new/error/skipped dupes. Legacy dupes
            # came from the pre-fix era when non-ATS URLs got random ids; stable
            # ids now block new ones via the add-dedup above.
            PRIORITY = {"built": 0, "submitted": 0, "building": 1, "pending": 2,
                        "new": 3, "error": 4, "skipped": 5, "passed": 5}
            def _score(x):
                return (PRIORITY.get(x.get("status", "pending"), 9),
                        1 if str(x.get("id", "")).startswith("manual__") else 0)
            best = {}
            for it in items:
                u = it.get("jdUrl")
                if not u:
                    continue
                if u not in best or _score(it) < _score(best[u]):
                    best[u] = it
            keep, removed = [], []
            for it in items:
                u = it.get("jdUrl")
                if not u or best.get(u) is it:
                    keep.append(it)
                elif it.get("status") in ("pending", "new", "error", "skipped"):
                    removed.append(it.get("id"))
                else:
                    keep.append(it)
            data["items"] = keep
            save()
            print(json.dumps({"removed_count": len(removed), "removed": removed}))
        else:
            print("unknown cmd", file=sys.stderr); sys.exit(2)


if __name__ == "__main__":
    main()
