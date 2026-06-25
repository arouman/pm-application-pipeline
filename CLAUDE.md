# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this repo is

An AI-assisted job application pipeline. It searches Ashby and Greenhouse job boards nightly, qualifies roles against a candidate's background, and builds tailored resume + cover letter packages for each passing role. Two phases:

1. **Search** — `claude -p scripts/search-enqueue-prompt.md` (Sonnet) finds and queues 25 roles
2. **Build** — `bash scripts/run-batch.sh` spawns one `claude -p .claude/agents/application-builder.md` per queued role (Haiku)

## Repo layout

```
.claude/agents/          Claude sub-agents (application-builder, dossier-builder, jd-scout)
claude-assets/skills/    Recruiter skill + reference files (projects.md, competencies.md, etc.)
scripts/                 Shell/Python/Node orchestration scripts
master-resumes/          User's base .docx resumes (gitignored by name pattern)
private/                 PII — gitignored; never commit
applied/                 Generated output — gitignored
```

## Key files

| File | Purpose |
|------|---------|
| `scripts/run-batch.sh` | Headless build supervisor — flock, watchdog, rate-limit handler |
| `scripts/lib/queue.py` | Disk-backed queue with atomic flock operations |
| `scripts/daily-search-and-build.sh` | Nightly orchestrator: search → build |
| `scripts/verbatim2.js` | Pre-vetted resume bullet bank; agent selects by index, never rewrites |
| `scripts/builder5.js` | Resume .docx builder; reads contact info from `private/applicant-profile.json` |
| `scripts/build-pair.js` | Assembles resume + cover letter from `build-args.json` |
| `.claude/agents/application-builder.md` | Per-role build agent spec |
| `claude-assets/skills/recruiter/references/projects.md` | Canonical career history — verified metrics only |
| `claude-assets/skills/recruiter/references/competencies.md` | Skills allow-list + proficiency tags |

## Anti-fabrication rules (never violate)

- Claude **only** claims experience traceable to `projects.md` or `competencies.md`
- Claude **selects bullet indices** from `verbatim2.js` — it never writes new bullet text
- `⚠️` flags in `projects.md` mark overclaim guardrails — carry them into every artifact
- Cover letters **paraphrase** JD language; they never mirror it verbatim

## Running things

```bash
# Full nightly run (search + build)
bash scripts/daily-search-and-build.sh

# Build only (pending items in queue)
MODEL=haiku bash scripts/run-batch.sh

# Review dashboard
python3 scripts/serve-apps.py   # → http://localhost:7474

# Queue status
python3 scripts/lib/queue.py applied/_queue/queue.json status
```

## Adding a role manually

```bash
REPO=$(pwd)
QUEUE=$REPO/applied/_queue/queue.json

# Save JD
echo '{"id":"ashby__<uuid>","company":"...","title":"...","ats":"ashby","slug":"...","jobId":"<uuid>","jdUrl":"...","content":{...}}' \
  > $REPO/applied/_queue/jds/ashby__<uuid>.json

# Add to queue
python3 $REPO/scripts/lib/queue.py $QUEUE add --json '{
  "id": "ashby__<uuid>",
  "company": "...", "title": "...",
  "ats": "ashby", "slug": "...", "jobId": "<uuid>",
  "jdUrl": "...", "jdPath": "'$REPO'/applied/_queue/jds/ashby__<uuid>.json",
  "master": "PM", "roleType": "PM", "tier": 2,
  "fitScore": 80, "fitNote": "...", "folderName": "...",
  "date": "'$(date +%Y-%m-%d)'", "status": "pending"
}'

# Build
MODEL=haiku bash scripts/run-batch.sh
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MODEL` | `haiku` | Claude model for builds (`haiku` or `sonnet`) |
| `REPO` | auto-detected | Repo root path |
| `QUEUE` | `$REPO/applied/_queue/queue.json` | Queue file path |

## Rate limits

The batch supervisor writes `.paused-until` (a Unix timestamp) when it hits a rate limit and exits 75. Re-run after the timestamp passes — it will resume automatically. Delete the file to force-resume early.

## Tests

```bash
bash scripts/run-tests.sh
```

## What NOT to do

- Never commit files to `private/`, `applied/`, or `master-resumes/*.docx`
- Never auto-submit applications — the pipeline stops at built PDFs
- Never add new bullet text to `verbatim2.js` without the user's explicit approval — all bullets are verified claims
- Never infer expertise from a question the user asks; only from explicit evidence in `projects.md`
