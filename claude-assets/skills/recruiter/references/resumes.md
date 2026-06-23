# Resume Tailoring

The resume plays a different game than every other artifact: it must pass an ATS *and* win a 6-second human scan. In 2026 the large majority of design/PM resumes are screened through ATS (Workday, Taleo, Lever, Greenhouse, Ashby) — and LinkedIn/recruiter AI search increasingly ranks on semantic relevance — before a human opens the portfolio. Get past the gate without lying to do it.

## The anti-embellishment firewall (run every time — non-negotiable)

1. **The clean master is the single source of truth.** Always tailor *from the master*, never from a previously tailored copy — that's how swaps compound into drift. Reset to master every time. (PM postings → PM master; software-design → Software-Design master; physical-design → Physical-Design master or re-weighted Design master. See `domains.md`.)
2. **Extract from the JD.** Pull emphasized keywords, tools, methods, exact terminology, **and the role's problem space** (industry, product type, user, seniority).
3. **Select & order the projects/roles for THIS posting — do not ship the master's default set.** `projects.md` is a deep bench, not a fixed list. Curate, don't dump: pick the few most relevant entries for the role's *domain AND problem space*, make the single best-fit entry the **hero**, and bench the rest. This is a distinct step from keyword swapping and applies to **both masters** (PM and Design). See **Project selection** below. Show the applicant the proposed project lineup as part of the step-6 approval.
4. **Sort every term into three buckets** (matching against `competencies.md`, the allow-list, and `projects.md` for evidence):
   - **Already present**, same wording → no change.
   - **Present but phrased differently**, where the JD's word is a clear 1:1 synonym for what the applicant actually did → **swap** (e.g., "user research" → "UX research," "go-to-market" → "GTM," "journey map" → "customer journey map"). ⚠️ "1:1" is strict: only true vocabulary equivalents for the *same activity*. Anything that shifts the **scope or seniority** of the claim ("user research" → "user testing," "design" → "product strategy") drops to bucket three.
   - **Absent from the bank** → split, never silently drop and never silently add:
     - **3a — Unconfirmed (plausibly true, just not logged yet):** ASK the applicant — "JD wants X; it's not in `competencies.md`. Do you have an example?" If they confirm with a real instance, add it to `competencies.md` (domain tag + honest proficiency + evidence anchor) as a deliberate verified act, then treat as present/swappable. If they can't source it, → 3b.
     - **3b — Genuinely absent (not true / no example):** flag it, insert nothing. The applicant decides applicability. Never invent a line to house an orphan keyword.
   - ⚠️ `(learning)`-tagged skills are never auto-swapped, regardless of bucket. A missing skill is "unconfirmed," not "false" — the asking step is the safeguard in both directions.
5. **Set the top title to the JD's exact title.**
6. **Show the full swap list AND the project lineup before finalizing** — *your term → their term* with the line each appears in, plus which projects are in/out/hero — for the applicant's approval. This review step is the firewall; nothing ships unapproved.
7. **Export as** `<NAME_SLUG>_Resume_[Job-Title]_[Company].docx`.

## Project selection (curate the bench per JD — firewall step 3)

