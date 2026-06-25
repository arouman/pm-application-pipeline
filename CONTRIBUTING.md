# Contributing

Contributions welcome — bug fixes, new ATS integrations, prompt improvements, and setup tooling are all in scope.

## Before you start

- **Open an issue first** for anything beyond a small bug fix. Alignment on approach before coding saves everyone time.
- Keep changes focused. One PR per concern.

## Setup

```bash
git clone https://github.com/arouman/pm-application-pipeline
cd pm-application-pipeline
npm install
cp private/applicant-profile.example.json private/applicant-profile.json
# fill in private/applicant-profile.json with test values
bash setup.sh
```

You will need:
- Claude Code (`npm install -g @anthropic/claude-code`) with API access
- Node 18+, Python 3.10+, LibreOffice

## Running tests

```bash
bash scripts/run-tests.sh
```

## PR guidelines

- **No personal data.** `private/`, `applied/`, and `master-resumes/*.docx` are gitignored — keep them that way. Never commit PII.
- **Prompt changes need justification.** Changes to `scripts/search-enqueue-prompt.md` or `.claude/agents/application-builder.md` affect every build. Explain what problem you're solving and what you tested.
- **verbatim2.js is personal content, not infrastructure.** Don't add sample bullets — the starter template with placeholders is intentional. Changes to the bullet *format or structure* are welcome; sample content is not.
- **Ponytail principle.** Prefer the simplest solution. No abstractions without a use case, no boilerplate for hypothetical futures.
- Write a clear PR description: what changed, why, how you tested it.

## Good areas to contribute

- Additional ATS integrations (Lever, Workday, Rippling)
- Better fit-scoring heuristics in `search-enqueue-prompt.md`
- Test coverage for `scripts/lib/queue.py` and `scripts/build-pair.js`
- Windows/Linux compatibility (currently Mac-only due to LibreOffice path assumptions)
- A web-based dossier intake UI

## What not to change without discussion

- The anti-fabrication firewall (`projects.md` / `competencies.md` as the single source of truth)
- The "no auto-submit" constraint — the pipeline stops at PDFs; the user always clicks submit
- The fresh-process-per-build architecture in `run-batch.sh`
