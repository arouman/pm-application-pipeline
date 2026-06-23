# Automation layer — queue, supervisor, intake, watcher, autofill

Five systems that turn "Rob runs each application by hand" into "wake up to a
staged queue — with the best roles already built." Built 2026-06-11.

```
 watch-jobs.py ─────► (new postings only)
   (ATS polling)             │
   every 10 min              ▼ fitScore ≥ 90%
                        queue.json ──► application-builder (1 subagent / app) ──► applied/DATE/Company/
  discovery scouts ──►  (on disk)        reads /recruiter, tailors,                resume+cover (docx+pdf)
    (bridge UI)              ▲             writes files; never submits              application.md
                             │                                                      field-map.json
             run-batch.sh (supervisor) spawns one `claude -p` per pending item,
             self-heals across rate-limit windows via .paused-until + launchd
```

## 0. The watcher (`scripts/watch-jobs.py`)

Polls all 23 verified ATS boards every 10 minutes, detects brand-new postings
within minutes of going live, scores each with a headless Claude call, and
auto-triggers a build for roles ≥90% fit. **North star: Rob in the first ~10 applicants.**

### How it works

1. **Fetch** — pulls the full job list for every company in `bridge/targets.json`
   (Greenhouse / Ashby / Lever APIs, mirroring `bridge/server.js` patterns).
2. **Compare** — checks against `applied/_queue/seen-jobs.json`. Anything not in
   that file is a "new posting."
3. **First-run seeding** — the very first pass only records all current jobs into
   `seen-jobs.json` and exits without scoring. This prevents scoring thousands of
   stale postings. The script prints how many were seeded.
4. **Pre-filter (cheap, no AI tokens):**
   - Title must match role keywords (product manager, product designer, UX, design
     lead, etc. — same list as `bridge/server.js TITLE_KEYWORDS`).
   - Location must be US-remote or a target metro (SF, NYC, Seattle, Austin,
     Denver/Boulder, plus adjacent locations). Ambiguous/empty → keep.
   - Ledger dedup check (`scripts/lib/ledger.py`) — skip if already applied/queued
     within 183 days.
5. **Full JD fetch** — Greenhouse: `?content=true` per-job endpoint. Ashby/Lever:
   description already in the board listing. Raw JSON saved to
   `applied/_queue/jds/<ats>-<jobId>.json` as UNTRUSTED data (never executed).
6. **Fit scoring** — one `claude -p --model claude-sonnet-4-5 --output-format json`
   call per surviving job. The prompt embeds the CLAUDE.md coverage formula and
   paths to the `/recruiter` dossier files. Returns structured JSON:
   `{fitScore, roleType, master, fitNote, trap}`.
7. **Decision gate:**
   - `trap != null` → log loudly + notify Rob; do NOT build.
   - `fitScore ≥ 90%` → enqueue via `queue.py`, add ledger entry, spawn
     `run-batch.sh` (detached, lockfile-guarded against double-spawn), notify Rob.
   - `70–89%` (near-miss) → notify Rob, log to `watch-log.md`; do NOT enqueue.
   - `< 70%` → log silently.
8. **Pause-aware** — if `applied/_queue/.paused-until` is in the future (rate-limit
   backoff from `run-batch.sh`), scoring is deferred but `seen-jobs.json` is still
   updated so nothing is lost.
9. **Notifications** — `osascript` macOS notification for every auto-build trigger
   and every 70–89% near-miss (sound: "Glass"). All events appended to
   `applied/_queue/watch-log.md` (timestamped markdown table).

### Usage

```bash
# Single pass (same as launchd runs it)
python3 scripts/watch-jobs.py --once

# Long-running loop (stays resident)
python3 scripts/watch-jobs.py --loop --interval 600

# Test mode — log decisions but skip queue writes + batch spawn
WATCH_NO_BUILD=1 python3 scripts/watch-jobs.py --once

# Verbose debug output
WATCH_LOG_LEVEL=DEBUG python3 scripts/watch-jobs.py --once
```