`projects.md` holds a full bench of entries; a resume shows a curated subset. **Selecting and ordering projects is a first-class tailoring move, not an afterthought — run it every time, for both the PM and the Design master.** The other failure mode (shipping the master's default lineup unchanged) is as damaging as a missing keyword: it buries the evidence that wins *this* role.

How to curate:
1. **Filter by domain tag.** Use the `[PM]`/`[SW]`/`[PH]` tags in `projects.md`. PM postings pull the `[PM]`-weighted evidence. Design postings pull `[SW]`/`[PH]` by sub-domain.
2. **Then filter by problem space**, not just domain. Match the JD's industry/product/user. Each entry's `ATS keywords` and `Accuracy notes` flag its best-fit audiences — use them.
3. **Pick a hero** — the single most on-point entry — and lead with it. Suggested heroes by audience (confirm against the JD):
   - Wearables / hardware-software → hardware hero project, cross-platform wallet project
   - Outdoor / materials / sustainability → bio-inspired project, materials-focused work
   - Service design / AI experience → service-design project, AI experience work
   - AI-native / tech-adjacent (any domain) → the shipped AI products + orchestration system
   - PM / strategy → enterprise-scale project (CFO-presented), award-winning concept, 0→1 venture, large-org project, market analysis
   - Research-heavy → large-scale quantitative study, mixed-methods project, Van Westendorp/USE/NPS project
4. **Pick the right bullet variant.** Entries carry domain-tagged bullet variants (`[PM]`/`[SW]`/`[PH]`) — surface the variant that matches the posting, not whichever ran last time.
5. **Bench the rest.** Cut or compress entries that don't serve this role. Reverse-chron still governs the Experience section; the **Selected Projects** section is where curation has the most freedom — fill it with 2–4 strong, on-target entries (it has historically been left underweight with a single entry; with a deep bench, that's no longer necessary).
6. Re-confirm every pulled metric against `projects.md` (never recall), and carry that entry's ⚠️ flags into the wording.



