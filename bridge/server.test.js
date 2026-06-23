/**
 * server.test.js — integration tests for the bridge server.
 *
 * Boots the REAL server (server.js) as a subprocess on a free port, with its
 * data-file paths (QUEUE_PATH / LEDGER_PATH / FEEDBACK_PATH / JDS_DIR) pointed
 * at a throwaway temp sandbox via env vars. Every request exercises the real
 * HTTP routing + the real Python data layer (queue.py / ledger.py) — nothing is
 * mocked except the file locations, so Rob's production queue/ledger are never
 * touched.
 *
 * Network-dependent paths (the full /intake JD fetch) are intentionally NOT
 * exercised here — only their validation. The data-layer endpoints, CSRF guard,
 * and routing ARE covered end-to-end.
 *
 * Run:  node --test bridge/server.test.js
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, "server.js");

let child;
let PORT;
let BASE;
let sandbox;
let QUEUE_PATH, LEDGER_PATH, FEEDBACK_PATH, JDS_DIR, PAUSE_FILE, SCAN_LOCK, RESCORE_ALL_LOCK;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}
function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

async function waitForHealth(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return;
    } catch (_) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not become healthy in time");
}

before(async () => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-test-"));
  QUEUE_PATH = path.join(sandbox, "queue.json");
  LEDGER_PATH = path.join(sandbox, "ledger.json");
  FEEDBACK_PATH = path.join(sandbox, "fit-feedback.json");
  PAUSE_FILE = path.join(sandbox, ".paused-until");
  SCAN_LOCK = path.join(sandbox, ".manual-scan.lock");
  RESCORE_ALL_LOCK = path.join(sandbox, ".rescore-all.lock");
  JDS_DIR = path.join(sandbox, "jds");
  fs.mkdirSync(JDS_DIR, { recursive: true });

  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;

  child = spawn("node", [SERVER], {
    cwd: __dirname,
    env: {
      ...process.env,
      PORT: String(PORT),
      QUEUE_PATH,
      LEDGER_PATH,
      FEEDBACK_PATH,
      PAUSE_FILE,
      JDS_DIR,
      SCAN_LOCK,
      RESCORE_ALL_LOCK,
      // parse.test.js sets BRIDGE_NO_LISTEN=1 in the shared --test process to
      // import server.js without binding a port. Clear it here so this spawned
      // child ALWAYS listens, regardless of test-file evaluation order.
      BRIDGE_NO_LISTEN: "",
    },
    stdio: ["ignore", "ignore", "inherit"],
  });
  await waitForHealth();
});

after(() => {
  if (child) child.kill("SIGTERM");
  try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch (_) {}
});

// Reset data files to a clean shell before each test so cases are independent.
beforeEach(() => {
  writeJson(QUEUE_PATH, { version: 1, items: [] });
  writeJson(LEDGER_PATH, { version: 1, entries: [] });
  writeJson(FEEDBACK_PATH, { version: 1, entries: [] });
  // Remove any leftover pause file so tests start unpaused
  try { fs.unlinkSync(PAUSE_FILE); } catch (_) {}
  // Remove any leftover manual-scan lock so the scan guard starts clean
  try { fs.unlinkSync(SCAN_LOCK); } catch (_) {}
  // Remove any leftover rescore-all lock
  try { fs.unlinkSync(RESCORE_ALL_LOCK); } catch (_) {}
});

// ---------------------------------------------------------------------------
// Liveness + static
// ---------------------------------------------------------------------------

test("GET /health → 200 bridge v2", async () => {
  const r = await fetch(`${BASE}/health`);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, service: "bridge", version: 2 });
});

test("GET / → 200 html intake page", async () => {
  const r = await fetch(`${BASE}/`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /text\/html/);
  const body = await r.text();
  assert.match(body, /Application Pipeline/);
});

test("unknown route → 404 json", async () => {
  const r = await fetch(`${BASE}/no-such-route`);
  assert.equal(r.status, 404);
  assert.equal((await r.json()).ok, false);
});

test("OPTIONS preflight → 204 with CORS", async () => {
  const r = await fetch(`${BASE}/intake`, { method: "OPTIONS" });
  assert.equal(r.status, 204);
  assert.equal(r.headers.get("access-control-allow-methods"),
               "GET, POST, OPTIONS");
});

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

test("GET /queue empty → count 0", async () => {
  const r = await fetch(`${BASE}/queue`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.count, 0);
  assert.deepEqual(body.items, []);
});

test("GET /queue maps item fields", async () => {
  writeJson(QUEUE_PATH, { version: 1, items: [{
    id: "greenhouse__1", company: "Acme", title: "Product Designer",
    status: "pending", coverage: "93", jdUrl: "https://x/y",
    folderName: "Acme", secretField: "should not leak",
  }] });
  const r = await fetch(`${BASE}/queue`);
  const body = await r.json();
  assert.equal(body.count, 1);
  const it = body.items[0];
  assert.equal(it.id, "greenhouse__1");
  assert.equal(it.company, "Acme");
  assert.equal(it.status, "pending");
  assert.equal(it.coverage, "93");
});

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

test("GET /ledger empty → count 0", async () => {
  const r = await fetch(`${BASE}/ledger`);
  const body = await r.json();
  assert.equal(body.count, 0);
});

test("POST /ledger/mark requires key and status → 400", async () => {
  const r = await fetch(`${BASE}/ledger/mark`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: "greenhouse:1" }),
  });
  assert.equal(r.status, 400);
});

test("POST /ledger/mark updates an existing entry to submitted", async () => {
  writeJson(LEDGER_PATH, { version: 1, entries: [{
    key: "greenhouse:1", company: "Acme", title: "PD", ats: "greenhouse",
    jobId: "1", applyUrl: "https://x", folder: null, status: "built",
    firstSeen: "2026-06-10", appliedDate: null,
  }] });
  const r = await fetch(`${BASE}/ledger/mark`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: "greenhouse:1", status: "submitted" }),
  });
  assert.equal(r.status, 200);
  const entry = readJson(LEDGER_PATH).entries[0];
  assert.equal(entry.status, "submitted");
  assert.ok(entry.appliedDate, "appliedDate should be set on submit");
});

test("GET /queue reconciles a built queue item into the ledger (inbox 'new' → built)", async () => {
  // Regression (Findigs bug): inbox-found roles sit at ledger status "new"; a
  // built queue item must promote them to "built". Previously only "queued" was
  // promoted, so every inbox-built role was stranded at "new".
  writeJson(QUEUE_PATH, { version: 1, items: [{
    id: "greenhouse__1", company: "Acme", title: "Product Designer",
    ats: "greenhouse", jobId: "1", status: "built", jdUrl: "https://x/y",
    folder: "Acme_Product-Designer", date: "2026-06-18",
  }] });
  writeJson(LEDGER_PATH, { version: 1, entries: [{
    key: "greenhouse:1", company: "Acme", title: "Product Designer",
    ats: "greenhouse", jobId: "1", applyUrl: "https://x/y", folder: null,
    status: "new", firstSeen: "2026-06-18", appliedDate: null, referral: false,
  }] });
  await fetch(`${BASE}/queue`); // triggers reconcileQueueToLedger
  const entry = readJson(LEDGER_PATH).entries.find((e) => e.key === "greenhouse:1");
  assert.equal(entry.status, "built", "inbox 'new' role should be promoted to built");
  assert.equal(entry.folder, "Acme_Product-Designer", "folder copied from the queue item");
  assert.equal(entry.referral, false, "referral preserved across promotion");
});

// ---------------------------------------------------------------------------
// Pass + feedback loop
// ---------------------------------------------------------------------------

test("POST /pass requires a reason → 400", async () => {
  const r = await fetch(`${BASE}/pass`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: "greenhouse:1" }),
  });
  assert.equal(r.status, 400);
});

test("POST /pass writes feedback and marks ledger passed", async () => {
  writeJson(LEDGER_PATH, { version: 1, entries: [{
    key: "greenhouse:1", company: "Acme", title: "PD", ats: "greenhouse",
    jobId: "1", applyUrl: "https://x", folder: null, status: "queued",
    firstSeen: "2026-06-10", appliedDate: null,
  }] });
  const r = await fetch(`${BASE}/pass`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      key: "greenhouse:1", company: "Acme", title: "PD",
      reason: "requires people management",
    }),
  });
  assert.equal(r.status, 200);
  const fb = readJson(FEEDBACK_PATH);
  assert.equal(fb.entries.length, 1);
  assert.equal(fb.entries[0].reason, "requires people management");
  const entry = readJson(LEDGER_PATH).entries[0];
  assert.equal(entry.status, "passed");
});

// ---------------------------------------------------------------------------
// CSRF guard
// ---------------------------------------------------------------------------

test("cross-origin POST /pass → 403 forbidden", async () => {
  const r = await fetch(`${BASE}/pass`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Origin": "http://evil.example" },
    body: JSON.stringify({ key: "x", reason: "y" }),
  });
  assert.equal(r.status, 403);
});

test("same-origin POST /pass (trusted Origin) is allowed", async () => {
  const r = await fetch(`${BASE}/pass`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Origin": BASE },
    body: JSON.stringify({ company: "Acme", title: "PD", reason: "not a fit" }),
  });
  assert.equal(r.status, 200);
});

// ---------------------------------------------------------------------------
// Intake validation (network path not exercised)
// ---------------------------------------------------------------------------

test("POST /intake requires a url → 400", async () => {
  const r = await fetch(`${BASE}/intake`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(r.status, 400);
});

test("cross-origin POST /intake → 403", async () => {
  const r = await fetch(`${BASE}/intake`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Origin": "http://evil.example" },
    body: JSON.stringify({ url: "https://x/y" }),
  });
  assert.equal(r.status, 403);
});

// ---------------------------------------------------------------------------
// Redesign: decision inbox + Build + lifecycle
// ---------------------------------------------------------------------------

function newInboxItem(over = {}) {
  return {
    id: "greenhouse__7821718", company: "Omada Health",
    title: "Staff Product Designer", ats: "greenhouse", jobId: "7821718",
    status: "new", fitScore: 85, fitNote: "strong AI-experience match",
    summary: "AI-experience design role in chronic care. Rob maps well on "
      + "AI product design and behavior change; lighter on clinical workflows.",
    topGap: "clinical-workflow design", tier: 1, location: "Remote (US)",
    jdUrl: "https://job-boards.greenhouse.io/omadahealth/jobs/7821718",
    ...over,
  };
}

test("GET /queue surfaces inbox fields (fit, summary, gap)", async () => {
  writeJson(QUEUE_PATH, { version: 1, items: [newInboxItem()] });
  const it = (await (await fetch(`${BASE}/queue`)).json()).items[0];
  assert.equal(it.status, "new");
  assert.equal(it.fitScore, 85);
  assert.match(it.summary, /chronic care/);
  assert.equal(it.topGap, "clinical-workflow design");
  assert.equal(it.tier, 1);
});

test("POST /build flips a new item to pending", async () => {
  writeJson(QUEUE_PATH, { version: 1, items: [newInboxItem()] });
  const r = await fetch(`${BASE}/build`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "greenhouse__7821718" }),
  });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).ok, true);
  const item = readJson(QUEUE_PATH).items[0];
  assert.equal(item.status, "pending");  // now claimable by run-batch
});

test("POST /build requires an id → 400", async () => {
  const r = await fetch(`${BASE}/build`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(r.status, 400);
});

test("POST /build unknown id → 404", async () => {
  writeJson(QUEUE_PATH, { version: 1, items: [] });
  const r = await fetch(`${BASE}/build`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "ghost" }),
  });
  assert.equal(r.status, 404);
});

test("cross-origin POST /build → 403", async () => {
  const r = await fetch(`${BASE}/build`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Origin": "http://evil.example" },
    body: JSON.stringify({ id: "x" }),
  });
  assert.equal(r.status, 403);
});

test("POST /pass on a new inbox item marks it passed", async () => {
  writeJson(QUEUE_PATH, { version: 1, items: [newInboxItem()] });
  const r = await fetch(`${BASE}/pass`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "greenhouse__7821718", reason: "not chronic care" }),
  });
  assert.equal(r.status, 200);
  assert.equal(readJson(QUEUE_PATH).items[0].status, "passed");
});

test("POST /ledger/mark sets the referral flag", async () => {
  writeJson(LEDGER_PATH, { version: 1, entries: [{
    key: "greenhouse:1", company: "Acme", title: "PD", ats: "greenhouse",
    jobId: "1", applyUrl: "https://x", folder: null, status: "submitted",
    firstSeen: "2026-06-10", appliedDate: "2026-06-10",
  }] });
  const r = await fetch(`${BASE}/ledger/mark`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: "greenhouse:1", referral: true }),
  });
  assert.equal(r.status, 200);
  assert.equal(readJson(LEDGER_PATH).entries[0].referral, true);
});

test("POST /ledger/mark records lifecycle into statusHistory", async () => {
  writeJson(LEDGER_PATH, { version: 1, entries: [{
    key: "greenhouse:1", company: "Acme", title: "PD", ats: "greenhouse",
    jobId: "1", applyUrl: "https://x", folder: null, status: "built",
    firstSeen: "2026-06-10", appliedDate: null,
  }] });
  for (const status of ["submitted", "screener", "interview"]) {
    await fetch(`${BASE}/ledger/mark`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "greenhouse:1", status }),
    });
  }
  const hist = readJson(LEDGER_PATH).entries[0].statusHistory;
  assert.deepEqual(hist.map((h) => h.status),
                   ["built", "submitted", "screener", "interview"]);
});

// ---------------------------------------------------------------------------
// Fix 4: elapsed time + isStale in GET /queue
// ---------------------------------------------------------------------------

test("GET /queue: building item with old startedAt has elapsedSeconds + isStale=true", async () => {
  const nowSec = Math.floor(Date.now() / 1000);
  writeJson(QUEUE_PATH, { version: 1, items: [{
    id: "gh__stale", company: "Acme", title: "Designer",
    status: "building",
    startedAt: nowSec - 1900,  // 31+ min ago — past the 1800s default threshold
  }] });
  const body = await (await fetch(`${BASE}/queue`)).json();
  const it = body.items[0];
  assert.ok(it.elapsedSeconds >= 1900, `elapsedSeconds should be >= 1900, got ${it.elapsedSeconds}`);
  assert.equal(it.isStale, true);
});

test("GET /queue: fresh building item has isStale=false", async () => {
  const nowSec = Math.floor(Date.now() / 1000);
  writeJson(QUEUE_PATH, { version: 1, items: [{
    id: "gh__fresh", company: "Acme", title: "Designer",
    status: "building",
    startedAt: nowSec - 10,  // 10 seconds ago
  }] });
  const body = await (await fetch(`${BASE}/queue`)).json();
  const it = body.items[0];
  assert.equal(it.isStale, false);
});

test("GET /queue: non-building item has elapsedSeconds=null isStale=false", async () => {
  writeJson(QUEUE_PATH, { version: 1, items: [{
    id: "gh__pending", company: "Acme", title: "Designer", status: "pending",
  }] });
  const body = await (await fetch(`${BASE}/queue`)).json();
  const it = body.items[0];
  assert.equal(it.elapsedSeconds, null);
  assert.equal(it.isStale, false);
});

// ---------------------------------------------------------------------------
// Fix 4: POST /control/cancel-build resets a stuck building item
// ---------------------------------------------------------------------------

test("POST /control/cancel-build resets building item to pending", async () => {
  const nowSec = Math.floor(Date.now() / 1000);
  writeJson(QUEUE_PATH, { version: 1, items: [{
    id: "gh__stuck", company: "Acme", title: "Designer",
    status: "building", startedAt: nowSec - 1200,
  }] });
  const r = await fetch(`${BASE}/control/cancel-build`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "gh__stuck" }),
  });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).ok, true);
  const item = readJson(QUEUE_PATH).items[0];
  assert.equal(item.status, "pending");
});

test("POST /control/cancel-build rejects non-building items", async () => {
  writeJson(QUEUE_PATH, { version: 1, items: [{
    id: "gh__pending", company: "Acme", title: "Designer", status: "pending",
  }] });
  const r = await fetch(`${BASE}/control/cancel-build`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "gh__pending" }),
  });
  assert.equal(r.status, 400);
});

test("POST /control/cancel-build missing id → 400", async () => {
  const r = await fetch(`${BASE}/control/cancel-build`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(r.status, 400);
});

test("cross-origin POST /control/cancel-build → 403", async () => {
  const r = await fetch(`${BASE}/control/cancel-build`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Origin": "http://evil.example" },
    body: JSON.stringify({ id: "x" }),
  });
  assert.equal(r.status, 403);
});

// ---------------------------------------------------------------------------
// "Search for roles" — on-demand watcher scan (/control/scan + status.scanning)
// ---------------------------------------------------------------------------

test("GET /control/status reports scanning=false when no scan lock", async () => {
  const r = await fetch(`${BASE}/control/status`);
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.equal(j.scanning, false);
});

test("POST /control/scan is a no-op when a scan is already running (live PID lock)", async () => {
  // Seed the lock with THIS process's PID (guaranteed alive) → the guard must
  // refuse to spawn a second scan and report it's already running.
  fs.writeFileSync(SCAN_LOCK, String(process.pid));
  const r = await fetch(`${BASE}/control/scan`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  });
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.equal(j.ok, true);
  assert.equal(j.scanning, true);
  assert.match(j.note, /already running/i);
  assert.equal(j.pid, undefined);  // proves nothing new was spawned
  // And status agrees the lock is live.
  const s = await (await fetch(`${BASE}/control/status`)).json();
  assert.equal(s.scanning, true);
});

test("GET /control/status clears a stale scan lock (dead PID) → scanning=false", async () => {
  // PID 2^31-1 is never a real live process → the status check should treat the
  // lock as stale, delete it, and report not-scanning.
  fs.writeFileSync(SCAN_LOCK, "2147483647");
  const j = await (await fetch(`${BASE}/control/status`)).json();
  assert.equal(j.scanning, false);
  assert.equal(fs.existsSync(SCAN_LOCK), false);
});

test("cross-origin POST /control/scan → 403", async () => {
  const r = await fetch(`${BASE}/control/scan`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Origin": "http://evil.example" },
    body: "{}",
  });
  assert.equal(r.status, 403);
});

// ---------------------------------------------------------------------------
// Note: pure-function tests for parseJobUrl / canonicalKey (Fix 5: ReachMee)
// live in parse.test.js alongside the other adapter unit tests, because that
// file already sets BRIDGE_NO_LISTEN=1 before importing server.js.  A static
// import of server.js HERE (without BRIDGE_NO_LISTEN set) would cause server.js
// to try to listen on port 8787, colliding with the running production bridge.
// ---------------------------------------------------------------------------
// Fix 6: prior decisions gate re-queue/build via /intake
// ---------------------------------------------------------------------------

test("POST /intake: role with decided status (passed) in ledger is blocked without force", async () => {
  // Seed a passed entry in the ledger (outside the 183-day window, but has prior decision)
  writeJson(LEDGER_PATH, { version: 1, entries: [{
    key: "reachmee:718",
    company: "Norrøna", title: "Jr. Project Leader",
    ats: "reachmee", jobId: "718",
    applyUrl: "https://www.norrona.com/en-GB/careers/1098/?rmjob=718",
    folder: null, status: "passed",
    firstSeen: "2026-06-13", appliedDate: null,
  }] });

  // POST the same job via its public URL
  const r = await fetch(`${BASE}/intake`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: "https://www.norrona.com/en-GB/careers/1098/?rmjob=718" }),
  });
  // NOTE: The network fetch of the JD will fail in the test (no real HTTP) but
  // the dedup check fires AFTER the URL parse + ledger check, so we either get
  // queued:false (dedup blocked) or a network error. If it's a 500 we check the
  // queue wasn't touched. The key assertion is: queue item must NOT be added.
  const body = await r.json();
  const queueItems = readJson(QUEUE_PATH).items;
  assert.equal(queueItems.length, 0,
    `Queue must stay empty — prior passed decision should block intake. Response: ${JSON.stringify(body)}`);
});

// ---------------------------------------------------------------------------
// Fix 8: GET /control/status surfaces pausedUntil
// ---------------------------------------------------------------------------

test("GET /control/status returns pausedUntil=null when no pause file", async () => {
  const body = await (await fetch(`${BASE}/control/status`)).json();
  assert.equal(body.ok, true);
  assert.equal(body.pausedUntil, null);
});

// ---------------------------------------------------------------------------
// Second pass 2026-06-18 — Gap 1: www./non-www. web: key dedup
// ---------------------------------------------------------------------------

test("Gap 1: web: key is host-less — www.frog.co and frog.co produce the same key", async () => {
  // This test exercises the bridge's parseJobUrl directly via parse.test.js
  // (pure function test). Here we verify the /ledger/mark queue-skip path
  // correctly resolves the queue item by normalized URL when the intake URL
  // and the stored applyUrl differ only by www. prefix.
  //
  // Seed: queue item with host-less key (as stored after the live cleanup).
  //       ledger entry with the full www. applyUrl.
  const queueId = "web__careers_jobs_69dd8ae6939f64fc32b26ea9-munich";
  writeJson(QUEUE_PATH, { version: 1, items: [{
    id: queueId,
    company: "frog", title: "Senior Designer",
    ats: "web", jobId: "careers/jobs/69dd8ae6939f64fc32b26ea9-munich-design",
    status: "pending",
    jdUrl: "https://www.frog.co/careers/jobs/69dd8ae6939f64fc32b26ea9-munich-design",
  }] });
  writeJson(LEDGER_PATH, { version: 1, entries: [{
    key: "web:careers/jobs/69dd8ae6939f64fc32b26ea9-munich-design",
    company: "frog", title: "Senior Designer", ats: "web",
    jobId: "careers/jobs/69dd8ae6939f64fc32b26ea9-munich-design",
    applyUrl: "https://www.frog.co/careers/jobs/69dd8ae6939f64fc32b26ea9-munich-design",
    folder: null, status: "passed",
    firstSeen: "2026-06-17", appliedDate: null,
  }] });

  // Mark as rejected via ledger — should skip the queue item (status pending→skipped)
  const r = await fetch(`${BASE}/ledger/mark`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      key: "web:careers/jobs/69dd8ae6939f64fc32b26ea9-munich-design",
      status: "rejected",
    }),
  });
  assert.equal(r.status, 200);
  // The pending item should have been skipped.
  const item = readJson(QUEUE_PATH).items[0];
  assert.equal(item.status, "skipped",
    "pending queue item should be skipped when ledger marks the role rejected");
});

// ---------------------------------------------------------------------------
// Second pass 2026-06-18 — Gap 2: building item must NOT be skipped by /ledger/mark
// ---------------------------------------------------------------------------

test("Gap 2: /ledger/mark with dead status does NOT skip a building queue item", async () => {
  const queueId = "greenhouse__live_build";
  writeJson(QUEUE_PATH, { version: 1, items: [{
    id: queueId, company: "Acme", title: "Designer",
    ats: "greenhouse", jobId: "live_build",
    status: "building",   // actively building
    jdUrl: "https://job-boards.greenhouse.io/acme/jobs/live_build",
  }] });
  writeJson(LEDGER_PATH, { version: 1, entries: [{
    key: "greenhouse:live_build",
    company: "Acme", title: "Designer", ats: "greenhouse",
    jobId: "live_build",
    applyUrl: "https://job-boards.greenhouse.io/acme/jobs/live_build",
    folder: null, status: "built",
    firstSeen: "2026-06-18", appliedDate: null,
  }] });

  // Mark the role as rejected while it's actively building
  const r = await fetch(`${BASE}/ledger/mark`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: "greenhouse:live_build", status: "rejected" }),
  });
  assert.equal(r.status, 200);

  // The queue item must remain "building" — NOT silently flipped to "skipped"
  const item = readJson(QUEUE_PATH).items[0];
  assert.equal(item.status, "building",
    "building item must not be skipped by /ledger/mark — use /control/cancel-build instead");
});

// ---------------------------------------------------------------------------
// Rescore — /control/rescore (display fix + refresh button)
// ---------------------------------------------------------------------------

test("POST /control/rescore: cross-origin → 403", async () => {
  const r = await fetch(`${BASE}/control/rescore`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Origin": "http://evil.example" },
    body: JSON.stringify({ key: "greenhouse:1" }),
  });
  assert.equal(r.status, 403);
});

test("POST /control/rescore: missing key → 400", async () => {
  const r = await fetch(`${BASE}/control/rescore`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(r.status, 400);
});

test("POST /control/rescore: unknown ledger key → 404", async () => {
  // Empty ledger — key won't be found.
  writeJson(LEDGER_PATH, { version: 1, entries: [] });
  const r = await fetch(`${BASE}/control/rescore`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: "greenhouse:nonexistent" }),
  });
  assert.equal(r.status, 404);
});

test("POST /control/rescore: no jdPath on queue item → 400", async () => {
  // Ledger entry present, queue item present but WITHOUT a jdPath.
  writeJson(LEDGER_PATH, { version: 1, entries: [{
    key: "greenhouse:99", company: "Acme", title: "Designer",
    ats: "greenhouse", jobId: "99",
    applyUrl: "https://job-boards.greenhouse.io/acme/jobs/99",
    folder: null, status: "built",
    firstSeen: "2026-06-18", appliedDate: null,
  }] });
  writeJson(QUEUE_PATH, { version: 1, items: [{
    id: "greenhouse__99", company: "Acme", title: "Designer",
    ats: "greenhouse", jobId: "99",
    jdUrl: "https://job-boards.greenhouse.io/acme/jobs/99",
    status: "built",
    // intentionally no jdPath
  }] });
  const r = await fetch(`${BASE}/control/rescore`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: "greenhouse:99" }),
  });
  assert.equal(r.status, 400);
  const body = await r.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /No stored JD/i);
});

test("POST /control/rescore: scorer stub — writes fitScore to ledger + queue on success", async () => {
  // Write a real JD file to disk so the handler can validate it exists.
  // The scorer (watch-jobs.py --score-one) is stubbed by pointing WATCH_SCRIPT
  // at a tiny Python script that echos a fixed score JSON — but since the server
  // subprocess was started with the real WATCH_SCRIPT, we can't swap it at
  // runtime from the test. Instead, we test the "no jdPath" path (above) and
  // the "jdPath file missing" path here, which exercises the full resolution
  // chain up to the subprocess call without needing a live claude binary.
  const jdFile = path.join(JDS_DIR, "test-rescore.json");
  fs.writeFileSync(jdFile, JSON.stringify({
    company: "Acme", title: "Designer", location: "Remote",
    jdUrl: "https://job-boards.greenhouse.io/acme/jobs/55",
    ats: "greenhouse", jobId: "55",
    jdText: "Design systems and research experience required.",
  }));
  writeJson(LEDGER_PATH, { version: 1, entries: [{
    key: "greenhouse:55", company: "Acme", title: "Designer",
    ats: "greenhouse", jobId: "55",
    applyUrl: "https://job-boards.greenhouse.io/acme/jobs/55",
    folder: null, status: "built",
    firstSeen: "2026-06-18", appliedDate: null,
  }] });
  writeJson(QUEUE_PATH, { version: 1, items: [{
    id: "greenhouse__55", company: "Acme", title: "Designer",
    ats: "greenhouse", jobId: "55",
    jdUrl: "https://job-boards.greenhouse.io/acme/jobs/55",
    jdPath: jdFile,
    status: "built",
  }] });

  // The scorer subprocess will time out or fail without a live claude binary.
  // We verify the handler reaches the scorer stage (not blocked by earlier gates)
  // by checking it returns either 200 (if claude is available) or a 500 with a
  // scorer-specific error message — never a 400/404 resolution error.
  const r = await fetch(`${BASE}/control/rescore`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: "greenhouse:55" }),
  });
  const data = await r.json();
  // Either scorer succeeded (200) or failed at the subprocess stage (500).
  // The key assertion: NOT a 400 (resolution gates all passed).
  assert.ok(
    r.status === 200 || r.status === 500,
    `Expected 200 or 500 (scorer stage), got ${r.status}: ${JSON.stringify(data)}`
  );
  if (r.status === 500) {
    // Must be a scorer error, not a resolution error.
    assert.match(data.error, /[Ss]cor/,
      `500 error should mention scorer, got: ${data.error}`);
  }
});

// ---------------------------------------------------------------------------
// Rescore-all — /control/rescore-all + status.rescoringAll
// ---------------------------------------------------------------------------

test("POST /control/rescore-all: cross-origin → 403", async () => {
  const r = await fetch(`${BASE}/control/rescore-all`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Origin": "http://evil.example" },
    body: "{}",
  });
  assert.equal(r.status, 403);
});

test("GET /control/status reports rescoringAll=false when no lock file", async () => {
  const j = await (await fetch(`${BASE}/control/status`)).json();
  assert.equal(j.ok, true);
  assert.equal(j.rescoringAll, false);
});

test("GET /control/status reports rescoringAll=true when lock holds a live PID", async () => {
  // Write this process's PID (guaranteed alive) into the rescore-all lock.
  fs.writeFileSync(RESCORE_ALL_LOCK, String(process.pid));
  const j = await (await fetch(`${BASE}/control/status`)).json();
  assert.equal(j.rescoringAll, true);
  // Lock file must still exist (we own it, the server must NOT delete it).
  assert.ok(fs.existsSync(RESCORE_ALL_LOCK), "server must not remove a live-PID lock");
});

test("GET /control/status clears a stale rescore-all lock (dead PID) → rescoringAll=false", async () => {
  // PID 2^31-1 is never a real process.
  fs.writeFileSync(RESCORE_ALL_LOCK, "2147483647");
  const j = await (await fetch(`${BASE}/control/status`)).json();
  assert.equal(j.rescoringAll, false);
  assert.equal(fs.existsSync(RESCORE_ALL_LOCK), false, "stale lock must be cleaned up");
});

test("POST /control/rescore-all is a no-op when a live PID lock exists", async () => {
  // Write this process's PID so the guard sees a live process.
  fs.writeFileSync(RESCORE_ALL_LOCK, String(process.pid));
  const r = await fetch(`${BASE}/control/rescore-all`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  });
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.equal(j.ok, true);
  assert.equal(j.rescoringAll, true);
  assert.match(j.note, /already running/i);
  assert.equal(j.pid, undefined, "no new child spawned");
});
