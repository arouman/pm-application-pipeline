#!/usr/bin/env bash
# run-batch.sh — headless supervisor for the application pipeline.
#
# Walks queue.json and builds each PENDING item by spawning a FRESH `claude -p`
# process (one application per process = bounded context; nothing accumulates in
# any single session). State lives on disk, so a kill/restart resumes losslessly
# at the next pending item.
#
# Rate-limit handling (the unattended-overnight requirement):
#   - If a `claude -p` run reports a usage/rate limit, the supervisor records a
#     resume time in $PAUSE_FILE and exits 75 (EX_TEMPFAIL).
#   - A launchd/cron wrapper re-invokes this script periodically; while
#     $PAUSE_FILE holds a future timestamp the script exits immediately (no-op),
#     so the batch self-heals when the 5-hour / weekly window reopens.
#   - "Finish what you're working on, then stop" is automatic: each item is a
#     discrete process that writes `built` before the next one starts.
#
# Single-instance guard: a flock on SELF_LOCK_FILE ensures only one supervisor
# runs at a time, regardless of how it was spawned (launchd, bridge /build, or
# manual). On exit (clean or crash/kill) the in-flight item is reset to pending
# so the next run resumes from it; the lockfile is removed automatically when
# the fd closes.
#
# Usage:
#   run-batch.sh [--queue PATH] [--max N] [--dry-run] [--recover]
#
# Env:
#   MODEL=sonnet            model for the builder (default sonnet)
#   PAUSE_SECONDS=3600      fallback backoff if a reset time can't be parsed
#   CLAUDE_FLAGS="..."      override the claude permission/flags (see below)
#   STALE_BUILD_SECONDS=1800 seconds before a building item is considered orphaned (30 min default)
set -uo pipefail

# launchd spawns with a bare PATH (/usr/bin:/bin) — claude lives in ~/.local/bin.
# Only extend PATH when claude isn't already resolvable, so a shell/test that
# puts its own claude earlier on PATH is respected.
command -v claude >/dev/null 2>&1 || export PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
QUEUE="$REPO/applied/_queue/queue.json"
QPY="python3 $REPO/scripts/lib/queue.py"
SPEC="$REPO/.claude/agents/application-builder.md"
# PAUSE_FILE / LOG_DIR are env-overridable so the retry path is testable.
PAUSE_FILE="${PAUSE_FILE:-$REPO/applied/_queue/.paused-until}"
LOG_DIR="${LOG_DIR:-$REPO/applied/_queue/logs}"
MODEL="${MODEL:-sonnet}"
PAUSE_SECONDS="${PAUSE_SECONDS:-3600}"
STALE_BUILD_SECONDS="${STALE_BUILD_SECONDS:-1800}"
MAX=0; DRY=0; RECOVER=0

# ── Single-instance lock ─────────────────────────────────────────────────────
# SELF_LOCK_FILE is env-overridable for test isolation.
# Strategy: write our PID atomically into the lockfile; on startup check if
# the recorded PID is still live. This is not perfectly race-free (two
# simultaneous starts could both read "no PID"), but in practice launchd +
# bridge only spawn one run-batch at a time, and the queue's flock guard
# prevents data corruption even if two runs do overlap briefly.
SELF_LOCK_FILE="${SELF_LOCK_FILE:-$REPO/applied/_queue/.run-batch.lock}"

if [[ -f "$SELF_LOCK_FILE" ]]; then
  existing_pid=$(cat "$SELF_LOCK_FILE" 2>/dev/null || echo "")
  if [[ -n "$existing_pid" ]] && kill -0 "$existing_pid" 2>/dev/null; then
    echo "run-batch.sh already running (lock held by pid $existing_pid). exiting."
    exit 0
  fi
fi
# Write our PID (not perfectly atomic, but good enough — see note above).
echo $$ > "$SELF_LOCK_FILE"

# Headless runs cannot answer permission prompts. This is the standard headless
# pattern for a trusted, self-owned automation; review before enabling at scale.
CLAUDE_FLAGS="${CLAUDE_FLAGS:---model $MODEL --output-format json --dangerously-skip-permissions}"

while [[ $# -gt 0 ]]; do case "$1" in
  --queue) QUEUE="$2"; shift 2;;
  --max) MAX="$2"; shift 2;;
  --dry-run) DRY=1; shift;;
  --recover) RECOVER=1; shift;;
  *) echo "unknown arg: $1" >&2; exit 2;;
esac; done
mkdir -p "$LOG_DIR"

