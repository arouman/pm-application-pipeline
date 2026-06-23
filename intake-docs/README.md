# intake-docs/

Drop your existing career documents here before running the dossier intake. This is optional — but if you have a resume, a LinkedIn export, or any project write-ups handy, the agent will read them first and use them to get up to speed on your background. That turns a 60–90 minute blank-slate interview into a faster confirmation session: the agent presents what it found, and you confirm or correct it.

---

## What to drop in here

| Document | Format | Why it helps |
|---|---|---|
| Current resume(s) | `.docx` or `.pdf` | Roles, titles, dates, metrics, skills — the agent's starting point |
| Cover letters | `.docx`, `.pdf`, `.md`, or `.txt` | Additional project context and voice examples |
| LinkedIn "Save to PDF" export | `.pdf` | Role history, education, endorsements, about section |
| Project or portfolio write-ups | `.md`, `.txt`, `.docx`, or `.pdf` | Richer project detail than a resume bullet can hold |
| Performance reviews or promotion packets | `.md`, `.txt`, `.docx`, or `.pdf` | Manager-observed outcomes; often contain metrics you've forgotten |
| Brag doc | `.md` or `.txt` | Accomplishments you've been tracking informally |

Any combination works. You don't need all of these — even a single resume gives the agent something to work from.

---

## What the agent does with these files

It reads every file in this folder before asking you a single question. From the documents it builds a draft of your dossier — roles, projects, metrics, skills, education, links. Then it runs the intake interview in **confirmation mode**: presenting each item it found and asking whether you can defend it in a real interview before logging it as verified.

Nothing extracted from your documents is trusted on its own. Resumes can overstate, use aspirational framing, or carry metrics you no longer remember the source for. The agent will catch those patterns and ask about them. Only claims you confirm — with enough detail to hold up under interviewer scrutiny — make it into your verified dossier.

---

## Privacy

The contents of this folder stay on your machine. They are gitignored and will never be committed to version control. They are used only to brief the agent at the start of your intake session.

---

## If you skip this folder

That's fine. If intake-docs/ is empty, the agent runs the full from-scratch interview. It takes a bit longer, but the output is identical.
