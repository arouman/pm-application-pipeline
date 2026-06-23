# Cloud Finder — How It Works

## The split

```
CLOUD (GitHub Actions)          LOCAL (Mac on wake)
────────────────────────        ──────────────────────────────────
Runs every 30 min, 24/7         Runs when your Mac wakes / --once
  scripts/cloud_scrape.py         scripts/watch-jobs.py --once
  ↓                               ↓
  Scrapes ATS boards              git pull (gets cloud/found.json)
  Cheap title/location filter     _ingest_cloud_buffer()
  Captures new postings           Scores via `claude -p` (local)
  ↓                               ↓
  cloud/found.json (committed)    Decision inbox (queue.json)
  cloud/seen-jobs.json            Rob reviews + clicks Build/Pass
```

## No API key, $0 cost

The cloud step is pure HTTP — it only fetches public ATS JSON and HTML.
It performs **zero LLM calls**. No `ANTHROPIC_API_KEY`, no secrets block in
the workflow. GitHub's free tier gives 2,000 minutes/month per public repo
and 500 minutes/month per private repo; at ~30 seconds per run every 30
minutes, this uses roughly 720 minutes/month — comfortably within free limits
for a public repo, or easily covered by the Copilot/Actions free tier for
private repos.

All fit scoring happens on Rob's Mac using his flat-rate Claude subscription
via `claude -p`. The cloud side is intentionally dumb so it stays free and
private.

## Files in this directory

| File | Written by | Read by |
|---|---|---|
| `found.json` | `cloud_scrape.py` (Actions) | `watch-jobs.py` (Mac) |
| `seen-jobs.json` | `cloud_scrape.py` (Actions) | `cloud_scrape.py` only |
| `README.md` | humans | humans |

`found.json` is append-only from the cloud side. The local watcher tracks
how far it has read via `applied/_queue/cloud-cursor.json` (not committed —
gitignored) so it never re-scores a posting it has already processed.

## Activating the workflow

Push the repo (including `.github/workflows/cloud-find.yml`) to the GitHub
remote. The cron starts automatically once the workflow file is on the default
branch. No further setup required.

To run it immediately: go to Actions → "Cloud Job Finder" → "Run workflow".

## Pausing or changing the cron cadence

Edit `.github/workflows/cloud-find.yml` → `schedule.cron`. Valid cron syntax
(UTC). To pause entirely, comment out the `schedule:` block; `workflow_dispatch`
still lets you trigger manually.

## What the cloud side never does

- Never calls an LLM or any AI API.
- Never reads Rob's resume, keyword bank, or dossier.
- Never writes outside the `cloud/` directory.
- Never has access to any secrets (none are configured).
