# Job Application Pipeline — Starter Kit

An AI-assisted pipeline that **finds, qualifies, and builds tailored job applications automatically** — resume, cover letter, and ATS-safe PDFs — ready for you to review and submit. Claude Code does the sourcing and building; you always click submit. Nothing is ever auto-submitted.

Built on [Claude Code](https://claude.ai/code) + Haiku/Sonnet API. Costs roughly **$3–5/day** in API usage to find 25 roles and produce 25 complete application packages.

---

## What it does

**Every night (automated):**
1. Searches Ashby and Greenhouse job boards for Senior/Staff/Principal PM roles matching your target criteria
2. Qualifies each role against your background (fit score ≥ 70 to proceed)
3. Saves job descriptions and queues the passing roles
4. Builds a tailored resume + cover letter pair for each role — all output lands in `applied/YYYY-MM-DD/`

**Each package contains:**
- `YourName_Resume_Role_Company.docx` + `.pdf`
- `YourName_Cover_Letter_Role_Company.docx` + `.pdf`
- `company_application.md` — fit score, coverage %, gaps, checklist
- `company_field-map.json` — form-fill data (contact info, cover letter text, essay answers)

**You review the dashboard (`python3 scripts/serve-apps.py`) and submit.**

---

## Architecture

```
CronCreate (8:45 PM nightly)
  └─ bash scripts/daily-search-and-build.sh
       ├─ [Search] claude -p search-enqueue-prompt.md --model sonnet
       │    WebSearch → Ashby/Greenhouse board APIs → qualify 25 roles → save JDs → queue.json
       └─ [Build]  bash scripts/run-batch.sh MODEL=haiku
            └─ per role: claude -p .claude/agents/application-builder.md
                 reads JD + projects.md + competencies.md
                 → selects bullets from verbatim2.js (pre-vetted, never rewrites)
                 → writes 3-para cover letter grounded in your metrics
                 → node scripts/build-pair.js → .docx + .pdf
```

**Key design decisions:**
- Each build is a **fresh `claude -p` process** — no context bleed between applications
- Prompt caching amortizes the 50 KB static reference files across all builds (~$0.16/build)
- Claude **never invents bullet points** — it selects and reorders from `verbatim2.js`, your pre-vetted bank
- The anti-fabrication firewall lives in `projects.md` and `competencies.md` — only verified claims enter documents

---

## What you need to provide

This is a starter kit — the infrastructure ships ready to run, but it needs your content. Here's exactly what to fill in before the first run:

### 1. `private/applicant-profile.json` (required)
Your contact info for resume/cover letter headers and application form-fill.

```bash
cp private/applicant-profile.example.json private/applicant-profile.json
# then edit with your name, email, phone, location, website
```

This file is gitignored and stays local. It is the **only** source of your personal contact info in the pipeline — the JS builders read from it directly.

### 2. `master-resumes/YourName_Resume_PM_Master.docx` (required)
Your base resume as a `.docx` file. The pipeline makes a copy per application and tailors it — it never edits the original.

```
master-resumes/
├── YourName_Resume_PM_Master.docx     # for PM / business / strategy roles
└── YourName_Resume_Design_Master.docx # for design / UX roles (optional)
```

### 3. `scripts/verbatim2.js` — your bullet bank (required)
The most important content file. **Claude never writes resume bullets** — it selects and reorders from this pre-vetted bank by index. You write the bullets once; the agent picks the best ones per role.

Structure: one array per employer, each entry is `["bold metric prefix", " — supporting detail"]`.

```js
// Example entry:
["$4M+ MRR migrated", " — designed migration plan across enterprise, SMB, and non-profit segments without churn."]
```

The starter kit ships with placeholder entries. Replace them with your own verified accomplishments. See the comments in `scripts/verbatim2.js` for the format.

### 4. `claude-assets/skills/recruiter/references/projects.md` (required)
Your career history with verified metrics — the agent reads this to ground every claim. Run `help me build my dossier` in Claude Code for a guided intake session that populates this file from your resume and project history.

### 5. `claude-assets/skills/recruiter/references/competencies.md` (required)
Your skills allow-list with proficiency tags (`core`/`working`/`learning`). The agent uses this as a firewall — it will only claim skills listed here. Populated by the dossier intake.

### 6. Search criteria in `scripts/search-enqueue-prompt.md` (customize)
The daily search is tuned for Senior/Staff/Principal PM roles by default. Edit the fit scoring criteria (line 54) to match your background:

```
fitScore ≥ 70 based on: [your target domains — e.g. "enterprise SaaS, AI products, B2B platform, fintech"]
```

Also update `REPO=` on line 5 to your actual repo path.

### 7. `Target_Companies.md` (optional but useful)
A ranked list of companies you want to target. Used by the fit-scoring step to prioritize.

---

## Quick start

```bash
# Prerequisites: Claude Code, Node 18+, Python 3.10+, LibreOffice
# See SETUP.md for full install steps

git clone https://github.com/your-org/applications-starter-kit applications
cd applications
npm install
bash setup.sh

# Populate your content (see "What you need to provide" above)
cp private/applicant-profile.example.json private/applicant-profile.json
# edit private/applicant-profile.json

# Run a manual search + build to verify everything works
bash scripts/daily-search-and-build.sh

# Review results
python3 scripts/serve-apps.py
# opens http://localhost:7474
```

The nightly CronCreate trigger fires at 8:45 PM and runs the full pipeline automatically while you sleep.

---

## Daily review workflow

```bash
python3 scripts/serve-apps.py
```

Opens a local dashboard at `http://localhost:7474` showing each application with:
- Fit score and fit note
- Apply link (direct to ATS)
- Resume PDF + Cover Letter PDF previews
- Application checklist from `_application.md`

Click Apply → attach PDFs → fill form → submit. That's it.

---

## File map

```
applications/
├── .claude/agents/application-builder.md  # Claude agent spec for per-role builds
├── scripts/
│   ├── run-batch.sh                       # Headless supervisor — spawns one claude -p per role
│   ├── daily-search-and-build.sh          # Nightly orchestrator (search → build)
│   ├── search-enqueue-prompt.md           # Search instructions for Ashby + Greenhouse
│   ├── lib/queue.py                       # Disk-backed queue with atomic flock operations
│   ├── verbatim2.js                       # YOUR BULLET BANK — fill this in
│   ├── builder5.js                        # Resume docx builder (reads profile for contact header)
│   ├── build-pair.js                      # Assembles resume + cover letter from build-args.json
│   ├── build-pdfs.sh                      # LibreOffice .docx → .pdf converter
│   ├── tailor-resume.py                   # Applies text swaps to master resume copy
│   └── serve-apps.py                      # Local review dashboard
├── claude-assets/skills/recruiter/
│   └── references/
│       ├── projects.md                    # YOUR CAREER HISTORY — populate via dossier intake
│       ├── competencies.md                # YOUR SKILLS — populate via dossier intake
│       ├── resumes.md                     # Resume tailoring rules
│       ├── cover-letters.md               # Cover letter format rules
│       └── domains.md                     # Domain classification (PM / Design / Physical)
├── master-resumes/                        # YOUR MASTER RESUMES — add your .docx files here
├── cover-letter-template/                 # Branded cover letter shell
├── private/
│   └── applicant-profile.example.json    # Copy → applicant-profile.json and fill in
├── applied/                               # OUTPUT — gitignored; one folder per day
│   └── _queue/
│       ├── queue.json                     # Application state machine
│       └── jds/                           # Saved job descriptions
└── Target_Companies.md                   # Your ranked company targets
```

---

## Safety

- **No auto-submit.** The pipeline stops at built PDFs. You submit.
- **No fabrication.** Claude can only reference claims in `projects.md` and competencies in `competencies.md`. It selects bullets from `verbatim2.js` by index — it cannot invent new text.
- **No PII in the repo.** `private/` is gitignored. Your contact info never touches git history.
- **JD trap-scan.** The agent scans each job description for prompt-injection before processing.

---

## Full setup guide

See **[SETUP.md](./SETUP.md)** for prerequisite installation, dossier intake walkthrough, and launchd configuration.