### State files

| File | Purpose |
|---|---|
| `applied/_queue/seen-jobs.json` | `{"<ats>:<jobId>": {firstSeen, title, company}}` — the dedup set |
| `applied/_queue/watch-log.md` | Timestamped table of every detection event |
| `applied/_queue/watch-batch.log` | stdout/err from detached `run-batch.sh` spawns |
| `applied/_queue/.watch-batch.lock` | flock lockfile preventing double-spawn |
| `applied/_queue/watch-launchd.log` | launchd stdout/err redirect |

### Tuning

- **Add companies:** add a verified entry to `bridge/targets.json` (see section 1
  of `bridge/README.md`). Delete `seen-jobs.json` to re-seed, or the new company's
  jobs will trickle in naturally on the next pass.
- **Title keywords:** edit `TITLE_KEYWORDS` at the top of `watch-jobs.py`.
- **Poll interval:** change `StartInterval` in the plist (default 600 s / 10 min).
- **Score threshold:** the 90% gate is the CLAUDE.md firewall — changing it here
  would bypass the downstream builder's own gate. Raise or lower `fitScore < 90`
  check in `_run_pass()` if you want a different near-miss window.

### launchd activation (Rob's deliberate step)

```bash
cp scripts/com.robstout.applications.watch.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.robstout.applications.watch.plist
```

To stop:
```bash
launchctl unload ~/Library/LaunchAgents/com.robstout.applications.watch.plist
```

To check whether it's running:
```bash
launchctl list | grep watch
```

The plist runs `--once` every 600 seconds and redirects stdout + stderr to
`applied/_queue/watch-launchd.log`. `RunAtLoad` is `false` — the first tick fires
after 600 s. If you want an immediate first run, trigger it manually with
`python3 scripts/watch-jobs.py --once` first.

---

## 1. The queue (`applied/_queue/queue.json`)

Single source of truth for "what's left to build." Each item is one role.
`status`: `pending → building → built | error | skipped`. Because all state is on
disk, context can be cleared/restarted between batches with nothing lost —
**resume = next pending item.** Helper: `scripts/lib/queue.py` (atomic, flock-guarded).

```bash
python3 scripts/lib/queue.py applied/_queue/queue.json status      # counts
python3 scripts/lib/queue.py applied/_queue/queue.json list pending
python3 scripts/lib/queue.py applied/_queue/queue.json reset-building   # recover after a crash
```

## 2. The supervisor (`scripts/run-batch.sh`)

Builds every pending item by spawning a **fresh `claude -p` per application**
(bounded context — nothing accumulates). On a usage/rate limit it writes a resume
time to `applied/_queue/.paused-until` and exits 75; the launchd job re-runs it
every 30 min and it no-ops until the window reopens, then resumes. "Finish what
you're on, then stop" is automatic — each item writes `built` before the next.

```bash
MODEL=sonnet bash scripts/run-batch.sh --recover          # build all pending
bash scripts/run-batch.sh --max 3                         # just 3
bash scripts/run-batch.sh --dry-run                       # print plan, build nothing
```

