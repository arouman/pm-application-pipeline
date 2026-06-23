# Bridge — Job Discovery Service

Local Node.js server that queries public ATS job board APIs for Rob's target companies, filters roles to design/PM-relevant titles, and exposes a clean JSON API for the Chrome extension to consume.

## Quick Start

```bash
node bridge/server.js
```

Default port: **8787**. Override with:

```bash
node bridge/server.js --port 9000
# or
PORT=9000 node bridge/server.js
```

Requires Node 18+ (uses global `fetch`). No npm install needed.

---

## Endpoint Contract

All endpoints return JSON with `Content-Type: application/json` and permissive CORS headers (`Access-Control-Allow-Origin: *`). The Chrome extension can call any of these directly from a content script or service worker.

---

### `GET /health`

Liveness check.

**Response `200`:**
```json
{ "ok": true, "service": "bridge", "version": 1 }
```

---

### `GET /discover`

Fetches all companies in `targets.json` in parallel, filters roles to target titles, and returns a sorted list.

**Query params (both optional):**

| Param | Example | Effect |
|-------|---------|--------|
| `company` | `?company=Anthropic` | Filter results to companies whose name contains this string (case-insensitive). Only those companies are fetched, saving network calls. |
| `title` | `?title=designer` | Additional substring filter on job title after the keyword filter runs. |

**Response `200`:**
```json
{
  "count": 42,
  "roles": [
    {
      "company": "Anthropic",
      "title": "Product Designer, Claude",
      "location": "San Francisco, CA",
      "url": "https://boards.greenhouse.io/anthropic/jobs/123456",
      "ats": "greenhouse",
      "jobId": "123456",
      "tier": 1
    }
  ],
  "errors": [
    { "company": "SomeCo", "error": "HTTP 503" }
  ]
}
```

Roles are sorted by `tier` ascending, then `company` alphabetically. A single company's ATS being down does not fail the whole request — it shows up in `errors` while all others still return.

**Title keywords** (configured in `server.js` as `TITLE_KEYWORDS`):
- product designer, design lead, design director, design strategist
- service design, experience design, ai experience, ai product
- ux (with trailing space or slash to avoid false matches)
- product manager, staff designer, principal designer
- head of design, vp of design

---

### `POST /scout`

**(Stub — Phase 2)**

Intended: fetch a full job description and score it against Rob's resume keywords.

Planned payload:
```json
{ "company": "Anthropic", "jobId": "123456" }
```

Current response `200`:
```json
{ "ok": false, "status": "not_implemented", "note": "wired in a later phase" }
```

---

### `POST /build`

**(Stub — Phase 2)**

Intended: generate a tailored cover letter and resume highlights for a specific role using the Claude API.

Planned payload:
```json
{ "company": "Anthropic", "jobId": "123456", "jobUrl": "https://..." }
```

Current response `200`:
```json
{ "ok": false, "status": "not_implemented", "note": "wired in a later phase" }
```

---

## Adding a Company

Edit `targets.json`. Each entry needs:

```json
{
  "name": "Company Name",
  "ats": "greenhouse",
  "slug": "company-slug",
  "tier": 1,
  "verified": true
}
```

`ats` must be one of: `greenhouse`, `lever`, `ashby`.

**How to find the slug:**

- **Greenhouse:** Visit the company's job board (e.g., `boards.greenhouse.io/anthropic`) — the slug is the path segment after `/`.  
  Test: `curl https://boards-api.greenhouse.io/v1/boards/YOUR-SLUG/jobs`
- **Lever:** Visit `jobs.lever.co/SLUG` — slug is in the URL.  
  Test: `curl "https://api.lever.co/v0/postings/YOUR-SLUG?mode=json"`
- **Ashby:** Visit `jobs.ashbyhq.com/SLUG` — slug is in the URL.  
  Test: `curl https://api.ashbyhq.com/posting-api/job-board/YOUR-SLUG`

Only add a company after confirming the endpoint returns data. The server will surface errors gracefully but wastes a fetch call on dead slugs every time `/discover` runs.

---

## Verified Companies (as of June 2026)

| Company | ATS | Slug | Tier |
|---------|-----|------|------|
| Anthropic | Greenhouse | `anthropic` | 1 |
| OpenAI | Ashby | `openai` | 1 |
| Google DeepMind | Greenhouse | `deepmind` | 1 |
| Figma | Greenhouse | `figma` | 1 |
| Stripe | Greenhouse | `stripe` | 1 |
| Airbnb | Greenhouse | `airbnb` | 1 |
| xAI | Greenhouse | `xai` | 1 |
| IDEO | Greenhouse | `ideo` | 1 |
| Oura Ring | Greenhouse | `oura` | 2 |
| Asana | Greenhouse | `asana` | 2 |
| Omada Health | Greenhouse | `omadahealth` | 3 |

**Unresolved Tier-1 targets** (no public ATS board found — monitor manually):
- frog/Capgemini Invent — Workday enterprise ATS, no public JSON endpoint
- BCG X — Phenom/Workday, no public JSON endpoint
- Cohere — no board found under tested slugs; check cohere.com/careers
- Work & Co — no board found; check work.co/careers
- Notion — likely Rippling or custom; check notion.so/careers
- Linear — custom careers page; check linear.app/careers