# ── Orphan-build tracker: reset current item on unexpected exit ───────────────
# _inflight_id is set when we claim an item; cleared when it completes/fails.
# On SIGTERM/SIGINT: set a flag so the loop body can abort cleanly, then fall
# through to EXIT which resets the in-flight item.
# On EXIT: reset any item that is still in-flight (status building OR error due
# to the signal racing the fail call).
_inflight_id=""
_interrupted=0
_cleanup() {
  if [[ -n "$_inflight_id" ]]; then
    echo "run-batch.sh exiting; resetting in-flight item '$_inflight_id' → pending"
    # reset-building covers items still in "building"; also explicitly reset
    # this item by id in case it was raced to "error" by the fail branch.
    $QPY "$QUEUE" reset-building >/dev/null 2>&1 || true
    # If it ended up as error (race condition), set it back to pending explicitly
    $QPY "$QUEUE" build "$_inflight_id" >/dev/null 2>&1 || true
  fi
  rm -f "$SELF_LOCK_FILE" 2>/dev/null || true
}
_sighandler() {
  _interrupted=1
  _cleanup
  exit 0
}
trap '_cleanup; exit 0' EXIT
trap '_sighandler' INT TERM

now=$(date +%s)
# --- pause guard: bail out quietly if we're still inside a rate-limit window ---
if [[ -f "$PAUSE_FILE" ]]; then
  until=$(cat "$PAUSE_FILE" 2>/dev/null || echo 0)
  if [[ "$until" =~ ^[0-9]+$ ]] && (( now < until )); then
    until_date=$(date -r "$until" 2>/dev/null || date -d "@$until" 2>/dev/null || echo "$until")
    echo "paused until ${until_date}; exiting (will retry)"; exit 0
  fi
  rm -f "$PAUSE_FILE"
fi

# ── On startup: sweep any stale building items from a previous crash ──────────
# This covers the case where a previous run died without its trap firing (e.g.
# SIGKILL, power loss, OOM). Any item stuck building for >STALE_BUILD_SECONDS
# is reset to pending so this run can claim it.
stale_reset=$($QPY "$QUEUE" stale-building --older-than "$STALE_BUILD_SECONDS" 2>/dev/null || echo "reset 0")
[[ "$stale_reset" != "reset 0" ]] && echo "startup: $stale_reset stale building items → pending"

[[ $RECOVER -eq 1 ]] && $QPY "$QUEUE" reset-building

command -v claude >/dev/null 2>&1 || { echo "claude CLI not on PATH" >&2; exit 1; }