**Unattended scheduling (Rob's deliberate step — it registers a recurring job):**
```bash
cp scripts/com.robstout.applications.batch.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.robstout.applications.batch.plist
# stop:  launchctl unload ~/Library/LaunchAgents/com.robstout.applications.batch.plist
```
Note: `run-batch.sh` passes `--dangerously-skip-permissions` to `claude -p` (a
headless run can't answer permission prompts). Override with `CLAUDE_FLAGS=...`.
This is the standard headless pattern for a trusted, self-owned automation —
review before scaling. Tonight's 20 were built by **in-session subagents** (which
Claude monitors directly); the supervisor is the productionized path for future
unattended nights and is dry-run-tested.

## 3. Intake UI + 6-month dedup ledger

### The engine is always-on — just bookmark it

**Bookmark: http://127.0.0.1:8787**

The bridge server runs automatically at login via launchd — no terminal needed.
Every control (staging Chrome, staging applications, watcher on/off) is a button on that page.

Install once (already done if you ran the setup):
```bash
cp bridge/com.robstout.applications.bridge.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.robstout.applications.bridge.plist
```

If you ever need to restart it manually:
```bash
launchctl kickstart -k gui/$(id -u)/com.robstout.applications.bridge
# or
node bridge/server.js    # fallback — port 8787, Ctrl-C to stop
```

The bridge serves the intake UI at `GET /` and exposes the full API.

### What the UI does

**Top pane — Add to pipeline.** Paste one or more job URLs (one per line) and
click "Add to pipeline." Each URL is processed in sequence:

- Greenhouse, Ashby, and Lever URLs are resolved via the public ATS API — the
  JD JSON is fetched and saved to `applied/_queue/jds/`. Non-ATS URLs fall back
  to raw HTML.
- The URL is dedup-checked against `applied/applied-ledger.json` (6-month window).
  - Duplicate → shown with the prior date; not enqueued.
  - New → enqueued as `pending`; `run-batch.sh` is spawned (detached, guarded
    against double-spawn via a pid-lockfile at `applied/_queue/.bridge-batch-running`).
- Result shown inline: green checkmark / yellow warning / red error.

**Middle pane — Queue.** Live table of `queue.json` items (polls every 5 s).

**Bottom pane — Ledger.** All ledger entries sorted by status. Each `built` row
has a "Mark submitted" button → `POST /ledger/mark`.

### Ledger CLI (`scripts/lib/ledger.py`)

Flock-safe, stdlib-only. Same pattern as `queue.py`.

```bash
LEDGER=applied/applied-ledger.json

# Dedup check (exits 0; duplicate=true if entry seen within 183 days)
python3 scripts/lib/ledger.py $LEDGER check "greenhouse:5127559008"

# Add / upsert an entry
python3 scripts/lib/ledger.py $LEDGER add --json '{"key":"greenhouse:123","company":"Acme","title":"PM",...}'

# Mark submitted (sets appliedDate to today if --date not given)
python3 scripts/lib/ledger.py $LEDGER mark "greenhouse:123" --status submitted

# List all, or filter by status
python3 scripts/lib/ledger.py $LEDGER list
python3 scripts/lib/ledger.py $LEDGER list --status submitted
```

### Dedup key rules

| Situation | Key format |
|---|---|
| ATS and jobId both known | `{ats}:{jobId}` (e.g. `greenhouse:5127559008`) |
| Unknown ATS or jobId | `norm(company)\|norm(title)` (e.g. `figma\|product-designer`) |

`norm` = lowercase, strip punctuation (keep hyphens), collapse whitespace to
single hyphen.

**Duplicate window:** 183 days from the earlier of `firstSeen` / `appliedDate`.

### Ledger seed

The ledger is pre-seeded with:
- 20 `built` items from the 2026-06-11 overnight batch (from `queue.json`)
- 2 `submitted` entries added manually: Figma "Product Designer" and Oura
  "Senior Product Designer" (both applied 2026-06-10)

### Ledger / queue sync

`GET /queue` calls `reconcileQueueToLedger()` before returning. Any queue item
with `status=built` that lacks a matching ledger entry (or is still at `queued`)
gets upserted to `built`. This keeps the ledger current without requiring
`run-batch.sh` to call back to the bridge.

### Pass button + fit-feedback loop

Every queue/ledger row on the engine page has a **Pass** button. Clicking it
prompts for a reason ("why doesn't this fit?") and POSTs to `/pass`, which:

1. Appends `{date, key, company, title, jdUrl, reason}` to
   `applied/_queue/fit-feedback.json` — **the training signal**.
2. Marks a pending queue item `skipped` (it never builds).
3. Marks the ledger entry `passed` (it can't resurface inside the dedup window).

The watcher's fit-scorer (`watch-jobs.py::_load_pass_feedback`) injects the
most recent 30 reasons into the scoring prompt as explicit NEGATIVE criteria,
so similar roles score lower over time. A reason is mandatory — a bare pass
teaches nothing. Job titles in both tables hot-link to the posting
(queue → `jdUrl`, ledger → `applyUrl`).

## 3.5 Funding discovery (`scripts/discover-funding.py`)

Feeds the watcher with fresh, lesser-known companies so Rob competes against a
handful of applicants at a just-funded startup instead of hundreds at a big name.

**Source:** the monthly HN "Ask HN: Who is hiring?" thread via the zero-auth
Algolia API (`hn.algolia.com/api/v1`). Founder-posted, mostly small companies.

**Flow:** thread → top-level comments → regex out Greenhouse/Lever/Ashby apply
URLs → derive `{ats, slug}` → validate each board resolves → dedupe vs
`bridge/targets.json` → append new ones (`source: "hn-whoishiring"`, `tier: 3`) →
**seed each new company's current jobs into `seen-jobs.json`** so the watcher only
ever alerts on posts made *after* discovery (true early-applicant timing, no
backlog scoring storm).

```bash
python3 scripts/discover-funding.py --dry-run      # preview
python3 scripts/discover-funding.py --max 60       # add (live)
python3 scripts/discover-funding.py --month 2026-05 # a specific month's thread
```

Or click **Discover fresh companies** on the engine page (`POST /control/discover`).
First run (June 2026 thread) added 56 companies and seeded 2,805 backlog jobs.
The watcher must be ON for the new targets to be polled.

## 4. Browser autofill (`extension/autofill.js` + `scripts/make-autofill.py`)

**Panel rendering:** the floating summary panel uses a Shadow DOM root so the
host page's CSS (Greenhouse, Ashby, Workday, etc.) cannot bleed in and produce
garbled overlapping text. All styles are scoped inside the shadow root.

Kills the dropdown pain. The builder writes a `field-map.json` per application;
`make-autofill.py` bundles it with the engine into a paste-ready snippet.

```bash
python3 scripts/make-autofill.py --all applied/2026-06-11    # one snippet per folder
```

On a job application page, open DevTools console, paste the contents of that
folder's `autofill-snippet.js`, Enter. It:
- fills name / email / phone / LinkedIn / website / location and the cover-letter
  + "why" textareas — using the **native-setter + real input/change events** so
  React-controlled ATS inputs (Greenhouse, Lever, Ashby, Workday) actually commit
  the value (the reason naive `.value=` and the MCP fills silently failed);
- **outlines every dropdown / radio / file-input in orange** and lists them in a
  floating panel — the controls only Rob can finish — then reminds which PDFs to
  attach. It never picks dropdowns and never submits.

First paste per Chrome session may require typing `allow pasting` once in the
console (Self-XSS guard). A Tampermonkey userscript wrapping `autofill.js` is the
zero-paste alternative if Rob prefers.

---

## 4. Application staging (`scripts/stage-apps.js`)

One command opens each form in Chrome, attaches the PDFs, and fills all text
fields — leaving only dropdowns, EEO questions, and the submit button for Rob.

### Dedicated "Job Applications" Chrome window — port 9223

The staging browser is a **separate Chrome instance** from any other automation
or development session you may be running:

| Instance | Port | Profile dir | Purpose |
|---|---|---|---|
| Job Applications (purple) | **9223** | `~/.chrome-apply-profile` | Staging applications — this is what `chrome-debug.sh` launches |
| Other automation | 9222 | `~/chrome-mcp-debug` | Unrelated projects (Leonardo.Ai, extension dev, etc.) — untouched by this pipeline |

The purple window is themed with `--install-autogenerated-theme=124,77,255` so
it is visually unmistakeable at a glance.

**First run only:** the `~/.chrome-apply-profile` directory is fresh (empty).
You must log into job-application sites once in the purple window — LinkedIn,
Greenhouse, Ashby, Lever, Workday — and those sessions will persist automatically.
You do not need to do this for the 9222 instance; it is completely separate.

### 3-step flow

```
Step 1 — launch the dedicated Job Applications Chrome (once per session)
  bash scripts/chrome-debug.sh
  (look for the PURPLE window — port 9223, profile ~/.chrome-apply-profile)

Step 2 — stage all applications for a date
  node scripts/stage-apps.js /abs/path/to/applied/YYYY-MM-DD

Step 3 — Rob opens each tab in the purple window, finishes dropdowns/EEO, clicks submit
```

### Options

```bash
# Preview what would happen — no tabs opened, nothing touched
node scripts/stage-apps.js applied/2026-06-11 --dry-run

# One specific folder only
node scripts/stage-apps.js applied/2026-06-11 --only Decagon

# Cap how many tabs open at once
node scripts/stage-apps.js applied/2026-06-11 --max 5

# Re-type fields on ALREADY-OPEN tabs (without reopening or re-attaching files)
node scripts/stage-apps.js applied/2026-06-11 --refill
```

### Why real keystrokes (not JS events)

The staging tool types field values via the Chrome DevTools Protocol
`Input.insertText` command rather than injecting JavaScript that sets `.value`
and dispatches synthetic events. The distinction matters for Ashby (and some
Greenhouse variants):

- **Synthetic JS events** (`dispatchEvent(new Event("input"))`) have
  `isTrusted = false`. Ashby's internal form-state tracker ignores them. The
  value appears on screen but the validator never registers it — producing
  "Missing entry for required field" errors on submit even though the field
  looks filled.
- **CDP `Input.insertText`** fires through the browser's own input pipeline.
  The events arrive with `isTrusted = true`, indistinguishable from actual
  typing. Ashby's validator picks them up immediately.

The `autofill.js` engine still runs in both modes:
- **Plan mode** (`planOnly: true`, used by `stage-apps.js`): matches elements
  and tags them with `data-rob-fill-id`, writes the plan to
  `window.__robFillPlan`, but does NOT set any values. The Node script then
  types each value via CDP.
- **Fill mode** (default, used by console snippets): sets values immediately
  via `setNativeValue` + synthetic events. This is fine for direct console use
  where Ashby isn't the concern, and it keeps the bookmarklet/snippet path
  unchanged.

### JD-page advance — auto-clicking "Apply" before filling

Many job boards land on a job-description page, not directly on the application form. `stage-apps.js` detects this and advances the tab automatically before attempting to attach files or type fields.

**How it works (after page load, before file-attach):**

1. Checks whether a *visible* form or file input is already present. If yes — proceed immediately, no click needed. The visibility check skips elements hidden via `[hidden]` attribute (e.g. Airbnb embeds the Greenhouse form in a hidden panel before the "Apply" tab is clicked).
2. Looks for an `<a href>` whose text starts with "apply" (case-insensitive, `/^\s*apply(\s|$)/i`) and does not contain "submit" — navigates the tab there via `Page.navigate`.
3. Falls back to a `<button>` or `[role=button]` with the same text constraint — clicks it via `el.click()`.
4. After any advance, re-waits up to 20 s for the form to hydrate, then continues with normal attach+fill.

**Never-submit boundary:** the "starts with apply" regex cannot match "Submit", "Submit application", or any submit-adjacent text. Additionally, the advance step is skipped entirely whenever a visible form is already in the DOM — clicking anything once a form is present could submit it.

**Known URL rewrites (no DOM interaction needed):**

| Pattern | Rewrite |
|---|---|
| `stripe.com/jobs/listing/<slug>/<id>` | `…/<id>/apply` (Stripe's direct form URL) |
| `jobs.ashbyhq.com/…` without `/application` | `…/application` (existing Ashby rule) |

The rewrite table lives in `rewriteToFormUrl()` and is easy to extend for new ATS patterns.

**Example log output when advance fires:**

```
Apply button clicked: "Apply Now"
Advanced to form via button-click — waiting for form to hydrate...
```

If no apply control is found and no form loads, the script logs `no-apply-control-found` and continues to the fill step anyway (it may find fields or flag them manual).

In `--refill` mode the same advance step runs on matched tabs that are sitting on a JD page — the tab is advanced in-place before re-typing fields.

### --refill: fix already-open tabs without reopening

If you staged tabs earlier with the old JS-injection approach (or if Ashby
showed "required field" errors after the initial stage run), run:

```bash
node scripts/stage-apps.js /abs/path/to/applied/YYYY-MM-DD --refill
```

This enumerates every open page tab on port 9223, matches each URL against the
date-dir folders' `applyUrl` values, and re-types the identity/essay fields via
CDP on each matching tab. It does NOT re-attach files (they're already attached)
and does NOT navigate or close any tab. Non-matching tabs (bridge UI, unrelated
pages) are skipped and logged.

URL matching handles edge cases:
- Ashby `/application` suffix present or absent
- Greenhouse `boards.greenhouse.io` vs `job-boards.greenhouse.io` (matched by job ID)
- Stripe `/listing/…/ID` vs `/listing/…/ID/apply` (matched by numeric job ID)

### What each tab gets

- **PDFs attached** via Chrome DevTools Protocol `DOM.setFileInputFiles` — the
  only way to set `<input type=file>` from outside the page. The resume PDF goes
  to the resume input; cover letter to the cover-letter input. If only one file
  input exists, resume is attached there and the cover letter is flagged manual.
- **Text fields typed** via CDP `Input.insertText` (real keystrokes). Fills:
  first name, last name, full name, email, phone, LinkedIn, GitHub, website,
  location, cover letter textarea, and "why company" textarea. Identity data is
  merged from `field-map.json` + `private/applicant-profile.json` at runtime —
  never written to disk.
- **Orange outlines** on every dropdown, radio, checkbox, and file input Rob
  still needs to touch, plus a floating summary panel.

### Zero dependencies

`stage-apps.js` uses **no npm packages**. Node 26 ships built-in `WebSocket`
and `fetch`, so the script speaks Chrome DevTools Protocol directly over raw
WebSocket + HTTP. Nothing to `npm install`.

### Fallback: open-links.sh

If Chrome CDP isn't running or you just want to open all URLs quickly:

```bash
# Open every applyUrl from field-map.json files under a date folder
bash scripts/open-links.sh applied/2026-06-11

# Or pass the CLICK-LIST.md directly
bash scripts/open-links.sh applied/2026-06-11/CLICK-LIST.md
```

This opens each URL in the default browser, 1s apart. No autofill, no file
attach — just tabs. Use it as a fallback or to quickly check forms before staging.

### Troubleshooting

| Symptom | Fix |
|---|---|
| `Cannot reach Job Applications Chrome on port 9223` | Run `bash scripts/chrome-debug.sh` — look for the purple window |
| `Job Applications Chrome already running on port 9223` | Good — nothing to do, run stage-apps.js |
| Ashby: "required field" error on submit despite visible values | Run `--refill` — the original JS-event path used isTrusted=false events; CDP typing fixes this |
| Field typed but reads EMPTY after CDP fill | Field is likely a dropdown-backed autocomplete (Greenhouse city, Workday location) — fill manually |
| Files attached but values empty | ATS uses shadow DOM inputs; run autofill-snippet.js manually |
| Greenhouse: no file input found | Greenhouse hides the real input behind a button; CDP sets it on the hidden input directly |
| Workday: most fields manual | Workday iframe sandboxing limits CDP reach; use autofill-snippet.js manually |
| LinkedIn field on Greenhouse: WARN could not focus | Field may be in an iframe; fill manually |
| Stripe: tab opens at `/apply` but shows a login wall | Log into stripe.com in the purple window first; re-run `--only Stripe_…` to re-stage |
| "No form found after apply-advance" | Either a login wall appeared, or the apply button triggered a new-page navigation that requires a cookie — log in manually, then run `--refill` |
