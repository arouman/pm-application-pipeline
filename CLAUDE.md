# PM Application Pipeline — Project Context for Claude Code

An automated job application pipeline: nightly search across Ashby + Greenhouse, qualify against candidate background, build tailored resume + cover letter pairs via a headless batch runner.

## Current status

**Live and running.** Nightly cron fires at 8:45 PM, runs `daily-search-and-build.sh`, reports results.

Done:
- Search prompt (`scripts/search-enqueue-prompt.md`) finds 25 qualifying PM roles per run
- Batch runner (`scripts/run-batch.sh`) spawns one `claude -p` per queued role, handles rate limits, watchdog, retries
- Builder pipeline: `verbatim2.js` bullet bank → `build-pair.js` → `builder5.js` → `.docx` + `.pdf`
- Review dashboard: `python3 scripts/serve-apps.py` → `http://localhost:7474`
- All contact info flows from `private/applicant-profile.json` — nothing hardcoded

## Architecture

```
CronCreate (8:45 PM)
  └─ bash scripts/daily-search-and-build.sh
       ├─ [Search]  claude -p scripts/search-enqueue-prompt.md --model sonnet
       │    WebSearch → Ashby/Greenhouse board APIs → qualify 25 roles → queue.json
       └─ [Build]   bash scripts/run-batch.sh MODEL=haiku
            └─ per role: claude -p .claude/agents/application-builder.md
                 reads JD + projects.md + competencies.md
                 → selects bullet indices from verbatim2.js (never rewrites them)
                 → writes 3-para cover letter grounded in verified metrics
                 → node build-pair.js → .docx + .pdf
```

**Key decisions:**
- Each build is a fresh `claude -p` process — no context bleed between roles
- Prompt caching amortizes the 50 KB static reference files (~$0.16/build steady state)
- Claude selects bullets by **index** from `verbatim2.js` — it never invents new bullet text
- Anti-fabrication: every claim must trace to `projects.md` or `competencies.md`

## Key files

| File | What it does |
|------|-------------|
| `scripts/run-batch.sh` | Headless supervisor — flock, 20-min watchdog, rate-limit handler, exponential backoff |
| `scripts/lib/queue.py` | Disk-backed queue (`pending → building → built/error/skip`), atomic flock ops |
| `scripts/daily-search-and-build.sh` | Nightly orchestrator: search then build |
| `scripts/search-enqueue-prompt.md` | Search instructions for Ashby + Greenhouse (Sonnet) |
| `scripts/verbatim2.js` | Pre-vetted resume bullet bank — **fill in your own bullets here** |
| `scripts/builder5.js` | Resume `.docx` builder; reads contact header from `private/applicant-profile.json` |
| `scripts/build-pair.js` | Assembles resume + cover letter from `build-args.json` |
| `scripts/serve-apps.py` | Local review dashboard (port 7474) |
| `.claude/agents/application-builder.md` | Per-role build agent spec |
| `claude-assets/skills/recruiter/references/projects.md` | Canonical career history — verified metrics only |
| `claude-assets/skills/recruiter/references/competencies.md` | Skills allow-list + proficiency tags |

## What needs to be filled in (new users)

1. `private/applicant-profile.json` — copy from `private/applicant-profile.example.json`, add contact info
2. `master-resumes/YourName_Resume_PM_Master.docx` — your base resume
3. `scripts/verbatim2.js` — replace placeholder bullets with your verified accomplishments
4. `claude-assets/skills/recruiter/references/projects.md` — run `help me build my dossier` in Claude Code
5. `claude-assets/skills/recruiter/references/competencies.md` — same dossier intake
6. `scripts/search-enqueue-prompt.md` line 5 — update `REPO=` to your actual path; update fit criteria on line ~54

## Running things

```bash
# Full nightly run
bash scripts/daily-search-and-build.sh

# Build pending items only
MODEL=haiku bash scripts/run-batch.sh

# Queue status
python3 scripts/lib/queue.py applied/_queue/queue.json status

# Review dashboard
python3 scripts/serve-apps.py   # → http://localhost:7474
```

## Rate limits

The batch supervisor writes `.paused-until` (Unix timestamp) and exits 75 when rate-limited. Re-run after the timestamp — or delete the file to force resume.

## Anti-fabrication rules (never violate)

- Only claim experience traceable to `projects.md` or `competencies.md`
- Select bullet **indices** from `verbatim2.js` — never write new bullet text
- `⚠️` flags in `projects.md` mark overclaim guardrails — carry them into every artifact
- Cover letters paraphrase JD language; never mirror it verbatim

## Working with Adam

- Don't touch `private/`, `applied/`, or `master-resumes/*.docx` — gitignored, personal
- Queue skip/reset commands: `python3 scripts/lib/queue.py $QUEUE status <id> skip`
- To rebuild a failed role: reset status to `pending`, re-run batch
- The cron fires `daily-search-and-build.sh` headlessly — don't do the search inline in this session
