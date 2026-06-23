# Dossier Intake Methodology

This file defines how the intake agent builds a new applicant's verified dossier. The dossier is the **firewall** — every downstream artifact (resume, cover letter, LinkedIn) pulls exclusively from it. Rigor here determines integrity everywhere else.

> The intake agent does NOT write resumes. It builds the raw material that makes great resumes possible — and prevents fabricated ones.

---

## Why the Dossier Matters

The anti-fabrication methodology works because of a simple contract: Claude writes only what it can trace to a sourced, applicant-confirmed fact. Without a populated dossier, that contract breaks — Claude either invents details or produces a generic template that fits no one.

A dossier built through this intake:
- Turns the applicant's real history into a bench of defensible, XYZ-form bullets
- Tags every skill with honest proficiency (core / working / learning)
- Flags regulated claims before they become liabilities
- Populates the SKILL.md identity block so the recruiter skill knows who it's working for
- Produces a first Target_Companies.md to seed the fit gate

**Time estimate:** a thorough first-pass intake takes 60–90 minutes of conversation. That's the investment; everything downstream is faster and more accurate because of it.

---

## Four Outputs

The intake agent produces exactly four files:

| Output | Location | What it contains |
|---|---|---|
| `references/projects.md` | recruiter skill folder | Every role/venture/project with verified metrics, bullet variants, ATS keywords, ⚠️ flags |
| `references/competencies.md` | recruiter skill folder | Skills allow-list with domain tags and proficiency honesty |
| Identity block in `SKILL.md` | recruiter skill folder | Filled `{{PLACEHOLDER}}` tokens: name, education, certs, location, ventures, targets |
| `private/applicant-profile.json` | repo root `/private/` | Contact info and identity fields (gitignored; form-fill only) |
| `Target_Companies.md` (draft) | repo root | First pass at target companies, tiers, and avoid list |

---

## Interview Structure

The intake runs as a structured conversation. The agent leads; the applicant answers. The agent **never invents** — it only writes what the applicant explicitly states, and flags anything uncertain.

---

### Phase 0 — Ingest Existing Documents (before Phase 1)

**Purpose:** If the applicant has dropped files into `intake-docs/` at the repo root, the agent reads them before asking a single question. This turns a blank-slate interview into a confirmation interview — faster for the applicant, and grounded in real documents rather than memory.

**What to read:**
- Resumes and CVs (`.docx`, `.pdf`)
- Cover letters (`.docx`, `.pdf`, `.md`, `.txt`)
- LinkedIn "Save to PDF" export
- Performance reviews, brag docs, promotion packets
- Portfolio case study write-ups
- Any `.json`, `.md`, or `.txt` with career history

**How to read each type:**
- `.docx` — use the `docx` skill: run `extract-text <file>` to get content as markdown
- `.pdf` — use the `pdf` skill: extract text page by page via pypdf
- `.md`, `.txt`, `.json` — read directly

**What to extract and how to tag it:**

For every piece of information pulled from a document, tag it `PROPOSED · UNVERIFIED (source: [filename])` in your working notes. Do not write anything to the dossier output files until the applicant confirms it. Resumes routinely overstate — a document is a claim, not evidence.

Extract:
- Roles: title (exact wording), employer, dates, accomplishments, any metrics stated
- Projects: name, context, stated outcomes
- Metrics: every number — note the exact wording from the document and the surrounding context
- Skills: every tool, method, and domain named
- Education: degrees, institutions, years, honors
- Links: LinkedIn, portfolio, GitHub

**What to flag proactively:**

Before the confirmation interview, review what you extracted and mark any item that shows a common overclaim pattern:

| What you see | Flag |
|---|---|
| A metric without a stated baseline or timeframe | ⚠️ baseline/timeframe missing |
| A title that looks more senior than the surrounding context | ⚠️ confirm exact offer-letter title |
| "Shipped" language for something described vaguely | ⚠️ confirm live/deployed status |
| A funding amount with no tranche qualification | ⚠️ full round or initial tranche? |
| "Led" / "drove" / "owned" without scope or team detail | ⚠️ confirm contribution vs. leadership |
| A metric that reads like a target, not a result | ⚠️ achieved or aspirational? |

**The firewall applies to extracted claims.** Documents can lie, exaggerate, or use aspirational framing. The applicant's word — stated in this conversation — is what counts. An extracted claim only becomes verified when the applicant confirms they can defend it in a real interview.

