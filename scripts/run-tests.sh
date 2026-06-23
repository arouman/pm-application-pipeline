#!/usr/bin/env bash
#
# run-tests.sh — one command to answer "is the pipeline working?"
#
# Runs three suites against throwaway sandboxes (Rob's real queue/ledger are
# never touched):
#   1. Python data layer    — scripts/lib/test_*.py   (queue.py / ledger.py CLI)
#   2. Watcher decisions     — scripts/test_*.py        (title/location filters)
#   3. Node server (integration) — bridge/server.test.js (HTTP + data layer)
#
# Exits non-zero if any suite fails, so it drops cleanly into CI / a pre-commit
# hook / a launchd health check.
#
# Usage:  bash scripts/run-tests.sh
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fail=0

section() { printf '\n\033[1m── %s\033[0m\n' "$1"; }
report()  { if [ "$1" -eq 0 ]; then printf '\033[32m✔ %s\033[0m\n' "$2";
            else printf '\033[31m✗ %s (exit %s)\033[0m\n' "$2" "$1"; fail=1; fi; }

section "Python — data layer (queue.py / ledger.py)"
python3 -m unittest discover -s "$REPO/scripts/lib" -t "$REPO/scripts/lib" -p "test_*.py"
report $? "data-layer tests"

section "Python — watcher decision logic"
python3 -m unittest discover -s "$REPO/scripts" -t "$REPO/scripts" -p "test_*.py"
report $? "watcher tests"

section "Node — bridge server (integration)"
node --test "$REPO"/bridge/*.test.js
report $? "server integration tests"

section "Bash — run-batch retry/disposition"
bash "$REPO/scripts/test_run_batch.sh"
report $? "run-batch tests"

echo
if [ "$fail" -eq 0 ]; then
  printf '\033[32m═══ ALL SUITES PASSED ═══\033[0m\n'
else
  printf '\033[31m═══ SOME SUITES FAILED ═══\033[0m\n'
fi
exit "$fail"
