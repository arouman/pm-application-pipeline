# Job Application Pipeline — Starter Kit

An AI-assisted pipeline that produces tailored, fully-packaged job applications — resume, cover letter, and ATS-safe PDFs — ready for you to review and submit. Claude Code does the building; you always click submit. Nothing is ever auto-submitted.

**First time here? Open [GET-STARTED.md](./GET-STARTED.md)** — it has a copy-paste prompt that lets Claude Code set everything up with you. Prefer to do it by hand? See [SETUP.md](./SETUP.md).

---

## Repo Map

```
applications/
├── master-resumes/         # Your two base resumes (PM track + Design track)
├── cover-letter-template/  # Branded .docx cover letter shell
├── cover-letter-examples/  # Reference letters you've written — voice calibration only
├── Target_Companies.md     # Your ranked target list (Tiers 1–4 + avoid)
├── keyword-bank/           # Persistent skill-term bank (pending / confirmed / rejected)
├── scripts/                # PDF converter, keyword-review server, watcher helpers
├── typeface/Source_Sans_3/ # Variable font — install once, do not install static weights
├── bridge/                 # Local Node server powering the queue UI (http://localhost:8787)
├── applied/                # OUTPUTS — one subfolder per company per day
├── private/                # Contact + EEO data — gitignored, form-fill only
└── starter-kit/            # This kit (setup docs + templates)
```

---

## How it works in one sentence

You paste or link a job description → the pipeline trap-scans it, gates on fit, measures keyword coverage against your master resume, and — if coverage is >= 90% — builds a tailored resume, cover letter, and PDFs into `applied/YYYY-MM-DD/Company/`. You open the files, confirm they look right, and submit.

---

## Entry point

Read **[SETUP.md](./SETUP.md)** from top to bottom before running anything. The dossier-building step is the most important — without it, the system has no verified facts to draw from.
