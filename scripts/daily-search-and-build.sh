#!/usr/bin/env bash
# daily-search-and-build.sh
# Runs at 5:03am daily via launchd (com.adamrouman.jobpipeline.daily.plist).
# 1) Searches Ashby for 25 new qualifying PM roles and adds them to queue.json
# 2) Runs the build batch to produce resume + cover letter pairs
# All output lands flat in applied/YYYY-MM-DD/ — no per-job subfolders.
set -uo pipefail

# launchd spawns with a bare PATH — extend it
command -v claude >/dev/null 2>&1 || export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$REPO/applied/_queue/logs"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/daily-$(date +%Y-%m-%d).log"

echo "=== daily run started $(date) ===" | tee -a "$LOG"

# Step 1: Search for 25 new roles and enqueue them (sonnet for web search quality)
echo "--- searching Ashby for 25 new PM roles ---" | tee -a "$LOG"
claude -p "$(cat "$REPO/scripts/search-enqueue-prompt.md")" \
  --model sonnet \
  --dangerously-skip-permissions \
  >> "$LOG" 2>&1

echo "--- search complete, starting builds ---" | tee -a "$LOG"

# Step 2: Build all pending items (haiku for speed + cost)
MODEL=haiku bash "$REPO/scripts/run-batch.sh" >> "$LOG" 2>&1

echo "=== daily run complete $(date) ===" | tee -a "$LOG"