- Use the **XYZ formula** (Google's): *"Accomplished [X] as measured by [Y] by doing [Z]."* Lead with outcome + metric, then method.
- **If a bullet has no defensible metric, it probably shouldn't be on the resume.** Reframe or cut.
- **Frontload the outcome** — result/metric before the em-dash, method after (Y before Z). A number on as many lines as the facts honestly support.
- Translate product/design metrics into **business terms** — revenue, retention, cost avoidance, population reached — where defensible.
- Lead each bullet with a strong verb: Led, Architected, Shipped, Drove, Designed, Built, Negotiated.
- Reverse-chronological always.

## Tailoring — mirror the posting (opposite of the cover-letter rule)

- On the resume, **do** mirror the JD's exact tool names, methodologies, KPIs, and terminology for ATS — but only where the applicant genuinely has the experience. Never keyword-stuff disconnected terms.
- Reorder skills and re-weight bullets per posting. Surface the few most relevant accomplishments; suppress the rest.

## Per-domain weighting (see `domains.md` for evidence priority)

- **Domain 1 — PM/Business:** ~40% discovery / 40% delivery outcomes / 20% leadership. Name the PM type in the first five seconds. Name pod size, duration, the specific trade-off navigated, and the outcome — not "collaborated with eng and design." Foreground business scale + AI product sense.
- **Domain 2 — Software Design:** lead UX/UI, research, prototyping, end-to-end ownership; foreground design systems when scale/consistency is named; accessibility when required. The tooling / "Design & Research" line **leads with Figma + design systems/tokens** (the tools the hiring manager uses daily) — never let a designer's stack read as all Swift/Kotlin with Figma buried or missing.
- **Domain 3 — Physical Design:** lead the MID credential, the hardware hero project (prototype volume + human-factors outcomes), the ergonomic study (anthropometrics + population impact); foreground CMF/DFM/tools when named.
- **AI roles (any domain):** signal technical fluency (architecture, evals, shipped products), explicitly **not** engineering execution.

## Required resume anatomy (built into the masters — keep every time)

- **Top title = the JD's exact title** (firewall step 4). Headline under the applicant's name matches the posting.
- **Optional credential subhead on the title line.** The title line can carry a quiet pipe-delimited credential subhead for a fast seniority signal — e.g., `Senior Product Designer  |  Master of Industrial Design  |  MBA`. It rides the *same line* as the title (gray, slightly smaller than the title), so it costs **zero vertical space**. Order the degrees by track relevance: **design leads with Master of Industrial Design, then MBA; PM leads with MBA, then MID.** Keep it to the two degree names (GPA / school detail stays in Education + the summary). On a portfolio-gated design resume this is a light touch, not a heavy credential bar; on the title-gated PM master it does more work.
- **Figma placement (design resumes).** Figma is NOT added to every product `Stack` line — a product stack lists what that product is built *on*, and a design tool repeated five times is a category mismatch that dilutes the signal. Figma **leads the Design & Research tooling line**, and appears in a product `Stack` only where it was genuinely the platform/deliverable (e.g., a design-systems plugin).
- **Core Competencies bar** under the summary: one pipe-delimited line of ~8 scannable, track-weighted keyword phrases. ATS keywords + instant human positioning, placed high.
- **Summary:** crisp role headline matched to the posting; 3–4 lines, one hard metric, 3–5 priority keywords. Make it *ownable* — the thing only this applicant can say. Never a summary 100 other senior candidates could submit.
- **Context tags on every role:** `Title | Domain · Scale · Marker | Dates` (e.g., "Enterprise Finance · Global Shared Services"; "YC-backed Consumer Hardware Services"). One glance = what it was and how big.
- **Shipped products lead for AI-native / tech-adjacent roles** (otherwise lead with the JD-matched hero from *Project selection*), framed AI-native where true, each with a `Stack:` line of named tools. Carry all ⚠️ accuracy flags from `projects.md` into the wording.
- **Dedicated "AI & Technical Tooling" section** (mandatory): AI & agents (Claude Code, MCP dev, orchestration systems, model-aware routing, AI experience design), then build stack, integrations/infra, product/design tools.
- **Maximize *truthful* AI keyword density** — tie the applicant to AI wherever the work genuinely is AI. Never stuff AI onto work that isn't.
- **Stack-line curation:** consolidate repeated platform tokens (e.g., "Swift 6, SwiftUI, SwiftData" → "Swift/SwiftUI"; "Kotlin, Jetpack Compose" → "Kotlin/Jetpack Compose") so the one-line budget surfaces *distinctive* tech — user-facing capabilities (computer vision, geofencing) and notable infra — instead of redundant framework names. Only list Figma in a product's `Stack` line if Figma was a genuine design deliverable for that product; don't bolt it onto code-built products. (Figma's prominence for design roles lives in the Design & Research tooling line — see Per-domain weighting.)
- **No line-of-code bragging** — fluency via stacks and shipped surfaces, not authorship claims.
- **Certifications** — include any relevant certifications in the Education section (e.g., a recent AI, cloud, or domain-specific cert); weave the highest-value certification keyword into the summary so it lands high for recruiter search.
- **Compress old/less-relevant roles** (collapse pre-relevant roles into tight one-liners or an "Earlier" line) and **never duplicate content** between a highlights section and the body. Target two pages.

## Pagination & typesetting — no orphans, no widows, no split entries

A polished resume never strands a title from its bullets, or a section header from its first entry. Treat each role / venture / project as an **atomic block**.

- **Each entry moves as one block.** The whole entry (title line + every bullet + the `Stack` line) stays on one page. If it can't fit at the bottom of a page, the *entire block* moves to the next page rather than splitting (title on page 1, bullets on page 2 is the failure mode to kill). Implement with `keepNext` on every paragraph of the entry **except its last**, plus `keepLines` on every paragraph so no single paragraph splits mid-way across a page break.
- **Section headers bind down.** Give each section header `keepNext` so it sits with its first entry. A header must never be the last thing on a page with its content overflowing to the next.
- **Widow/orphan control on, globally.** Set `widowControl` on every paragraph — the Word equivalent of CSS `orphans` / `widows` / `text-wrap: pretty`. No single dangling line stranded at the top or bottom of a page.
- **`Stack:` lines fit on ONE line.** A stack that wraps to a second line (usually a 2–3 word orphan) looks unfinished. Keep each to one line: trim the tool list to the most signal-bearing names for the target domain, and/or drop the stack font to ~8pt. Curate, don't dump — the stack is a fluency signal, not an exhaustive inventory. Keep `keepLines` on it so any unavoidable wrap still travels with its entry.

These are *formatting* rules, not content rules: trimming a stack to fit one line is fine (it's illustrative). Never drop a **bullet** or a **metric** to win pagination — re-tighten spacing or wording instead.

## ATS hygiene

Clean single-column layout; standard headings (Summary, Skills, Experience, Projects, Education); no text in headers/footers; no tables/icons/text-boxes that break parsing. Export to DOCX/PDF only after the layout is parse-safe.

## Output

Resume ships as the named `.docx` (firewall step 6). The cover letter ships as plain text (see `cover-letters.md`) — don't conflate the two.
