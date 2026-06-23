# Get Started

This is an AI-assisted job-application pipeline: it finds roles, scores fit, and
builds a tailored resume + cover letter for each one — for you to review and submit.
The fastest way to set it up is to let **Claude Code** drive it.

---

## Fastest path (recommended) — let Claude set it up

1. **Install the prerequisites** (details in `SETUP.md` → *Prerequisites*):
   Claude Code, **Python 3.10+**, Node 18+, LibreOffice, and the Source Sans 3 font.
2. **Open this folder in Claude Code.**
3. **Paste this prompt:**

> I just downloaded this job-application pipeline. Read `README.md` and `SETUP.md`
> in this folder, then set it up with me step by step:
> 1. Check my prerequisites are installed and tell me how to fix anything missing.
> 2. Run `bash setup.sh` and walk me through its prompts.
> 3. Help me build my dossier — I may drop resumes / cover letters / a LinkedIn PDF
>    export into `intake-docs/` first; otherwise just interview me.
> 4. Help me add my two master resumes to `master-resumes/` and set up my target
>    companies.
> 5. Then explain how I review the queue and produce/submit applications day to day.
>
> Ask me questions whenever you need to. Do **not** fabricate anything about my
> background — only use facts I confirm.

4. **Follow along.** Claude checks your setup, builds your dossier from your answers
   (and any documents you dropped in `intake-docs/`), and gets you to your first
   tailored application.

---

## Want to change how it works?

Just ask Claude in this folder — for example:

- "Add Workday support to the scraper."
- "Make the cover-letter tone warmer / more formal."
- "Add these five companies to my targets."
- "Why didn't this role get scored above 90%?"
- "Change the resume to lead with my design work."

The whole pipeline is local and yours to tweak.

---

## Prefer to do it by hand?

`SETUP.md` has every step without the assistant.

---

## The one rule

Claude **builds and tailors**; **you always review and click submit.** It never
submits anything for you.