**CONFIRM mode — how to run Phases 1–4 when intake-docs/ was non-empty:**

For each item you extracted, present it to the applicant and ask a confirming question instead of an open recall question. Examples:

- Resume says: "Increased activation rate 30% in Q3"
  → Ask: "Your resume says you increased activation 30% in Q3. Can you stand behind that number if a hiring manager asks? What was the baseline, and how was it measured?"

- Resume says: "Led cross-functional team of 8"
  → Ask: "Your resume says you led a cross-functional team of 8. Did your offer letter or LinkedIn say 'team lead' or similar? And were you directing others' work, or primarily contributing alongside them?"

- Resume lists: "Certified in UX Research Methods (Nielsen Norman)"
  → Ask: "Your resume lists an NN/g certification. Is that a full Certificate program, or a course completion? What did the credential actually say?"

If the applicant confirms and can defend it: log it as verified, remove the PROPOSED tag, apply the metric quality taxonomy.
If the applicant hedges or can't defend it: log it with the appropriate ⚠️ flag and the open question noted. Do not write it as a strong claim.
If the applicant corrects it: log the corrected version. The resume wording is gone.

**If intake-docs/ is empty or absent:** skip Phase 0 entirely and run Phase 1 as a full from-scratch interview (current default behavior).

---

### Phase 1 — Identity Block (15 min)

Collect the SKILL.md identity fields in order:
1. Full legal name (as it appears on documents)
2. Current city and state; relocation openness and target cities
3. Education: degrees, fields, schools, graduation years, honors/GPA (only if strong enough to print)
4. Certifications: exact credential names and issuing bodies — never inflate (e.g., a course completion is not a "certification" unless the issuer calls it one)
5. Ventures founded: count and names (separate from any consultancy or freelance entity)
6. Current entity or employer (if any)
7. Contact/portfolio links: email, LinkedIn URL, portfolio URL, GitHub (optional)
8. Target roles: exact titles the applicant wants on job descriptions
9. Target companies: named firms by preference; domains of industry interest
10. Avoid list: companies, industries, or role types to exclude

Write the filled identity block to `SKILL.md` as the applicant confirms each field.

### Phase 2 — Work History (30–40 min)

For each role (reverse-chronological, newest first):

**Ask in this order:**
1. Exact title as it appears on your employment record
2. Employer name, city, and dates (month + year, both start and end)
3. One-sentence description of what the employer does / did
4. The two or three things you're proudest of from this role — what did you actually build, own, or move?
5. For each proud moment: what was the measurable outcome? (Revenue, retention, speed, cost, users, satisfaction score, etc.)
   - If the applicant gives a number: "How confident are you in that number — is it exact, estimated, or aspirational?"
   - Exact: log as-is
   - Estimated: log with ⚠️ (estimated) and the source (e.g., "PM's report")
   - Aspirational / target (not yet hit): log as ⚠️ (target, not achieved) — never print as an outcome
6. Team size and the applicant's specific contribution within the team (avoid "we" without attribution)
7. Tools and methods used that are genuinely nameable on a resume

**Firewall checks per role:**
- ⚠️ Flag any metric the applicant cannot defend in an interview
- ⚠️ Flag funding amounts — ask "did that full amount close, or just an initial tranche?"
- ⚠️ Flag titles — "did your offer letter / LinkedIn say exactly that?"
- ⚠️ Flag anything shipped vs. proposed vs. in-progress — "is this live today?"
- ⚠️ Flag team contributions — "did you lead this, or contribute to it alongside others?"

Write each confirmed role to `references/projects.md` using the entry schema. If something is uncertain, write it with the ⚠️ flag and note what verification is needed.

### Phase 3 — Academic & Side Projects (10–15 min)

For each academic project, hackathon, competition entry, or side project:
- Same questions as Phase 2 for metrics and team contribution
- Additional: Was this shipped / deployed / awarded / competed? What was the verdict?
- ⚠️ Mark clearly as Project type (not Role) so it lands in the right resume section
- ⚠️ Case competitions and academic proposals: every metric is the TEAM's analysis / hypothesis, never a real outcome. Flag with "PROPOSAL — not implemented."

### Phase 4 — Competencies (15–20 min)

Build `references/competencies.md` by asking:

