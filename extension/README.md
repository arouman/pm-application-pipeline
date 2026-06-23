# Rob's Job Scout — Chrome Extension

A Manifest V3 side panel extension that pulls live open roles from your target
companies via the local bridge server and surfaces them ranked by tier.

---

## Prerequisites

- Node 18+ (the bridge uses global `fetch`)
- Google Chrome (the `sidePanel` API is Chrome-only)
- The `applications` repo cloned locally

---

## Step 1 — Start the bridge

Open a terminal in the repo root and run:

```
node bridge/server.js
```

You should see:

```
bridge server running on http://127.0.0.1:8787
  GET  /health    — liveness check
  GET  /discover  — fetch + filter open roles
  POST /scout     — (stub) score a specific role
  POST /build     — (stub) generate application materials
```

Leave this terminal running. The extension calls `http://localhost:8787` — if
the bridge is not running, the panel shows a calm offline state with a retry
button.

---

## Step 2 — Load the extension in Chrome

1. Open `chrome://extensions` in Chrome.
2. Toggle **Developer mode** on (top-right switch).
3. Click **Load unpacked**.
4. Navigate to and select the `extension/` folder inside this repo
   (the folder that contains `manifest.json`).
5. The extension appears as **Rob's Job Scout** in the list.

---

## Step 3 — Open the side panel

Click the **Rob's Job Scout** toolbar icon (puzzle-piece menu → pin it for
easy access). The side panel opens on the right side of the browser window.

---

## What you should see

| Situation | Panel shows |
|---|---|
| Bridge running, roles found | Cards grouped by Tier 1 / 2 / 3, sorted by company within each tier. Header shows total match count and last-updated timestamp. |
| Bridge running, no roles match target titles | "No matches" empty state. |
| Bridge not running | "Bridge offline — run `node bridge/server.js`…" with a Refresh button. |
| Reopening the panel before a refresh completes | Cached results from the last fetch appear instantly while a background refresh runs. |

---

## Using the panel

- **Filter input** — type any company name or title fragment to narrow the
  list client-side instantly (no re-fetch).
- **Company dropdown** — select a company to re-query the bridge for just that
  company's roles.
- **Open JD** — opens the job description in a new tab.
- **Scout** — calls `POST /scout` on the bridge. Currently stubbed; shows
  "Scout wiring coming next" until Phase 3 implements it.
- **Refresh button** (top-right) — re-fetches all roles from the bridge.

---

## Regenerating icons

The icons are pre-generated PNGs committed to the repo. If you ever need to
regenerate them:

```
node extension/icons/gen-icons.js
```

---

## File map

```
extension/
├── manifest.json       MV3 manifest
├── background.js       Service worker — opens side panel on toolbar click
├── sidepanel.html      Side panel shell (semantic structure)
├── sidepanel.css       Brand styles (petrol-teal, Source Sans 3)
├── sidepanel.js        All panel logic: fetch, render, filter, cache, scout
├── icons/
│   ├── gen-icons.js    Dev utility — generates the PNGs below (not loaded by extension)
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── README.md           This file
```