count=0
while :; do
  (( MAX > 0 && count >= MAX )) && { echo "hit --max $MAX"; break; }
  item=$($QPY "$QUEUE" next)            # atomically claims next pending → building
  [[ -z "$item" ]] && { echo "queue drained"; break; }
  id=$(printf '%s' "$item" | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")
  company=$(printf '%s' "$item" | python3 -c "import sys,json;print(json.load(sys.stdin)['company'])")
  title=$(printf '%s' "$item" | python3 -c "import sys,json;print(json.load(sys.stdin)['title'])")
  _inflight_id="$id"
  echo "── building [$id] $title @ $company"

  prompt="Read $SPEC in full, then execute its protocol exactly for this assignment JSON: $item
Do every step (trap-scan, ground in /recruiter, tailor resume, write cover letter, build PDFs, write application.md + field-map.json, record pending keywords). Your FINAL message must be ONLY the return-payload JSON."

  if [[ $DRY -eq 1 ]]; then
    echo "DRY-RUN → claude -p [prompt for $id] $CLAUDE_FLAGS"
    $QPY "$QUEUE" claim "$id" >/dev/null   # leave as building in dry-run
    count=$((count+1)); continue
  fi

  log="$LOG_DIR/$id.json"

  # Build with bounded exponential backoff on TRANSIENT (Anthropic 5xx /
  # overloaded) API errors. A transient error must NOT permanently fail the
  # item — after exhausting retries we requeue it (→ pending) for a later pass.
  # This is the fix for the Omada-500 incident (a server-side 500 mid-build re-
  # failed 3× and the role got stuck in "error" until it was built by hand).
  # Timeout for a single build attempt. macOS has no timeout(1), so we use a
  # background watchdog that kills the builder PID after BUILD_TIMEOUT seconds
  # and requeues to pending (not error) — the same treatment as a transient error.
  BUILD_TIMEOUT="${BUILD_TIMEOUT:-1200}"   # 20 min; env-overridable

  MAX_ATTEMPTS="${BUILD_RETRIES:-3}"
  attempt=1
  requeued=0
  timed_out=0
  while :; do
    _build_tmpout=$(mktemp)
    claude -p "$prompt" $CLAUDE_FLAGS >"$_build_tmpout" 2>"$log.err" &
    _build_pid=$!
    # Watchdog runs in a subshell so it can't accidentally set shell vars.
    ( sleep "$BUILD_TIMEOUT" && kill "$_build_pid" 2>/dev/null ) &
    _watchdog_pid=$!
    wait "$_build_pid"; rc=$?
    # Disarm the watchdog (best-effort; harmless if it already fired).
    kill "$_watchdog_pid" 2>/dev/null; wait "$_watchdog_pid" 2>/dev/null || true
    out=$(cat "$_build_tmpout" 2>/dev/null || echo ""); rm -f "$_build_tmpout"
    printf '%s' "$out" > "$log"
    blob="$out $(cat "$log.err" 2>/dev/null)"

    # rc=143 = SIGTERM from the watchdog (128+15)
    if [[ $rc -eq 143 ]] || [[ $rc -eq 137 ]]; then
      echo "  [$id] build timed out after ${BUILD_TIMEOUT}s — requeuing to pending"
      _inflight_id=""
      $QPY "$QUEUE" build "$id" >/dev/null
      requeued=1
      timed_out=1
      break
    fi

    # --- rate-limit / usage-limit → pause the whole batch, resume later ---
    if printf '%s' "$blob" | grep -qiE 'usage limit|rate.?limit|limit reached|429|resets? at|too many requests'; then
      reset=$(printf '%s' "$blob" | grep -oiE 'reset[^0-9]*([0-9]{10})' | grep -oE '[0-9]{10}' | head -1)
      [[ -z "$reset" ]] && reset=$(( now + PAUSE_SECONDS ))
      echo "$reset" > "$PAUSE_FILE"
      _inflight_id=""   # the reset-building call below handles the queue reset
      $QPY "$QUEUE" reset-building >/dev/null   # this item → pending; resume later
      echo "paused until $(date -r "$reset" 2>/dev/null || date -d "@$reset" 2>/dev/null || echo "$reset"). exiting 75 (supervisor will resume)."
      exit 75
    fi

    # --- transient server-side error (5xx / overloaded) → backoff + retry ---
    if printf '%s' "$blob" | grep -qiE '"api_error_status":[[:space:]]*5[0-9][0-9]|internal server error|bad gateway|service unavailable|overloaded'; then
      if (( attempt < MAX_ATTEMPTS )); then
        backoff=$(( 5 * 3 ** (attempt - 1) ))   # 5s, 15s, 45s, …
        echo "  transient API error on [$id] (attempt $attempt/$MAX_ATTEMPTS) — retrying in ${backoff}s"
        sleep "$backoff"
        attempt=$((attempt + 1))
        continue
      fi
      _inflight_id=""   # about to requeue; no longer in-flight
      $QPY "$QUEUE" build "$id" >/dev/null       # exhausted → requeue (pending), NOT a permanent error
      echo "  [$id] transient API error after $MAX_ATTEMPTS attempts — requeued for the next pass"
      requeued=1
    fi
    break
  done
  if [[ $requeued -eq 1 ]]; then _inflight_id=""; count=$((count + 1)); continue; fi

  # --- success / failure bookkeeping ---
  # Parse the builder return payload. The claude CLI wraps output in a JSON
  # envelope; the builder's own return payload is in .result (string or object).
  # A successful build has ok=true in the inner payload.
  ok=$(printf '%s' "$out" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    # The CLI envelope has subtype='success' and is_error=false for a clean exit.
    # Within that, the builder sets ok=true. We require BOTH: clean exit AND ok=true.
    if d.get('is_error') or d.get('subtype') == 'error':
        print('0'); sys.exit()
    r = d.get('result') or d.get('text') or ''
    if isinstance(r, dict):
        print('1' if r.get('ok') else '0')
        sys.exit()
    if isinstance(r, str):
        try:
            inner = json.loads(r)
            print('1' if inner.get('ok') else '0')
            sys.exit()
        except Exception:
            pass
    # Fall back to substring scan as last resort
    print('1' if '\"ok\": true' in r or '\"ok\":true' in r else '0')
except Exception:
    print('0')
" 2>/dev/null)
  # Capture the output folder the builder created (folderName in its payload) so
  # the queue + ledger can link to the files. Missing → complete without it.
  folder=$(printf '%s' "$out" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    r = d.get('result') or d.get('text') or ''
    obj = r if isinstance(r, dict) else (json.loads(r) if isinstance(r, str) else {})
    print(obj.get('folderName') or '')
except Exception:
    print('')
" 2>/dev/null)
  # Skip bookkeeping if we were interrupted (SIGTERM/SIGINT) — the trap will
  # reset the item. This prevents a spurious fail() call from racing the trap.
  if [[ $_interrupted -eq 1 ]]; then break; fi

  if [[ $rc -eq 0 && "$ok" == "1" ]]; then
    _inflight_id=""   # clear BEFORE terminal write so a SIGTERM arriving here
    if [[ -n "$folder" ]]; then $QPY "$QUEUE" complete "$id" --folder "$folder" >/dev/null
    else $QPY "$QUEUE" complete "$id" >/dev/null; fi  # cannot re-queue an already-built item
    echo "  built [$id]"
  else
    _inflight_id=""   # clear BEFORE terminal write (same race applies to fail)
    $QPY "$QUEUE" fail "$id" --error "rc=$rc; see $log" >/dev/null
    echo "  failed [$id] (rc=$rc) — logged to $log"
  fi
  count=$((count+1))
done

echo "── batch done. status: $($QPY "$QUEUE" status)"