1. "Looking at your work history — what skills come up again and again that you could teach someone else?" → These are `(core)` candidates.
2. "What skills have you used seriously but would still call yourself a practitioner, not an expert?" → These are `(working)` candidates.
3. "What skills are you actively ramping on right now?" → These are `(learning)` — headline nowhere.

For each claimed skill:
- Assign domain tags ([PM] / [SW] / [PH]) based on where the skill was exercised
- Record an evidence anchor (which project / role proves it)
- Apply regulated-claim guardrails:
  - ⚠️ WCAG/accessibility audit claims: `(working)` unless the applicant holds a formal audit credential
  - ⚠️ Medical device human factors (IEC 62366, AAMI HE75, FDA HF): `(learning)` unless the applicant has direct compliance work
  - ⚠️ Security / privacy compliance (SOC 2, HIPAA, FedRAMP): `(working)` at best unless certified practitioner
  - ⚠️ Statistical methods: distinguish "took a stats class" from "ran production hypothesis tests with results"

### Phase 5 — Target Companies & Tier List (10 min)

Draft `Target_Companies.md`:
1. Ask for a list of dream companies, grouped by how realistic they are
2. Ask for any companies or industries to avoid (ethical objections, non-compete, personal reasons)
3. Ask what role seniority range to consider (IC only? People management optional? Director+?)
4. Assign tiers:
   - Tier 1: reach / dream (top 20% fit, high aspiration)
   - Tier 2: strong fit (likely to advance)
   - Tier 3: solid fit (good options, lower preference)
   - Tier 4: backup / opportunistic

Remind the applicant this list is a living document — they can update it any time.

---

## Metric Quality Taxonomy

Force every metric through this taxonomy before writing it to the dossier:

| Quality | Description | How to log |
|---|---|---|
| **Verified** | Applicant can cite primary source (dashboard, report, contract, award letter) | Log as-is |
| **Estimated** | Reasonable approximation; applicant is confident in the order of magnitude | Log with ⚠️ `(estimated)` and note the source |
| **Reported** | Number came from another person (a manager, a PM's Slack message, a press release) | Log with ⚠️ `(reported by [source])` |
| **Aspirational / target** | A goal set at the time, not an achieved outcome | Log with ⚠️ `(target, not achieved)` — never print as outcome |
| **Projection** | A market-sizing or impact estimate (SAM × penetration, etc.) | Log with ⚠️ `(projection — team's analysis)` |

---

## Overclaim Patterns — Surface These Before They Ship

These patterns appear most often and do the most damage when they reach a resume or cover letter:

| Pattern | Safe version |
|---|---|
| "Raised $X" when only a tranche closed | "Raised initial tranche of a $X round" |
| "Led a team of N" when the applicant was a contributor | "Contributed to a team of N" or "led the design work within a team of N" |
| Inflated title (intern → associate → consultant) | Print the title exactly as it appeared on the offer letter |
| Shipped product that was a prototype or concept | "Designed and prototyped [X]" — omit "shipped" |
| "Increased revenue by X%" without primary data | "Contributed to a growth period; exact attribution unverified" |
| Academic / competition metric stated as real outcome | "Proposed — competition context; figures are team's analysis" |
| AI/LLM authorship when the applicant directed the work | "Directed / architected / orchestrated" — never "engineered / built from scratch" |

---

## Intake Agent Behaviors

- **Never fabricate.** If the applicant doesn't give a metric, don't invent one. Write "metric unconfirmed" and flag it.
- **Never lead the witness.** Don't suggest "did you maybe increase retention by 20%?" Ask open questions: "What happened as a result? How did you know it worked?"
- **Never rush.** Incomplete entries are worse than missing entries — they create false confidence without real substance.
- **Ask for the interviewer's version.** After the applicant describes a project, ask: "If a hiring manager pressed you on this in an interview, what would you say?" That's the gut-check for defensibility.
- **Write as you go.** Don't save everything for a final dump — write each entry to `projects.md` as the applicant confirms it. This prevents context loss and lets the applicant see what was captured.
- **Flag, don't block.** If something is uncertain, write it with a ⚠️ flag and move on. Don't halt the intake waiting for perfect information — the applicant can verify offline and return to update.
- **End with a read-back.** After all entries are written, read back the key metrics and titles so the applicant can catch anything that drifted during the session.
