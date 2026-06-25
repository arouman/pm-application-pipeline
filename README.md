# PM Application Pipeline

An AI-assisted job application pipeline. Searches Ashby and Greenhouse nightly, qualifies roles against your background, and builds a tailored resume + cover letter package for each passing role — ready for you to review and submit.

Built on Claude Code + Haiku API. ~$3–5/day to find 25 roles and produce 25 complete application packages.

**You always click submit. Nothing is ever auto-submitted.**

## How it works

1. **Search (nightly, 8:45 PM)** — Claude searches Ashby and Greenhouse for Senior/Staff/Principal PM roles, scores each against your background (fitScore ≥ 70 to pass), saves JDs, and queues passing roles
2. **Build** — one fresh `claude -p` process per queued role reads the JD, selects bullets from your pre-vetted bank, writes a cover letter grounded in your metrics, and produces `.docx` + `.pdf` pairs
3. **Review** — open `python3 scripts/serve-apps.py` → `http://localhost:7474` to browse the day's applications, then apply

## Stack

| Layer | Tool |
|---|---|
| Search + build AI | Claude Code (Sonnet for search, Haiku for builds) |
| Queue | `scripts/lib/queue.py` — disk-backed, flock-safe |
| Resume builder | `scripts/builder5.js` + `scripts/verbatim2.js` (pre-vetted bullets) |
| Doc generation | `docx` npm package + LibreOffice (`.docx` → `.pdf`) |
| Scheduling | CronCreate (Claude Code session) + launchd |
| Review dashboard | `scripts/serve-apps.py` (local, port 7474) |

## Setup

See `SETUP.md`. Short version:

```bash
npm install
cp private/applicant-profile.example.json private/applicant-profile.json
# fill in your name, email, phone, location, website
bash setup.sh
```

Then populate your content — see `CLAUDE.md` for what needs to go where.

## Repo structure

- `scripts/` — all orchestration: batch runner, queue, builder, search prompt, dashboard
- `.claude/agents/` — Claude sub-agents (application-builder, dossier-builder, jd-scout)
- `claude-assets/skills/recruiter/references/` — your career facts (`projects.md`, `competencies.md`)
- `master-resumes/` — your base `.docx` resumes (gitignored by filename)
- `private/` — contact info + EEO data (gitignored)
- `applied/` — generated output (gitignored)
- `CLAUDE.md` — full project context for Claude Code sessions
- `SETUP.md` — first-time setup walkthrough
