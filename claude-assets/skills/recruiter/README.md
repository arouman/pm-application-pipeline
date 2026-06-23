# STOP — READ BEFORE DOING ANYTHING WITH THIS SKILL

**This skill is POPULATED and CANONICAL. Read the inventories. Do NOT rebuild, regenerate, or overwrite them.**

## The single source of truth
- `references/projects.md` — fully-sourced project/role entries (verified metrics, bullet variants, ATS keywords, ⚠️ accuracy flags). This file is COMPLETE.
- `references/competencies.md` — the verified skills allow-list (domain + proficiency tags). This file is COMPLETE.
- `SKILL.md` — identity, positioning, workflow, guardrails, and pointers. Read it first.

These were built once, over a long verification session with the applicant, cross-checked line-by-line against their real source documents. They are not a scaffold and not a draft.

## Hard rules for any session
1. **NEVER overwrite, truncate, blank, or regenerate `projects.md` or `competencies.md`.** They are not to be rebuilt from scratch. If one looks empty or wrong, you are reading a STALE / UN-INSTALLED copy — stop and tell the applicant the file didn't load; do not "helpfully" repopulate it.
2. **READ, don't recall.** Pull every project metric from `projects.md` and every skill from `competencies.md`. Never state a fact from memory.
3. **Edits are surgical and additive.** To add or correct an entry, edit that entry in place and show the applicant the change for approval. Never rewrite the whole file silently.
4. **Any previous project-library document is SUPERSEDED.** Do not look for it, ingest it, or treat it as a source. `projects.md` replaced it.
5. **A skill named in a JD that isn't in `competencies.md` is "unconfirmed," not "false"** — ask the applicant for an example before adding or dropping it (see the protocol note atop `competencies.md`).
6. **The build is DONE.** Do not re-run any "populate the inventory" task. From here it is reads and small edits only.
7. **SKILL.md `description` frontmatter must stay ≤ 1024 characters** (hard platform limit; the skill fails to install if exceeded). If you edit it, re-count before packaging.

## File map
```
recruiter/
  SKILL.md                      ← entry point (identity + guardrails + pointers)
  README.md                     ← this file
  references/
    projects.md                 ← CANONICAL project facts (do not rebuild)
    competencies.md             ← CANONICAL skills allow-list (do not rebuild)
    domains.md                  ← three-domain positioning logic
    resumes.md                  ← resume firewall (3-bucket sort)
    cover-letters.md
    linkedin-profile.md
    linkedin-posts.md
    interviews.md               ← incl. bio-inspired technical Q&A prep
    negotiation.md
```
