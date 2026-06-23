# `/autofill` endpoint — hand-merge into `bridge/server.js`

> **This is the ONLY piece that must be hand-merged into `server.js`.**
> It was written as a separate file because another agent was editing
> `server.js` concurrently and a direct edit would have clobbered its work.
> The standalone script (`scripts/autofill.js`), the UI button, and the fetch
> helper (`bridge/intake.html`) are already in place and working.

## What it does

`POST /autofill { key }`:

1. Looks up the ledger entry by `key`.
2. Resolves its built folder (`entry.folder`) → `field-map.json`.
3. Spawns `node scripts/autofill.js <field-map path>` **detached** (same pattern
   as `handleControlStage` spawning `STAGE_JS`), writing output to `STAGE_LOG`
   so the existing `GET /control/stage-log` tail shows progress if desired.
4. Returns `{ ok: true, key, folder }` immediately (the browser work happens in
   the staging Chrome; the script never submits).

It reuses the already-defined consts `LEDGER_PATH`, `REPO`, `STAGE_LOG`,
`isChromeDebugUp()`, `isCsrfBlocked()`, `readBody()`, and `sendJson()`.

---

## 1. Add this handler

Paste alongside the other `/control/*` handlers (e.g. just after
`handleControlStage`). Note: it defines `AUTOFILL_JS`; if you'd rather, hoist
that to the config block next to `STAGE_JS` — either works.

```js
// Path to the single-role autofill CLI (sibling of STAGE_JS). If you prefer,
// move this next to STAGE_JS in the config block at the top of the file.
const AUTOFILL_JS = path.join(REPO, "scripts/autofill.js");

/**
 * POST /autofill  body: { key }
 *
 * Phase 5 — open ONE built role's apply page in the staging Chrome, fill the
 * standard fields, attach the resume + cover-letter PDFs, and STOP before submit
 * (Rob always reviews + submits). Resolves the field-map from the ledger entry's
 * built folder, then spawns scripts/autofill.js detached (mirrors handleControlStage).
 */
async function handleAutofill(req, res) {
  if (isCsrfBlocked(req)) {
    sendJson(res, 403, { ok: false, error: "forbidden origin" });
    return;
  }
  const body = await readBody(req);
  const key = (body.key ?? "").trim();
  if (!key) {
    sendJson(res, 400, { ok: false, error: "key is required" });
    return;
  }

  // Staging Chrome must be reachable — autofill drives it over CDP (port 9223).
  if (!(await isChromeDebugUp())) {
    sendJson(res, 400, {
      ok: false,
      error: "Job Applications Chrome (port 9223) is not reachable. Launch Staging Chrome first, then retry.",
    });
    return;
  }

  // Resolve the ledger entry → its built folder → field-map.json.
  let entry;
  try {
    const ledger = JSON.parse(fs.readFileSync(LEDGER_PATH, "utf8"));
    entry = (ledger.entries ?? []).find((e) => e.key === key);
  } catch (err) {
    sendJson(res, 500, { ok: false, error: "failed to read ledger: " + err.message });
    return;
  }
  if (!entry) {
    sendJson(res, 404, { ok: false, error: `no ledger entry for key "${key}"` });
    return;
  }
  if (!entry.folder) {
    sendJson(res, 400, { ok: false, error: `role "${key}" is not built yet (status: ${entry.status})` });
    return;
  }
  const fieldMapPath = path.join(entry.folder, "field-map.json");
  if (!fs.existsSync(fieldMapPath)) {
    sendJson(res, 400, { ok: false, error: `field-map.json missing in ${entry.folder}` });
    return;
  }

  // Fresh log header so the UI's stage-log tail (if watched) shows this run.
  fs.writeFileSync(
    STAGE_LOG,
    `[${new Date().toISOString()}] autofill.js started\n  key: ${key}\n  folder: ${entry.folder}\n\n`,
    "utf8"
  );

  // Spawn detached — same shape as handleControlStage's stage-apps.js spawn.
  const logFd = fs.openSync(STAGE_LOG, "a");
  const child = spawn(process.execPath, [AUTOFILL_JS, fieldMapPath], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();

  sendJson(res, 200, {
    ok: true,
    key,
    folder: entry.folder,
    note: "Autofill running in staging Chrome — fills + attaches, never submits. Review then submit.",
    pid: child.pid,
  });
}
```

> `spawn`, `fs`, `path` are already imported at the top of `server.js`
> (`import { spawnSync, spawn } from "node:child_process";`, etc.), so no new
> imports are needed.

---

## 2. Register the route

Add this entry to the `routes` array (e.g. right after the `/control/stage`
entry), matching the existing `{ method, test, handler }` shape:

```js
  {
    method: "POST",
    test: (p) => p === "/autofill",
    handler: (req, res) => handleAutofill(req, res),
  },
```

---

## 3. (Optional) Add a startup log line

For parity with the other routes, you can add this inside the `server.listen`
callback's console block:

```js
  console.log(`  POST /autofill          — fill + attach one built role in staging Chrome (never submits)`);
```

---

## Verifying after merge

```bash
# Restart the bridge (however you normally run it), Staging Chrome up, then:
curl -s -X POST http://127.0.0.1:8787/autofill \
  -H 'Content-Type: application/json' \
  -d '{"key":"greenhouse:5181852008"}'
# → {"ok":true,"key":"greenhouse:5181852008","folder":"…","note":"…","pid":…}
# A tab opens in the purple staging Chrome, fields fill, PDFs attach, NOT submitted.
```

The UI button (`bridge/intake.html`, `autofillRole()`) already POSTs exactly this
payload, so once the route is live the "Auto-fill" button on each built ledger row
works end to end.
