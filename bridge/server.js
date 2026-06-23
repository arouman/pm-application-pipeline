/**
 * bridge/server.js — Job Discovery Bridge Server v2
 *
 * Localhost backend that:
 *  - Queries public ATS job board APIs for Rob's target companies (GET /discover)
 *  - Accepts job URL intake, deduplicates via the 6-month ledger, stages builds
 *    (POST /intake, GET /queue, GET /ledger, POST /ledger/mark)
 *  - Serves a minimal intake UI at GET /
 *
 * Usage:
 *   node bridge/server.js              # port 8787 (default)
 *   node bridge/server.js --port 9000  # explicit port
 *   PORT=9000 node bridge/server.js    # env var override
 *
 * Requires Node 18+ (global fetch) and no npm dependencies.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");
const HOME = process.env.HOME || homedir();
const TARGETS_PATH = path.join(__dirname, "targets.json");
const INTAKE_HTML_PATH = path.join(__dirname, "intake.html");
// Data-file paths are env-overridable so the test suite can point at a temp
// sandbox instead of clobbering Rob's real queue/ledger. Defaults = production.
const QUEUE_PATH = process.env.QUEUE_PATH || path.join(REPO, "applied/_queue/queue.json");
const LEDGER_PATH = process.env.LEDGER_PATH || path.join(REPO, "applied/applied-ledger.json");
const JDS_DIR = process.env.JDS_DIR || path.join(REPO, "applied/_queue/jds");
const QUEUE_PY = path.join(REPO, "scripts/lib/queue.py");
const LEDGER_PY = path.join(REPO, "scripts/lib/ledger.py");
// Rob's pass-feedback log — the training signal the watcher's fit-scorer reads
const FEEDBACK_PATH = process.env.FEEDBACK_PATH || path.join(REPO, "applied/_queue/fit-feedback.json");
const PAUSE_FILE = process.env.PAUSE_FILE || path.join(REPO, "applied/_queue/.paused-until");
const RUN_BATCH = path.join(REPO, "scripts/run-batch.sh");
const BATCH_LOG = path.join(REPO, "applied/_queue/bridge-batch.log");
// Single canonical lockfile written by run-batch.sh (flock + PID). The bridge
// reads this to decide whether to spawn, rather than maintaining a separate
// lockfile — this fixes the 3-lockfile inconsistency that allowed double-spawns.
const BATCH_LOCK = path.join(REPO, "applied/_queue/.run-batch.lock");
const STAGE_LOG  = path.join(REPO, "applied/_queue/stage.log");
// On-demand "Search for roles" — runs scripts/watch-jobs.py --once detached.
// The lock holds the spawned PID so GET /control/status can report `scanning`
// (PID-liveness, same self-healing pattern as BATCH_LOCK).
const WATCH_SCRIPT = path.join(REPO, "scripts/watch-jobs.py");
const SCAN_LOCK = process.env.SCAN_LOCK || path.join(REPO, "applied/_queue/.manual-scan.lock");
const SCAN_LOG  = path.join(REPO, "applied/_queue/manual-scan.log");
// Rescore-all — bulk re-scorer for every active ledger row.
const RESCORE_ALL_SCRIPT = path.join(REPO, "scripts/rescore-all.py");
const RESCORE_ALL_LOCK = process.env.RESCORE_ALL_LOCK || path.join(REPO, "applied/_queue/.rescore-all.lock");
const RESCORE_ALL_LOG  = path.join(REPO, "applied/_queue/rescore-all.log");
const CHROME_SH  = path.join(REPO, "scripts/chrome-debug.sh");
// Headless Chrome binary used by the JD-fetch fallback to render JS-only
// careers pages (Phenom/BCG, custom SPAs). Already installed; no npm dep.
const CHROME_BIN = [
  process.env.CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
].find(p => p && fs.existsSync(p)) || "google-chrome";
const STAGE_JS   = path.join(REPO, "scripts/stage-apps.js");
const WATCH_PLIST_SRC  = path.join(REPO, "scripts/com.robstout.applications.watch.plist");
const WATCH_PLIST_DEST = path.join(HOME, "Library/LaunchAgents/com.robstout.applications.watch.plist");
const WATCH_LABEL = "com.robstout.applications.watch";

/**
 * Title keywords used to filter roles down to design/PM-relevant matches.
 * Case-insensitive substring match against the job title.
 * Update this list as Rob's search focus shifts.
 */
const TITLE_KEYWORDS = [
  "product designer",
  "design strateg",
  "service design",
  "experience design",
  // Match "UX Designer", "UX Researcher", "UX/UI" but not "Linux" or "luxury".
  // We check the title as a word-boundary-ish match by requiring "ux" to appear
  // at the start of the string OR be preceded by a space, comma, or slash.
  // Implemented via the regex in matchesTargetTitle() rather than a plain substring.
  "product manager",
  "design lead",
  "design director",
  "ai experience",
  "ai product design",
  "staff designer",
  "principal designer",
  "head of design",
  "vp of design",
  "vp, design",
];

// ---------------------------------------------------------------------------
// Port resolution
// ---------------------------------------------------------------------------

function resolvePort() {
  // --port flag takes precedence, then $PORT env var, then default
  const flagIdx = process.argv.indexOf("--port");
  if (flagIdx !== -1 && process.argv[flagIdx + 1]) {
    return parseInt(process.argv[flagIdx + 1], 10);
  }
  if (process.env.PORT) {
    return parseInt(process.env.PORT, 10);
  }
  return 8787;
}

const PORT = resolvePort();

// ---------------------------------------------------------------------------
// CORS headers — permissive so the Chrome extension can call us freely
// ---------------------------------------------------------------------------

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

// ---------------------------------------------------------------------------
// ATS fetchers — one per platform
// ---------------------------------------------------------------------------

/**
 * Fetch all jobs from a Greenhouse job board.
 * API: https://boards-api.greenhouse.io/v1/boards/{slug}/jobs
 * Returns normalized role objects.
 */
async function fetchGreenhouse(company) {
  const url = `https://boards-api.greenhouse.io/v1/boards/${company.slug}/jobs`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const jobs = data.jobs ?? [];

  return jobs.map((j) => ({
    company: company.name,
    title: j.title ?? "",
    location: j.location?.name ?? "",
    url: j.absolute_url ?? "",
    ats: "greenhouse",
    jobId: String(j.id ?? ""),
    tier: company.tier,
  }));
}

/**
 * Fetch all jobs from a Lever job board.
 * API: https://api.lever.co/v0/postings/{slug}?mode=json
 * Returns normalized role objects.
 */
async function fetchLever(company) {
  const url = `https://api.lever.co/v0/postings/${company.slug}?mode=json`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error("Unexpected Lever response shape");

  return data.map((j) => ({
    company: company.name,
    title: j.text ?? "",
    location: j.categories?.location ?? j.categories?.team ?? "",
    url: j.hostedUrl ?? "",
    ats: "lever",
    jobId: j.id ?? "",
    tier: company.tier,
  }));
}

/**
 * Fetch all jobs from an Ashby job board.
 * API: https://api.ashbyhq.com/posting-api/job-board/{slug}
 * Returns normalized role objects.
 */
async function fetchAshby(company) {
  const url = `https://api.ashbyhq.com/posting-api/job-board/${company.slug}?includeCompensation=true`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const jobs = data.jobs ?? [];

  return jobs.map((j) => ({
    company: company.name,
    title: j.title ?? "",
    location: j.isRemote ? "Remote" : (j.location ?? ""),
    url: j.jobUrl ?? "",
    ats: "ashby",
    jobId: j.id ?? "",
    tier: company.tier,
  }));
}

/** Dispatches to the correct fetcher based on company.ats. */
async function fetchCompany(company) {
  switch (company.ats) {
    case "greenhouse":
      return fetchGreenhouse(company);
    case "lever":
      return fetchLever(company);
    case "ashby":
      return fetchAshby(company);
    default:
      throw new Error(`Unknown ATS: ${company.ats}`);
  }
}

// ---------------------------------------------------------------------------
// Title filter
// ---------------------------------------------------------------------------

/**
 * Returns true if a job title matches any of the configured keyword signals.
 * Most keywords use plain substring matching (case-insensitive).
 * "UX" is matched with a word-boundary pattern so "Linux" and "luxury" don't
 * trigger a false positive — we require "ux" to be preceded by a space,
 * slash, comma, or the start of the string, and followed by a non-alpha char
 * or end of string.
 */
function matchesTargetTitle(title) {
  const lower = title.toLowerCase();
  // Special-case "ux" with a pseudo word-boundary check
  if (/(?:^|[\s,/])(ux)(?:[^a-z]|$)/.test(lower)) return true;
  return TITLE_KEYWORDS.some((kw) => lower.includes(kw));
}

// ---------------------------------------------------------------------------
// /discover handler
// ---------------------------------------------------------------------------

/**
 * Reads targets.json, fetches all companies in parallel (with per-company
 * error isolation), filters to target titles, and returns sorted results.
 *
 * Query params:
 *   ?company=Anthropic   — filter to a single company (case-insensitive)
 *   ?title=designer      — substring filter on job title (case-insensitive)
 */
async function handleDiscover(req, res) {
  // Parse query string
  const urlObj = new URL(req.url, `http://localhost:${PORT}`);
  const companyFilter = urlObj.searchParams.get("company")?.toLowerCase() ?? null;
  const titleFilter = urlObj.searchParams.get("title")?.toLowerCase() ?? null;

  // Load targets from disk on every request so edits are live without restart
  let targets;
  try {
    const raw = fs.readFileSync(TARGETS_PATH, "utf8");
    targets = JSON.parse(raw).companies ?? [];
  } catch (err) {
    sendJson(res, 500, { ok: false, error: "Failed to load targets.json", detail: err.message });
    return;
  }

  // Apply company filter before fetching (saves unnecessary network calls)
  const targetList = companyFilter
    ? targets.filter((c) => c.name.toLowerCase().includes(companyFilter))
    : targets;

  // Fetch all companies in parallel, isolate failures per company
  const results = await Promise.allSettled(targetList.map(fetchCompany));

  const allRoles = [];
  const errors = [];

  results.forEach((result, idx) => {
    const company = targetList[idx];
    if (result.status === "fulfilled") {
      allRoles.push(...result.value);
    } else {
      errors.push({ company: company.name, error: result.reason?.message ?? "Unknown error" });
    }
  });

  // Filter to target titles
  let filtered = allRoles.filter((role) => matchesTargetTitle(role.title));

  // Apply optional title substring filter from query param
  if (titleFilter) {
    filtered = filtered.filter((r) => r.title.toLowerCase().includes(titleFilter));
  }

  // Sort: tier ascending, then company name alphabetically
  filtered.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    return a.company.localeCompare(b.company);
  });

  sendJson(res, 200, {
    count: filtered.length,
    roles: filtered,
    errors,
  });
}

// ---------------------------------------------------------------------------
// Intake helpers — URL parsing, ATS resolution, dedup, enqueue
// ---------------------------------------------------------------------------

/**
 * Normalise a string for use in a ledger key or folder name:
 * lowercase, strip punctuation (keep hyphens), collapse whitespace → hyphens.
 */
function normStr(s) {
  return s
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .trim();
}

/**
 * Derive the canonical ledger key from ats+jobId (preferred) or company+title.
 */
function canonicalKey(ats, jobId, company, title) {
  if (ats && jobId) return `${ats}:${jobId}`;
  return `${normStr(company)}|${normStr(title)}`;
}

/**
 * Parse a job posting URL into {ats, slug, jobId, normalizedUrl}.
 * Returns null if no known pattern matches.
 *
 * Supported patterns:
 *   Greenhouse board:  job-boards.greenhouse.io/<slug>/jobs/<id>
 *                      boards.greenhouse.io/<slug>/jobs/<id>
 *   Greenhouse embed:  ?gh_jid=<id>  (slug guessed from targets.json hostname)
 *   Ashby:             jobs.ashbyhq.com/<slug>/<uuid>
 *   Lever:             jobs.lever.co/<slug>/<id>
 */
function parseJobUrl(rawUrl, targets) {
  let u;
  try { u = new URL(rawUrl); } catch { return null; }

  const host = u.hostname.toLowerCase();
  const parts = u.pathname.replace(/^\//, "").split("/");

  // Greenhouse board URLs (two variants)
  if (host === "job-boards.greenhouse.io" || host === "boards.greenhouse.io") {
    // /slug/jobs/id
    if (parts.length >= 3 && parts[1] === "jobs") {
      return { ats: "greenhouse", slug: parts[0], jobId: parts[2],
               normalizedUrl: rawUrl };
    }
  }

  // Greenhouse embedded (gh_jid query param — common on company career pages)
  const ghJid = u.searchParams.get("gh_jid");
  if (ghJid) {
    // Try to guess slug from host via targets.json
    const matched = targets.find((t) =>
      t.ats === "greenhouse" && rawUrl.toLowerCase().includes(t.slug.toLowerCase())
    );
    const slug = matched?.slug ?? null;
    return { ats: "greenhouse", slug, jobId: ghJid, normalizedUrl: rawUrl };
  }

  // Ashby
  if (host === "jobs.ashbyhq.com") {
    // /slug/uuid
    if (parts.length >= 2) {
      return { ats: "ashby", slug: parts[0], jobId: parts[1],
               normalizedUrl: rawUrl };
    }
  }

  // Lever
  if (host === "jobs.lever.co") {
    // /slug/id
    if (parts.length >= 2) {
      return { ats: "lever", slug: parts[0], jobId: parts[1],
               normalizedUrl: rawUrl };
    }
  }

  // Workday — the biggest enterprise ATS. Public posting URLs look like
  //   https://<tenant>.wd<N>.myworkdayjobs.com/<lang>/<site>/job/<Loc>/<Title>_<JR-id>
  // (the <lang> segment is optional). We key on the JR-/R-/REQ- requisition
  // token because it's the stable id Workday exposes (`jobReqId` in the CXS
  // JSON); falling back to the last path segment if no token is present so the
  // entry is still collision-proof. slug = "<tenant>/<site>" carries exactly
  // what fetchJdContent needs to build the CXS API URL without re-parsing.
  if (/\.wd\d+\.myworkdayjobs\.com$/.test(host) || host.endsWith(".myworkdayjobs.com")) {
    const jobIdx = parts.indexOf("job");
    // A real posting always has a /job/ segment with a site segment before it.
    if (jobIdx >= 1 && parts.length > jobIdx + 1) {
      const tenant = host.split(".")[0];
      const site = parts[jobIdx - 1];
      const lastSeg = parts[parts.length - 1];
      // Prefer the trailing requisition token (JR…/R…/REQ…) — anchored on the
      // "_"/"-" separator so "…Engineer_JR1997214" yields "JR1997214", not "r…".
      const m = lastSeg.match(/(?:^|[_-])((?:JR|REQ|R)-?\d[\w-]*)$/i);
      const jobId = m ? m[1] : lastSeg;
      return { ats: "workday", slug: `${tenant}/${site}`, jobId,
               normalizedUrl: rawUrl };
    }
  }

  // careers.bcg.com (Phenom-hosted) — the watcher already writes ledger keys as
  //   bcg:<numericId>  (ats:"bcg", jobId:"<digits>") for URLs like
  //   careers.bcg.com/global/en/job/<digits>/<Slug>.
  // We MUST reproduce that exact shape here so a manual add of the same URL
  // dedupes against the watcher-created entry (canonicalKey → "bcg:<digits>").
  // Scoped tightly to careers.bcg.com + a numeric /job/<digits>/ segment so it
  // never catches frog (/careers/jobs/<hex>-…, no numeric /job/<digits>/), which
  // must keep flowing through the generic web: fallback below.
  if (host === "careers.bcg.com") {
    const jobIdx = parts.indexOf("job");
    if (jobIdx !== -1 && /^\d+$/.test(parts[jobIdx + 1] ?? "")) {
      return { ats: "bcg", slug: "bcg", jobId: parts[jobIdx + 1],
               normalizedUrl: rawUrl };
    }
  }

  // ReachMee — matches any URL that carries ?rmjob=<digits> or ?job_id=<digits>
  // query params, OR is hosted on *.reachmee.com. This ensures that the
  // human-facing career page URL (e.g. norr%C3%B8na.com/en-GB/careers/?rmjob=718)
  // produces the same canonical key "reachmee:718" as the watcher entry derived
  // from the ReachMee ATS API, preventing the re-scrape / double-build incident.
  const rmjobId = u.searchParams.get("rmjob") || u.searchParams.get("job_id");
  if (rmjobId && /^\d+$/.test(rmjobId)) {
    return { ats: "reachmee", slug: host, jobId: rmjobId, normalizedUrl: rawUrl };
  }
  if (host.endsWith("reachmee.com")) {
    // Internal reachmee.com URL — check both param names
    for (const param of ["job_id", "rmjob"]) {
      const val = u.searchParams.get(param);
      if (val && /^\d+$/.test(val)) {
        return { ats: "reachmee", slug: host, jobId: val, normalizedUrl: rawUrl };
      }
    }
  }

  // Fallback: an unrecognised careers host (frog.co, careers.bcg.com, Taleo,
  // custom sites…). Build a canonical, host-less id from the path + significant
  // query + hash. HOST is intentionally excluded so that
  //   https://www.frog.co/careers/jobs/<uuid>  and
  //   https://frog.co/careers/jobs/<uuid>
  // both produce the same key "web:careers/jobs/<uuid>", matching the form the
  // live queue uses after the 2026-06-17 host-less cleanup.
  // Tracking params are dropped; job-id params (gh_jid, rmjob, etc.) are kept
  // so hash-routed SPAs and query-keyed postings still collapse correctly.
  // slug retains the real host for fetching (HTTP requests need the actual host).
  const isTracking = (k) => /^utm_/i.test(k) ||
    ["gclid", "fbclid", "ref", "src", "source", "mc_cid", "mc_eid"].includes(k.toLowerCase());
  const kept = [...u.searchParams]
    .filter(([k]) => !isTracking(k))
    .map(([k, v]) => `${k}=${v}`)
    .sort();
  // Path only: strip leading slash so the key starts with the first path segment.
  const pathPart = u.pathname.replace(/\/+$/, "").replace(/^\/+/, "");
  const id = pathPart +
    (kept.length ? "?" + kept.join("&") : "") + (u.hash || "");
  if (id) {
    return { ats: "web", slug: host, jobId: id, normalizedUrl: rawUrl };
  }
  return null;
}

/** Decode the handful of HTML entities that show up in <title>/og:title. */
function decodeEntities(s) {
  return s
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0?39;|&#x27;/gi, "'")
    .replace(/&nbsp;/g, " ");
}

/**
 * Pull a human role title out of raw HTML for the non-ATS fallback.
 * Prefers og:title, then <title>; strips trailing brand/section segments
 * ("Role | Careers | frog" → "Role"). Returns "" if nothing usable.
 */
function extractHtmlTitle(html) {
  if (!html) return "";
  const og =
    html.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:title["']/i);
  let t = og?.[1] || html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || "";
  t = decodeEntities(t).trim();
  // Split on pipe / en-/em-dash / middot separators (NOT a plain hyphen, which
  // appears inside real titles like "Front-End"). Keep the first segment.
  return t.split(/\s+[|–—·]\s+/)[0].trim();
}

/**
 * Rough count of human-visible text in raw HTML — used to decide whether a
 * static fetch returned a real JD or just an empty JS shell. Strips <script>/
 * <style> bodies and all tags, collapses whitespace, returns the length.
 */
function visibleTextLength(html) {
  if (!html) return 0;
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim().length;
}

/**
 * Render a URL with headless Chrome and return the post-JS DOM as a string
 * (""  on any failure). This is the last-resort fetch for JS-rendered careers
 * pages where a plain fetch() returns an empty shell. Flags verified live on
 * this machine (Chrome 149): `--headless --dump-dom` prints the rendered DOM to
 * stdout; `--virtual-time-budget` lets pending JS settle before the dump. We
 * give spawnSync its own 20s timeout (the shell `timeout` binary isn't present
 * on macOS) and a generous maxBuffer — rendered career pages can exceed 1.5 MB.
 */
function renderHeadless(url) {
  try {
    const r = spawnSync(CHROME_BIN, [
      "--headless",
      "--disable-gpu",
      "--dump-dom",
      "--virtual-time-budget=8000",
      url,
    ], { encoding: "utf8", timeout: 20_000, maxBuffer: 32 * 1024 * 1024 });
    return r.stdout || "";
  } catch (_) {
    return "";
  }
}

/**
 * Fetch the JD content from the ATS API.
 * Returns { title, company, location, content } where content is a string
 * (JSON-serialised API response, or raw HTML for fallback).
 */
async function fetchJdContent(parsed, rawUrl) {
  try {
    if (parsed.ats === "greenhouse" && parsed.slug && parsed.jobId) {
      const apiUrl = `https://boards-api.greenhouse.io/v1/boards/${parsed.slug}/jobs/${parsed.jobId}?content=true`;
      const res = await fetch(apiUrl, { signal: AbortSignal.timeout(12_000) });
      if (res.ok) {
        const data = await res.json();
        return {
          title: data.title ?? "",
          company: data.departments?.[0]?.name ?? parsed.slug,
          location: data.location?.name ?? "",
          content: JSON.stringify(data),
          ext: "json",
        };
      }
    }

    if (parsed.ats === "ashby" && parsed.slug && parsed.jobId) {
      const boardUrl = `https://api.ashbyhq.com/posting-api/job-board/${parsed.slug}`;
      const res = await fetch(boardUrl, { signal: AbortSignal.timeout(12_000) });
      if (res.ok) {
        const data = await res.json();
        const jobs = data.jobs ?? [];
        // Match the UUID prefix (Ashby IDs can be full UUID)
        const job = jobs.find((j) =>
          j.id === parsed.jobId || j.id.startsWith(parsed.jobId)
        );
        if (job) {
          return {
            title: job.title ?? "",
            company: data.organization?.name ?? parsed.slug,
            location: job.isRemote ? "Remote" : (job.location ?? ""),
            content: JSON.stringify(job),
            ext: "json",
          };
        }
      }
    }

    if (parsed.ats === "lever" && parsed.slug && parsed.jobId) {
      const apiUrl = `https://api.lever.co/v0/postings/${parsed.slug}/${parsed.jobId}`;
      const res = await fetch(apiUrl, { signal: AbortSignal.timeout(12_000) });
      if (res.ok) {
        const data = await res.json();
        return {
          title: data.text ?? "",
          company: parsed.slug,
          location: data.categories?.location ?? "",
          content: JSON.stringify(data),
          ext: "json",
        };
      }
    }

    // Workday — hit the public CXS single-job JSON API. The public posting URL
    //   …/<lang>/<site>/job/<tail>  maps to the data endpoint
    //   …/wday/cxs/<tenant>/<site>/job/<tail>   (verified live against NVIDIA).
    // We rebuild it from the raw URL (not parsed.jobId) because the CXS path
    // needs the full /job/<Location>/<Title>_<JR> tail, and a plain GET returns
    // { jobPostingInfo: { title, jobDescription(HTML), location, jobReqId,
    // startDate, … }, hiringOrganization: { name } }. parsed.slug is
    // "<tenant>/<site>" so we already know both halves.
    if (parsed.ats === "workday" && parsed.slug) {
      const [tenant, site] = parsed.slug.split("/");
      const pu = new URL(rawUrl);
      const pparts = pu.pathname.replace(/^\//, "").split("/");
      const jobIdx = pparts.indexOf("job");
      if (tenant && site && jobIdx !== -1) {
        const tail = pparts.slice(jobIdx).join("/"); // job/<Loc>/<Title>_<JR>
        const cxsUrl = `${pu.protocol}//${pu.hostname}/wday/cxs/${tenant}/${site}/${tail}`;
        const res = await fetch(cxsUrl, {
          // Workday returns JSON for GET when this Accept header is present;
          // some tenants 415 a bare request, so be explicit.
          headers: { "Accept": "application/json" },
          signal: AbortSignal.timeout(12_000),
        });
        if (res.ok) {
          const data = await res.json();
          const info = data.jobPostingInfo ?? {};
          return {
            title: info.title ?? "",
            // hiringOrganization.name is often an internal entity ("2100 NVIDIA
            // USA"); prefer the clean tenant label, fall back to the org name.
            company: tenant || data.hiringOrganization?.name || "",
            location: info.location ?? "",
            content: JSON.stringify(data),
            ext: "json",
          };
        }
      }
    }
  } catch (_) {
    // fall through to HTML → headless fallback
  }

  // ── Fetch cascade: ATS JSON API (above) → static HTML → headless render ──
  // Step 2: raw HTML fetch — cheap, works for server-rendered pages.
  let staticResult = null;
  try {
    const res = await fetch(rawUrl, {
      // A browser-ish UA avoids the bot-blank some career sites serve to curl.
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" },
      signal: AbortSignal.timeout(15_000),
    });
    const html = await res.text();
    staticResult = { title: extractHtmlTitle(html), company: parsed?.slug ?? "",
                     location: "", content: html, ext: "html" };
  } catch (err) {
    staticResult = { title: "", company: parsed?.slug ?? "", location: "",
                     content: `fetch failed: ${err.message}`, ext: "txt" };
  }

  // Step 3: headless render — only when the static result looks thin (no title,
  // OR very little visible text → almost certainly a JS-only shell). Rendering
  // is slow + spawns Chrome, so we gate it behind this cheap heuristic. On any
  // failure (Chrome missing, timeout, still-empty DOM) we keep the static
  // result — the headless path can only improve, never regress, the outcome.
  const thin = !staticResult.title ||
    visibleTextLength(staticResult.content) < 600;
  if (thin) {
    const rendered = renderHeadless(rawUrl);
    if (rendered) {
      const rTitle = extractHtmlTitle(rendered);
      // Only adopt the rendered DOM if it's actually richer than what we had.
      if (rTitle || visibleTextLength(rendered) > visibleTextLength(staticResult.content)) {
        return { title: rTitle || staticResult.title,
                 company: parsed?.slug ?? "", location: "",
                 content: rendered, ext: "html" };
      }
    }
  }

  return staticResult;
}

/**
 * Derive city label from a frog.co /careers/jobs/<hex>-<city>-<family>-<digits> URL.
 * Returns title-cased city string (e.g. "San Francisco"), or "" when the slug
 * can't be parsed confidently. Never returns garbage — empty string is always safe.
 * Only called for frog.co URLs where jd.location is empty.
 */
function parseFrogLocation(rawUrl) {
  try {
    const m = rawUrl.match(/\/careers\/jobs\/[0-9a-f]+-(.+)/);
    if (!m) return "";
    // URL-decode (%20 → space) then split on "-"
    const rest = decodeURIComponent(m[1]);
    const FAMILY = new Set(["design", "technology", "strategy", "product", "management", "consulting"]);
    const parts = rest.split("-");
    const cityParts = [];
    for (const p of parts) {
      if (FAMILY.has(p.toLowerCase())) break;
      if (p) cityParts.push(p);
    }
    if (!cityParts.length) return "";
    // Title-case each word
    return cityParts.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ");
  } catch (_) {
    return "";
  }
}

/**
 * Guess master (PM vs Design) from role title — per CLAUDE.md master-selection rule.
 */
function guessMaster(title) {
  const t = title.toLowerCase();
  if (/design|designer|ux/.test(t)) return "Design";
  return "PM";
}

/**
 * Build a safe folder-name token from a string (spaces → hyphens, strip specials).
 */
function folderToken(s) {
  return s.replace(/[^\w\s-]/g, "").replace(/\s+/g, "-").replace(/-+/g, "-");
}

/**
 * Shell out to ledger.py check and return parsed result.
 * Returns { duplicate: bool, entry: object|null }.
 */
function ledgerCheck(key) {
  const r = spawnSync("python3", [LEDGER_PY, LEDGER_PATH, "check", key],
                      { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`ledger check failed: ${r.stderr}`);
  return JSON.parse(r.stdout.trim());
}

/**
 * Shell out to ledger.py add with a full entry object.
 */
function ledgerAdd(entry) {
  const r = spawnSync(
    "python3",
    [LEDGER_PY, LEDGER_PATH, "add", "--json", JSON.stringify(entry)],
    { encoding: "utf8" }
  );
  if (r.status !== 0) throw new Error(`ledger add failed: ${r.stderr}`);
}

/**
 * Shell out to queue.py add with a queue item object.
 */
function queueAdd(item) {
  const r = spawnSync(
    "python3",
    [QUEUE_PY, QUEUE_PATH, "add", "--json", JSON.stringify(item)],
    { encoding: "utf8" }
  );
  if (r.status !== 0) throw new Error(`queue add failed: ${r.stderr}`);
  return r.stdout.trim();
}

/**
 * Spawn run-batch.sh detached (stdout+stderr → BATCH_LOG).
 *
 * Single-instance guard: run-batch.sh holds a flock on .run-batch.lock for its
 * entire lifetime and writes its PID into it. We check that PID for liveness
 * before spawning a new instance. If the PID is stale (process gone) we proceed.
 * We do NOT write or delete the lockfile — run-batch.sh owns it exclusively.
 */
function spawnBatchIfIdle() {
  if (fs.existsSync(BATCH_LOCK)) {
    const raw = fs.readFileSync(BATCH_LOCK, "utf8").trim();
    const pid = parseInt(raw, 10);
    if (!isNaN(pid) && pid > 0) {
      try {
        process.kill(pid, 0); // throws ESRCH if process is gone
        console.log(`[spawnBatchIfIdle] run-batch.sh already running (pid ${pid}) — skipping spawn`);
        return; // still running
      } catch (_) {
        // Process gone — stale lock. run-batch.sh will overwrite it when it starts.
        console.log(`[spawnBatchIfIdle] stale lock (pid ${pid} gone) — spawning new run-batch`);
      }
    }
  }

  const log = fs.openSync(BATCH_LOG, "a");
  const child = spawn("bash", [RUN_BATCH], {
    detached: true,
    stdio: ["ignore", log, log],
  });
  child.unref();
  console.log(`[spawnBatchIfIdle] spawned run-batch.sh (pid ${child.pid})`);
}

/**
 * Best-effort: read the build's JD keyword-coverage % from its application.md
 * so the ledger can show a match score. Returns an int (0–100) or null.
 */
function readBuildCoverage(item) {
  try {
    if (!item.date || !item.folderName) return null;
    const md = fs.readFileSync(
      path.join(REPO, "applied", item.date, item.folderName, "application.md"),
      "utf8");
    const m = md.match(/Coverage:\**\s*(\d{1,3})\s*%/i);
    return m ? parseInt(m[1], 10) : null;
  } catch (_) { return null; }
}

/**
 * Reconcile queue→ledger: any queue item with status "built" that is missing
 * a ledger entry (or has one that's still "queued") gets upserted to "built".
 *
 * This is the simplest sync strategy: we call it in GET /queue so the ledger
 * stays current without a separate hook in run-batch.sh. It's idempotent and
 * fast (pure disk reads + flock'd write).
 */
function reconcileQueueToLedger() {
  let queueData;
  try {
    queueData = JSON.parse(fs.readFileSync(QUEUE_PATH, "utf8"));
  } catch (_) { return; }

  // A built queue item should show as "built" in the ledger. Promote the ledger
  // entry when it's missing or still in a pre-build stage. Inbox-found roles sit
  // at "new" (and a build approval can leave "pending"/"building"), so keying on
  // "queued" alone stranded every inbox-built role at "new" — the Findigs bug.
  const PRE_BUILT = new Set(["queued", "new", "pending", "building"]);
  for (const item of (queueData.items ?? [])) {
    if (item.status !== "built") continue;
    const key = canonicalKey(item.ats, item.jobId, item.company, item.title);
    try {
      const { duplicate, entry } = ledgerCheck(key);
      if (!duplicate || !entry || PRE_BUILT.has(entry.status)) {
        const ledgerEntry = {
          key,
          company: item.company,
          title: item.title,
          ats: item.ats ?? null,
          jobId: item.jobId ?? null,
          applyUrl: item.jdUrl ?? "",
          folder: item.folder ?? null,
          status: "built",
          firstSeen: item.date ?? new Date().toISOString().slice(0, 10),
          appliedDate: null,
          coverage: readBuildCoverage(item),
          fitScore: item.fitScore ?? null,
        };
        ledgerAdd(ledgerEntry);
      }
    } catch (_) {
      // Non-fatal — skip this item
    }
  }
}

// ---------------------------------------------------------------------------
// Route handlers — intake, queue, ledger
// ---------------------------------------------------------------------------

/** GET / — serve intake.html */
function handleRoot(_req, res) {
  try {
    const html = fs.readFileSync(INTAKE_HTML_PATH, "utf8");
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": Buffer.byteLength(html),
      ...CORS_HEADERS,
    });
    res.end(html);
  } catch (err) {
    sendJson(res, 500, { ok: false, error: "intake.html not found", detail: err.message });
  }
}

/** GET /queue — summarised queue items (reconciles ledger first). */
function handleGetQueue(_req, res) {
  // Sync built items to ledger on every poll so the UI stays consistent.
  try { reconcileQueueToLedger(); } catch (_) {}

  let data;
  try {
    data = JSON.parse(fs.readFileSync(QUEUE_PATH, "utf8"));
  } catch (err) {
    sendJson(res, 500, { ok: false, error: "failed to read queue.json", detail: err.message });
    return;
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const STALE_BUILD_SECONDS = parseInt(process.env.STALE_BUILD_SECONDS ?? "1800", 10); // 30 min default — mirrors run-batch.sh
  const items = (data.items ?? []).map((it) => {
    const startedAt = it.startedAt ?? null;
    const elapsedSeconds = (it.status === "building" && startedAt)
      ? nowSec - startedAt
      : null;
    const isStale = elapsedSeconds !== null && elapsedSeconds > STALE_BUILD_SECONDS;
    return {
      id: it.id,
      company: it.company,
      title: it.title,
      status: it.status,
      fitScore: it.fitScore ?? null,
      fitNote: it.fitNote ?? null,
      summary: it.summary ?? it.fitNote ?? null,
      topGap: it.topGap ?? null,
      deadline: it.deadline ?? null,
      ats: it.ats ?? null,
      tier: it.tier ?? null,
      location: it.location ?? null,
      trap: it.trap ?? null,
      folderName: it.folderName ?? null,
      coverage: it.coverage ?? null,
      jdUrl: it.jdUrl ?? null,
      startedAt,
      elapsedSeconds,
      isStale,
    };
  });
  sendJson(res, 200, { count: items.length, items });
}

/** GET /ledger — all ledger entries. */
function handleGetLedger(_req, res) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(LEDGER_PATH, "utf8"));
  } catch (err) {
    sendJson(res, 500, { ok: false, error: "failed to read ledger", detail: err.message });
    return;
  }
  sendJson(res, 200, { count: (data.entries ?? []).length, entries: data.entries ?? [] });
}

/**
 * POST /ledger/mark  body: { key, status?, referral? }
 *
 * Drives the ledger lifecycle dropdown + referral toggle. Either status or
 * referral (or both) must be present. ledger.py records every status change
 * into statusHistory, so the funnel is captured without a second control.
 */
async function handleLedgerMark(req, res) {
  if (isCsrfBlocked(req)) {
    sendJson(res, 403, { ok: false, error: "forbidden origin" });
    return;
  }
  const body = await readBody(req);
  const { key, status, referral } = body;
  if (!key || (!status && referral === undefined)) {
    sendJson(res, 400, { ok: false, error: "key and (status and/or referral) are required" });
    return;
  }
  const args = [LEDGER_PY, LEDGER_PATH, "mark", key];
  if (status) args.push("--status", status);
  if (referral !== undefined) args.push("--referral", referral ? "true" : "false");
  const r = spawnSync("python3", args, { encoding: "utf8" });
  if (r.status !== 0) {
    sendJson(res, 500, { ok: false, error: r.stderr });
    return;
  }
  const markResult = JSON.parse(r.stdout.trim());

  // If the new status is a terminal/dead state, cancel any pending queue build
  // for this role so run-batch doesn't pick it up after the user retired it.
  const DEAD_STATES = new Set(["expired", "passed", "rejected", "withdrew", "no-response"]);
  // States where the queue item hasn't been built yet — skip any of these.
  // NOTE: "building" is intentionally excluded. A live build must not be silently
  // flipped to "skipped" mid-flight; use /control/cancel-build to stop a live build.
  const SKIPPABLE_QUEUE_STATES = new Set(["pending", "new", "error"]);
  let queueSkipped = null;
  if (status && DEAD_STATES.has(status)) {
    try {
      // Resolve this role's apply URL from the ledger so we can also match the
      // queue item by URL — robust across the legacy multi-generation key forms
      // (path-only vs host+path) where canonicalKey alone silently misses.
      let applyUrl = null;
      try {
        const led = JSON.parse(fs.readFileSync(LEDGER_PATH, "utf8"));
        applyUrl = (led.entries ?? []).find((e) => e.key === key)?.applyUrl ?? null;
      } catch (_) {}
      const stripSlash = (u) => (u || "").trim().replace(/\/+$/, "");
      const queueData = JSON.parse(fs.readFileSync(QUEUE_PATH, "utf8"));
      const match = (queueData.items ?? []).find(
        (item) =>
          item.status !== "built" &&
          SKIPPABLE_QUEUE_STATES.has(item.status) &&
          ((applyUrl && stripSlash(item.jdUrl) === stripSlash(applyUrl)) ||
            canonicalKey(item.ats, item.jobId, item.company, item.title) === key)
      );
      if (match) {
        const skipResult = spawnSync(
          "python3", [QUEUE_PY, QUEUE_PATH, "skip", match.id],
          { encoding: "utf8" }
        );
        if (skipResult.status === 0) {
          queueSkipped = match.id;
          console.log(`[ledger/mark] queue item ${match.id} skipped (status→${status})`);
        } else {
          console.warn(`[ledger/mark] queue skip failed for ${match.id}: ${skipResult.stderr}`);
        }
      }
    } catch (err) {
      // Best-effort — a missing or unreadable queue file is not fatal.
      console.warn(`[ledger/mark] queue-skip lookup failed: ${err.message}`);
    }
  }

  sendJson(res, 200, { ...markResult, queueSkipped });
}

/**
 * POST /pass  body: { id?, key?, company?, title?, reason }
 *
 * Rob declines a role AND teaches the engine why. Three effects:
 *  1. The reason is appended to fit-feedback.json — the watcher's fit-scorer
 *     injects these as negative criteria, so similar roles score lower.
 *  2. A pending queue item is marked skipped (never builds).
 *  3. The ledger entry is marked "passed" so it can't resurface or be staged.
 */
async function handlePass(req, res) {
  if (isCsrfBlocked(req)) {
    sendJson(res, 403, { ok: false, error: "forbidden origin" });
    return;
  }
  const body = await readBody(req);
  const reason = (body.reason ?? "").trim();
  if (!reason) {
    sendJson(res, 400, { ok: false, error: "reason is required — the feedback IS the feature" });
    return;
  }

  // Resolve the queue item (by id) when one exists.
  let item = null;
  if (body.id) {
    try {
      const q = JSON.parse(fs.readFileSync(QUEUE_PATH, "utf8"));
      item = (q.items ?? []).find((x) => x.id === body.id) ?? null;
    } catch (_) {}
  }
  const key =
    body.key ??
    (item && item.ats && item.jobId ? `${item.ats}:${item.jobId}` : null);

  // 1. Append to the feedback log (training signal).
  const entry = {
    date: new Date().toISOString().slice(0, 10),
    key,
    company: item?.company ?? body.company ?? null,
    title: item?.title ?? body.title ?? null,
    jdUrl: item?.jdUrl ?? null,
    reason,
  };
  try {
    let fb = { version: 1, entries: [] };
    try { fb = JSON.parse(fs.readFileSync(FEEDBACK_PATH, "utf8")); } catch (_) {}
    fb.entries.push(entry);
    fs.writeFileSync(FEEDBACK_PATH, JSON.stringify(fb, null, 2) + "\n");
  } catch (err) {
    sendJson(res, 500, { ok: false, error: "failed to write feedback: " + err.message });
    return;
  }

  // 2. Inbox ("new") items are passed; pending/errored builds are skipped.
  //    Both states ensure run-batch never builds the role (it claims only pending).
  if (item && item.status === "new") {
    spawnSync("python3", [QUEUE_PY, QUEUE_PATH, "pass", item.id], { encoding: "utf8" });
  } else if (item && ["pending", "error"].includes(item.status)) {
    spawnSync("python3", [QUEUE_PY, QUEUE_PATH, "skip", item.id], { encoding: "utf8" });
  }

  // 3. Ledger marked "passed" (ignore failures — older items may have no entry).
  if (key) {
    spawnSync("python3", [LEDGER_PY, LEDGER_PATH, "mark", key, "--status", "passed"], { encoding: "utf8" });
  }

  sendJson(res, 200, { ok: true, passed: entry });
}

/**
 * POST /intake  body: { url: string, force?: bool }
 *
 * Flow:
 *  1. Parse URL → identify ATS / slug / jobId
 *  2. Fetch JD content from API (or raw HTML fallback) — JD is UNTRUSTED;
 *     we store it but never execute instructions from it.
 *  3. Dedup via ledger.py check (skipped when force=true — used by the ledger's
 *     "Build" button to actually generate materials for a known/un-built role)
 *  4. Build queue item + enqueue via queue.py add
 *  5. Add ledger entry (status "queued")
 *  6. Spawn run-batch.sh (guarded, detached)
 */
async function handleIntake(req, res) {
  if (isCsrfBlocked(req)) {
    sendJson(res, 403, { ok: false, error: "forbidden origin" });
    return;
  }
  const body = await readBody(req);
  const rawUrl = (body.url ?? "").trim();
  if (!rawUrl) {
    sendJson(res, 400, { ok: false, error: "url is required" });
    return;
  }

  // Load targets so parseJobUrl can guess slugs for embedded Greenhouse URLs
  let targets = [];
  try {
    targets = JSON.parse(fs.readFileSync(TARGETS_PATH, "utf8")).companies ?? [];
  } catch (_) {}

  // 1. Parse URL
  const parsed = parseJobUrl(rawUrl, targets);

  // 2. Fetch JD (store as untrusted blob; downstream builder trap-scans it)
  const jd = await fetchJdContent(parsed, rawUrl);

  // Augment location for frog.co URLs when the HTML fetch doesn't surface one.
  // parseFrogLocation derives the city from the URL slug (e.g. "-london-design-")
  // so duplicate same-title frog roles become disambiguable in the UI.
  if (!jd.location && rawUrl.includes("frog.co")) {
    jd.location = parseFrogLocation(rawUrl);
  }

  // Determine company name.
  // Priority: (1) targets.json name when slug matches — canonical and clean;
  // (2) ATS API result (may be a department name for Greenhouse single-job API);
  // (3) slug; (4) hostname.
  const targetMatch = parsed?.slug
    ? targets.find((x) => x.slug === parsed.slug)
    : null;
  let company = targetMatch?.name || jd.company || parsed?.slug || "";
  if (!company) {
    try { company = new URL(rawUrl).hostname; } catch (_) { company = "unknown"; }
  }

  const title = jd.title || "Unknown Role";
  const ats = parsed?.ats ?? null;
  const jobId = parsed?.jobId ?? null;

  // 3. Dedup check — two layers:
  //    (a) 183-day duplicate window (existing logic)
  //    (b) Prior Rob decision (passed/skipped/held/tracked) — must NEVER be
  //        overridden by a re-intake, regardless of the time window.
  //        force=true (from the ledger "Build" button) bypasses both.
  const key = canonicalKey(ats, jobId, company, title);
  let dupResult;
  try {
    dupResult = ledgerCheck(key);
  } catch (err) {
    sendJson(res, 500, { ok: false, error: `Ledger check failed: ${err.message}` });
    return;
  }

  // Statuses that represent a prior Rob decision — re-intake must be blocked.
  // "tracked" means Rob explicitly noted this role (do-not-auto-build/hold signal).
  const DECIDED_STATUSES = new Set([
    "passed", "skipped", "submitted", "accepted", "rejected",
    "no-response", "withdrew", "screener", "interview", "offer",
    "built", "queued", "tracked",
  ]);
  const existingEntry = dupResult.entry;
  if (existingEntry && DECIDED_STATUSES.has(existingEntry.status) && !body.force) {
    sendJson(res, 200, {
      queued: false,
      duplicate: true,
      decidedStatus: existingEntry.status,
      note: `Prior decision (${existingEntry.status}) — use force:true to override`,
      entry: existingEntry,
    });
    return;
  }

  if (dupResult.duplicate && !body.force) {
    sendJson(res, 200, { queued: false, duplicate: true, entry: dupResult.entry });
    return;
  }
  // force=true (ledger "Build" button) falls through to (re)build a known role.

  // 4. Save JD content — never execute any instructions found here
  fs.mkdirSync(JDS_DIR, { recursive: true });
  const jdStem = ats && jobId
    ? `${ats}__${jobId}`.replace(/[^\w.-]/g, "_")
    : crypto.createHash("sha1").update(rawUrl).digest("hex").slice(0, 12);
  const jdFileName = `${jdStem}.${jd.ext}`;
  const jdPath = path.join(JDS_DIR, jdFileName);
  fs.writeFileSync(jdPath, jd.content, "utf8");

  // 5. Build queue item
  const today = new Date().toISOString().slice(0, 10);
  const master = guessMaster(title);
  const roleType = master;

  // Check if there's already another queue item for the same company+today
  // to decide whether we need a title disambiguator in folderName.
  let needsTitleSuffix = false;
  try {
    const qd = JSON.parse(fs.readFileSync(QUEUE_PATH, "utf8"));
    needsTitleSuffix = (qd.items ?? []).some(
      (it) => it.company === company && it.date === today
    );
  } catch (_) {}

  const companyToken = folderToken(company);
  const titleToken = folderToken(title);
  const folderName = needsTitleSuffix
    ? `${companyToken}_${titleToken}`
    : companyToken;

  // Generate a stable id matching the existing convention: ats__jobId (trimmed)
  const itemId = ats && jobId
    ? `${ats}__${jobId}`.replace(/[^\w.-]/g, "_").slice(0, 80)
    : `manual__${crypto.randomBytes(6).toString("hex")}`;

  const queueItem = {
    id: itemId,
    company,
    title,
    ats,
    slug: parsed?.slug ?? null,
    jobId,
    jdUrl: rawUrl,
    location: jd.location ?? "",
    jdPath,
    master,
    roleType,
    tier: targets.find((t) => t.slug === parsed?.slug)?.tier ?? null,
    fitScore: null,       // intake items are Rob-vouched; scorer runs separately
    fitNote: null,
    trap: null,
    folderName,
    date: today,
    status: "pending",
  };

  // Enqueue via queue.py add
  try {
    queueAdd(queueItem);
  } catch (err) {
    sendJson(res, 500, { ok: false, error: `Queue add failed: ${err.message}` });
    return;
  }

  // 6. Add ledger entry (status "queued")
  const ledgerEntry = {
    key,
    company,
    title,
    ats,
    jobId,
    applyUrl: rawUrl,
    folder: null,
    status: "queued",
    firstSeen: today,
    appliedDate: null,
  };
  try {
    ledgerAdd(ledgerEntry);
  } catch (_) {
    // Non-fatal — queue item already added
  }

  // 7. Trigger build (detached, guarded against double-spawn)
  try { spawnBatchIfIdle(); } catch (_) {}

  sendJson(res, 200, {
    queued: true,
    id: itemId,
    company,
    title,
    key,
    folderName,
    jdPath,
  });
}

// ---------------------------------------------------------------------------
// CSRF guard — blocks cross-origin POST requests from other websites
// ---------------------------------------------------------------------------

/**
 * Returns true (blocked) when the request has an Origin header that is
 * NOT one of the localhost variants we trust.
 *
 * Same-origin requests from intake.html have no Origin header (or localhost).
 * The Chrome extension calls GET /discover only, which is exempt.
 * Any website trying to CSRF our POST routes via a cross-origin fetch will
 * carry their own origin and will be rejected with 403.
 */
function isCsrfBlocked(req) {
  const origin = req.headers["origin"];
  if (!origin) return false; // same-origin page fetches carry no Origin
  const trusted = [`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`];
  if (trusted.includes(origin)) return false;
  // Allow access over Tailscale so Rob can review/approve from his phone: a
  // MagicDNS *.ts.net host, or a tailnet CGNAT IP (100.64.0.0/10), over http or
  // https. The network-level guard (isAllowedClient) already restricts WHO can
  // connect to localhost + the tailnet, and Tailscale encrypts the traffic.
  try {
    const u = new URL(origin);
    const h = u.hostname;
    // MagicDNS host: must END with ".ts.net" AND have at least one label before it
    // (so "ts.net" alone, or "ts.net.evil.com", never matches).
    if (/\.ts\.net$/.test(h) && h.length > ".ts.net".length) return false;
    // Tailnet CGNAT IP: validate the WHOLE hostname as a bare IPv4 literal —
    // no extra labels allowed (blocks "100.64.1.2.attacker.com" attacks).
    const ipParts = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipParts) {
      const [, a, b, c, d] = ipParts.map(Number);
      // All octets must be 0-255, first must be 100, second must be 64-127 (CGNAT /10).
      if (a === 100 && b >= 64 && b <= 127 && c <= 255 && d <= 255) return false;
    }
  } catch (_) { /* malformed Origin → fall through to blocked */ }
  return true;
}

// Is the connecting client allowed at the network level? The bridge binds 0.0.0.0
// so it's reachable over Tailscale, but we only SERVE localhost and the Tailscale
// CGNAT range (100.64.0.0/10). Home-LAN / public clients are rejected outright.
function clientIp(req) {
  let ip = (req.socket && req.socket.remoteAddress) || "";
  if (ip.startsWith("::ffff:")) ip = ip.slice(7); // IPv4-mapped IPv6 → plain v4
  return ip;
}
function isAllowedClient(req) {
  const ip = clientIp(req);
  if (ip === "127.0.0.1" || ip === "::1") return true;
  const m = ip.match(/^(\d+)\.(\d+)\./);
  return !!(m && +m[1] === 100 && +m[2] >= 64 && +m[2] <= 127);
}

// ---------------------------------------------------------------------------
// Control handlers — /control/* routes
// ---------------------------------------------------------------------------

/**
 * Probe http://127.0.0.1:9223/json/version with a short timeout.
 * Returns true if the Job Applications Chrome debug port (9223) is reachable.
 */
async function isChromeDebugUp() {
  try {
    const res = await fetch("http://127.0.0.1:9223/json/version",
                            { signal: AbortSignal.timeout(1_500) });
    return res.ok;
  } catch (_) {
    return false;
  }
}

/**
 * Returns true if the watcher LaunchAgent is currently loaded in launchd.
 */
function isWatcherLoaded() {
  const r = spawnSync("launchctl", ["list", WATCH_LABEL], { encoding: "utf8" });
  // launchctl list <label> exits 0 and prints JSON when loaded; non-zero when not.
  return r.status === 0;
}

/**
 * Walk applied/ for YYYY-MM-DD folders; return the most recent one or null.
 */
function latestAppliedDate() {
  const appliedDir = path.join(REPO, "applied");
  try {
    const entries = fs.readdirSync(appliedDir);
    const dates = entries.filter(e => /^\d{4}-\d{2}-\d{2}$/.test(e)).sort();
    return dates.length > 0 ? dates[dates.length - 1] : null;
  } catch (_) {
    return null;
  }
}

/**
 * Returns a brief summary of the queue suitable for the status payload.
 */
function queueSummary() {
  try {
    const data = JSON.parse(fs.readFileSync(QUEUE_PATH, "utf8"));
    const items = data.items ?? [];
    const counts = {};
    for (const it of items) counts[it.status] = (counts[it.status] ?? 0) + 1;
    return { total: items.length, ...counts };
  } catch (_) {
    return { total: 0 };
  }
}

/** GET /control/status */
async function handleControlStatus(_req, res) {
  const [chromeDebug] = await Promise.all([isChromeDebugUp()]);
  const watcher      = isWatcherLoaded();
  const batchRunning = (() => {
    if (!fs.existsSync(BATCH_LOCK)) return false;
    const raw = fs.readFileSync(BATCH_LOCK, "utf8").trim();
    const pid = parseInt(raw, 10);
    if (isNaN(pid)) return false;
    try { process.kill(pid, 0); return true; } catch (_) { return false; }
  })();
  // Is a manual "Search for roles" scan in flight? PID-liveness on SCAN_LOCK;
  // a dead PID means the scan finished — clean the stale lock so it self-heals.
  const scanning = (() => {
    if (!fs.existsSync(SCAN_LOCK)) return false;
    const pid = parseInt(fs.readFileSync(SCAN_LOCK, "utf8").trim(), 10);
    if (isNaN(pid)) return false;
    try { process.kill(pid, 0); return true; }
    catch (_) { try { fs.unlinkSync(SCAN_LOCK); } catch (_) {} return false; }
  })();
  // Is a bulk rescore-all pass in flight? Same PID-liveness + stale-lock self-heal.
  const rescoringAll = (() => {
    if (!fs.existsSync(RESCORE_ALL_LOCK)) return false;
    const pid = parseInt(fs.readFileSync(RESCORE_ALL_LOCK, "utf8").trim(), 10);
    if (isNaN(pid)) return false;
    try { process.kill(pid, 0); return true; }
    catch (_) { try { fs.unlinkSync(RESCORE_ALL_LOCK); } catch (_) {} return false; }
  })();

  // Surface pause state so the UI can explain "why nothing is happening".
  // Validates the file: if the timestamp is missing/corrupt/past it is shown as null.
  const pausedUntil = (() => {
    try {
      if (!fs.existsSync(PAUSE_FILE)) return null;
      const raw = fs.readFileSync(PAUSE_FILE, "utf8").trim();
      const ts = parseInt(raw, 10);
      if (isNaN(ts) || ts <= 0) return null;
      const nowSec = Math.floor(Date.now() / 1000);
      if (ts <= nowSec) return null;  // already past; batch will clear it on next run
      return new Date(ts * 1000).toISOString();
    } catch (_) { return null; }
  })();

  sendJson(res, 200, {
    ok: true,
    chromeDebug,
    watcher,
    batchRunning,
    scanning,
    rescoringAll,
    pausedUntil,
    queueSummary: queueSummary(),
    todayFolder: latestAppliedDate(),
  });
}

/** POST /control/chrome — spawn chrome-debug.sh detached */
async function handleControlChrome(req, res) {
  if (isCsrfBlocked(req)) {
    sendJson(res, 403, { ok: false, error: "CSRF: origin not allowed" });
    return;
  }
  // Check if already up — if so, bring its front-most tab's window forward so
  // Rob can find the staging window (it lives outside his regular Chrome).
  const already = await isChromeDebugUp();
  if (already) {
    try {
      const tabs = await (await fetch("http://127.0.0.1:9223/json")).json();
      const tab = tabs.find((t) => t.type === "page");
      if (tab) {
        const ws = new WebSocket(tab.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => {
          ws.onopen = resolve;
          ws.onerror = reject;
          setTimeout(reject, 3000);
        });
        ws.send(JSON.stringify({ id: 1, method: "Page.bringToFront" }));
        await new Promise((r) => setTimeout(r, 300));
        ws.close();
      }
      sendJson(res, 200, { ok: true, note: "Staging Chrome is already running — brought its window to the front." });
    } catch {
      sendJson(res, 200, { ok: true, note: "Job Applications Chrome already running on port 9223 — nothing to do." });
    }
    return;
  }
  const log = fs.openSync(BATCH_LOG, "a");
  const child = spawn("bash", [CHROME_SH], { detached: true, stdio: ["ignore", log, log] });
  child.unref();
  sendJson(res, 200, {
    ok: true,
    note: "Chrome launching — give it a few seconds. First time? Log into job sites once in that window; it remembers.",
    pid: child.pid,
  });
}

/** POST /control/stage  body: { date?, only?, dryRun? } */
async function handleControlStage(req, res) {
  if (isCsrfBlocked(req)) {
    sendJson(res, 403, { ok: false, error: "CSRF: origin not allowed" });
    return;
  }
  const body = await readBody(req);
  const dryRun = body.dryRun === true || body.dryRun === "true";
  const only   = body.only   ?? null;

  // Safety: refuse live staging if Chrome is not reachable
  if (!dryRun) {
    const up = await isChromeDebugUp();
    if (!up) {
      sendJson(res, 400, {
        ok: false,
        error: "Job Applications Chrome (port 9223) is not reachable. Launch Staging Chrome first, then retry.",
      });
      return;
    }
  }

  // Resolve the target date folder
  const dateArg = (body.date && /^\d{4}-\d{2}-\d{2}$/.test(body.date)) ? body.date : latestAppliedDate();
  if (!dateArg) {
    sendJson(res, 400, { ok: false, error: "No applied/YYYY-MM-DD folder found." });
    return;
  }
  const dateDir = path.join(REPO, "applied", dateArg);
  if (!fs.existsSync(dateDir)) {
    sendJson(res, 400, { ok: false, error: `Date folder not found: ${dateDir}` });
    return;
  }

  // Build args for stage-apps.js
  const stageArgs = [STAGE_JS, dateDir];
  if (only) { stageArgs.push("--only", only); }
  if (dryRun) { stageArgs.push("--dry-run"); }

  // Truncate/create log so the UI sees fresh output
  fs.writeFileSync(STAGE_LOG, `[${new Date().toISOString()}] stage-apps.js started\n  date: ${dateArg}${dryRun ? "  [DRY RUN]" : ""}${only ? `  --only ${only}` : ""}\n\n`, "utf8");

  const logFd = fs.openSync(STAGE_LOG, "a");
  const child = spawn(process.execPath, stageArgs, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();

  sendJson(res, 200, {
    ok: true,
    dateDir,
    dryRun,
    only: only ?? null,
    note: "Running — poll GET /control/stage-log for progress.",
    pid: child.pid,
  });
}

/** GET /control/stage-log — last ~100 lines of stage.log */
function handleControlStageLog(_req, res) {
  try {
    if (!fs.existsSync(STAGE_LOG)) {
      sendJson(res, 200, { ok: true, lines: ["(no stage log yet — run Stage first)"] });
      return;
    }
    const content = fs.readFileSync(STAGE_LOG, "utf8");
    const lines   = content.split("\n");
    const tail    = lines.slice(-101).join("\n"); // ~100 lines
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", ...CORS_HEADERS });
    res.end(tail);
  } catch (err) {
    sendJson(res, 500, { ok: false, error: err.message });
  }
}

/** POST /control/watcher  body: { on: bool } */
async function handleControlWatcher(req, res) {
  if (isCsrfBlocked(req)) {
    sendJson(res, 403, { ok: false, error: "CSRF: origin not allowed" });
    return;
  }
  const body = await readBody(req);
  const turnOn = body.on === true || body.on === "true";

  if (turnOn) {
    // Copy plist to LaunchAgents if missing
    if (!fs.existsSync(WATCH_PLIST_DEST)) {
      try {
        fs.copyFileSync(WATCH_PLIST_SRC, WATCH_PLIST_DEST);
      } catch (err) {
        sendJson(res, 500, { ok: false, error: `Could not copy watcher plist: ${err.message}` });
        return;
      }
    }
    // Load if not already loaded
    if (!isWatcherLoaded()) {
      const r = spawnSync("launchctl", ["load", WATCH_PLIST_DEST], { encoding: "utf8" });
      if (r.status !== 0) {
        sendJson(res, 500, { ok: false, error: `launchctl load failed: ${r.stderr}` });
        return;
      }
    }
  } else {
    // Unload only if loaded
    if (isWatcherLoaded()) {
      const r = spawnSync("launchctl", ["unload", WATCH_PLIST_DEST], { encoding: "utf8" });
      if (r.status !== 0) {
        sendJson(res, 500, { ok: false, error: `launchctl unload failed: ${r.stderr}` });
        return;
      }
    }
  }

  sendJson(res, 200, { ok: true, watcher: isWatcherLoaded() });
}

/**
 * POST /control/discover — mine the current HN "Who is hiring?" thread for
 * fresh, lesser-known companies on Greenhouse/Lever/Ashby, add the new ones to
 * the watcher's targets, and seed their backlog as "seen" (so the watcher only
 * alerts on NEW posts). Runs scripts/discover-funding.py.
 */
async function handleControlDiscover(req, res) {
  if (isCsrfBlocked(req)) {
    sendJson(res, 403, { ok: false, error: "CSRF: origin not allowed" });
    return;
  }
  const script = path.join(REPO, "scripts/discover-funding.py");
  const r = spawnSync("python3", [script, "--max", "60"], { encoding: "utf8", timeout: 120000 });
  if (r.status !== 0) {
    sendJson(res, 500, { ok: false, error: (r.stderr || "discover failed").slice(0, 500) });
    return;
  }
  // Pull the "Added N companies" summary line for the UI.
  const out = (r.stdout || "").trim();
  const added = (out.match(/Added (\d+) companies.*?\((\d+) verified total\)/) || []);
  sendJson(res, 200, {
    ok: true,
    added: added[1] ? Number(added[1]) : null,
    total: added[2] ? Number(added[2]) : null,
    summary: out.split("\n").slice(-4).join(" ").slice(0, 400),
  });
}

/**
 * POST /control/scan — run the watcher ONCE, on demand ("Search for roles").
 * Spawns `watch-jobs.py --once` detached and returns immediately; new matches
 * land in the inbox and the UI's 5s auto-refresh surfaces them. GET
 * /control/status reports `scanning` (PID-liveness on SCAN_LOCK) so the button
 * can show "Searching…" until the pass finishes. Guards against a double-scan:
 * if a manual scan is already in flight, it's a no-op.
 */
async function handleControlScan(req, res) {
  if (isCsrfBlocked(req)) {
    sendJson(res, 403, { ok: false, error: "CSRF: origin not allowed" });
    return;
  }
  // Already scanning? (live PID in the lock) → no-op, don't stack scans.
  if (fs.existsSync(SCAN_LOCK)) {
    const pid = parseInt(fs.readFileSync(SCAN_LOCK, "utf8").trim(), 10);
    if (!isNaN(pid)) {
      try { process.kill(pid, 0); sendJson(res, 200, { ok: true, scanning: true, note: "A search is already running." }); return; }
      catch (_) { try { fs.unlinkSync(SCAN_LOCK); } catch (_) {} }  // stale → fall through
    }
  }
  const log = fs.openSync(SCAN_LOG, "a");
  const child = spawn("python3", [WATCH_SCRIPT, "--once"], {
    detached: true,
    stdio: ["ignore", log, log],
    // Match the launchd watcher's environment so python3 + its deps resolve
    // regardless of the bridge's own PATH.
    env: { ...process.env,
           PATH: `${HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
           HOME },
  });
  try { fs.writeFileSync(SCAN_LOCK, String(child.pid)); } catch (_) {}
  child.unref();
  sendJson(res, 200, { ok: true, scanning: true, pid: child.pid, note: "Searching career pages — new roles appear below as they're found." });
}

/**
 * POST /control/rescore-all
 *
 * Bulk re-run the fit-scorer on every non-terminal, non-inbox ledger row.
 * Spawns scripts/rescore-all.py detached (concurrency=3) and returns
 * immediately — exactly mirrors the /control/scan pattern.
 *
 * Single-instance guard: writes the spawned PID to RESCORE_ALL_LOCK.
 * GET /control/status reports `rescoringAll` via PID-liveness on that lock.
 * Stale locks (dead PID) are self-healed on the next status poll.
 */
async function handleControlRescoreAll(req, res) {
  if (isCsrfBlocked(req)) {
    sendJson(res, 403, { ok: false, error: "CSRF: origin not allowed" });
    return;
  }
  // Already rescoring? (live PID in the lock) → no-op.
  if (fs.existsSync(RESCORE_ALL_LOCK)) {
    const pid = parseInt(fs.readFileSync(RESCORE_ALL_LOCK, "utf8").trim(), 10);
    if (!isNaN(pid)) {
      try {
        process.kill(pid, 0);
        sendJson(res, 200, { ok: true, rescoringAll: true, note: "A rescore-all is already running." });
        return;
      } catch (_) {
        try { fs.unlinkSync(RESCORE_ALL_LOCK); } catch (_) {} // stale → fall through
      }
    }
  }
  const logFd = fs.openSync(RESCORE_ALL_LOG, "a");
  const child = spawn("python3", [RESCORE_ALL_SCRIPT], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env,
           PATH: `${HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
           HOME,
           QUEUE_PATH: process.env.QUEUE_PATH || QUEUE_PATH,
           LEDGER_PATH: process.env.LEDGER_PATH || LEDGER_PATH },
  });
  try { fs.writeFileSync(RESCORE_ALL_LOCK, String(child.pid)); } catch (_) {}
  child.unref();
  sendJson(res, 200, {
    ok: true,
    rescoringAll: true,
    pid: child.pid,
    note: "Rescoring all active roles — the MATCH column updates as each score lands.",
  });
}

// ---------------------------------------------------------------------------
// Stub handlers for future phases
// ---------------------------------------------------------------------------

/**
 * POST /scout
 * Intended payload: { company: string, jobId: string }
 * Future behavior: Fetch full job description + run relevance scoring
 *                  against Rob's resume keywords.
 */
function handleScout(req, res) {
  sendJson(res, 200, {
    ok: false,
    status: "not_implemented",
    note: "wired in a later phase",
  });
}

/**
 * POST /control/rescore  body: { key: string }
 *
 * Re-run the watcher fit-scorer on the stored JD for a ledger role that has
 * no coverage or fitScore yet. Uses watch-jobs.py --score-one <jdPath> so no
 * network call is needed — the JD was already fetched and written to disk.
 *
 * On success: writes fitScore (and roleType/master if present) back to both
 * the queue item and the ledger entry, then returns { ok: true, fitScore }.
 * On failure: returns { ok: false, error } with a human-readable message.
 */
async function handleControlRescore(req, res) {
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

  // 1. Resolve the ledger entry → applyUrl
  let ledgerData;
  try {
    ledgerData = JSON.parse(fs.readFileSync(LEDGER_PATH, "utf8"));
  } catch (err) {
    sendJson(res, 500, { ok: false, error: `Cannot read ledger: ${err.message}` });
    return;
  }
  const ledgerEntry = (ledgerData.entries ?? []).find((e) => e.key === key);
  if (!ledgerEntry) {
    sendJson(res, 404, { ok: false, error: `No ledger entry for key: ${key}` });
    return;
  }

  // 2. Find the matching queue item (by canonical key or normalized URL) → jdPath
  let queueData;
  try {
    queueData = JSON.parse(fs.readFileSync(QUEUE_PATH, "utf8"));
  } catch (err) {
    sendJson(res, 500, { ok: false, error: `Cannot read queue: ${err.message}` });
    return;
  }
  const applyUrl = ledgerEntry.applyUrl ?? "";
  const stripSlash = (u) => (u || "").trim().replace(/\/+$/, "");
  const queueItem = (queueData.items ?? []).find((it) =>
    canonicalKey(it.ats, it.jobId, it.company, it.title) === key ||
    (applyUrl && stripSlash(it.jdUrl) === stripSlash(applyUrl))
  );
  const jdPath = queueItem?.jdPath ?? null;
  if (!jdPath) {
    sendJson(res, 400, {
      ok: false,
      error: "No stored JD found for this role — rescore requires the JD to have been fetched at intake time.",
    });
    return;
  }
  if (!fs.existsSync(jdPath)) {
    sendJson(res, 400, { ok: false, error: `JD file not found on disk: ${jdPath}` });
    return;
  }

  // 3. Run watch-jobs.py --score-one <jdPath> with a 90s timeout
  const scoreResult = spawnSync(
    "python3", [WATCH_SCRIPT, "--score-one", jdPath],
    { encoding: "utf8", timeout: 90_000 }
  );
  if (scoreResult.error || scoreResult.status !== 0) {
    const detail = scoreResult.error?.message
      ?? scoreResult.stderr?.slice(0, 400)
      ?? "scorer exited non-zero";
    sendJson(res, 500, { ok: false, error: `Scorer failed: ${detail}` });
    return;
  }
  let score;
  try {
    score = JSON.parse(scoreResult.stdout.trim());
  } catch {
    sendJson(res, 500, {
      ok: false,
      error: `Scorer returned non-JSON output: ${scoreResult.stdout.slice(0, 200)}`,
    });
    return;
  }
  const fitScore = score.fitScore ?? null;
  if (fitScore === null) {
    sendJson(res, 500, { ok: false, error: "Scorer returned no fitScore field" });
    return;
  }

  // 4. Write fitScore back to the ledger entry (additive upsert via ledger.py)
  try {
    ledgerAdd({ key, fitScore, roleType: score.roleType ?? undefined });
  } catch (err) {
    sendJson(res, 500, { ok: false, error: `Ledger write-back failed: ${err.message}` });
    return;
  }

  // 5. Write fitScore back to the queue item (direct flock'd patch via Python)
  if (queueItem) {
    const patchScript = [
      "import sys,json,fcntl",
      "path,item_id,score_str=sys.argv[1],sys.argv[2],sys.argv[3]",
      "score=int(score_str)",
      "f=open(path,'r+')",
      "fcntl.flock(f,fcntl.LOCK_EX)",
      "data=json.load(f)",
      "[it.update({'fitScore':score}) for it in data['items'] if it['id']==item_id]",
      "f.seek(0);json.dump(data,f,indent=2);f.truncate()",
    ].join(";");
    spawnSync("python3", ["-c", patchScript, QUEUE_PATH, queueItem.id, String(fitScore)],
              { encoding: "utf8" });
    // Non-fatal if queue patch fails — ledger is the source of truth for the UI.
  }

  sendJson(res, 200, { ok: true, fitScore, roleType: score.roleType ?? null });
}

/**
 * POST /control/cancel-build  body: { id: string }
 *
 * Rob can manually cancel a stuck "building" queue item, resetting it to
 * "pending" so the next batch pass can re-attempt it. Useful when a build
 * hangs and the 15-min stale-building sweep hasn't fired yet, or when Rob
 * wants to cancel immediately without waiting.
 */
async function handleControlCancelBuild(req, res) {
  if (isCsrfBlocked(req)) {
    sendJson(res, 403, { ok: false, error: "forbidden origin" });
    return;
  }
  const body = await readBody(req);
  const id = (body.id ?? "").trim();
  if (!id) {
    sendJson(res, 400, { ok: false, error: "id is required" });
    return;
  }
  // Read current status first
  const getResult = spawnSync("python3", [QUEUE_PY, QUEUE_PATH, "get", id],
                              { encoding: "utf8" });
  if (getResult.status !== 0 || !getResult.stdout.trim()) {
    sendJson(res, 404, { ok: false, error: `queue item not found: ${id}` });
    return;
  }
  const item = JSON.parse(getResult.stdout.trim());
  if (item.status !== "building") {
    sendJson(res, 400, { ok: false, error: `item ${id} is not in building state (current: ${item.status})` });
    return;
  }
  // Reset via reset-building (resets ALL building items, which is correct —
  // only one should be building at a time under our single-instance lock).
  const r = spawnSync("python3", [QUEUE_PY, QUEUE_PATH, "reset-building"],
                      { encoding: "utf8" });
  if (r.status !== 0) {
    sendJson(res, 500, { ok: false, error: `reset-building failed: ${r.stderr}` });
    return;
  }
  sendJson(res, 200, { ok: true, id, status: "pending", note: "item reset to pending — next batch run will retry it" });
}

/**
 * POST /build  body: { id: string }
 *
 * Rob approves a "new" inbox item for building. Transitions the queue item
 * new → pending (queue.py build), then triggers run-batch (which only claims
 * pending items). This is the one place a scraped role becomes a build —
 * the watcher itself never builds.
 */
async function handleBuild(req, res) {
  if (isCsrfBlocked(req)) {
    sendJson(res, 403, { ok: false, error: "forbidden origin" });
    return;
  }
  const body = await readBody(req);
  const id = (body.id ?? "").trim();
  if (!id) {
    sendJson(res, 400, { ok: false, error: "id is required" });
    return;
  }
  const r = spawnSync("python3", [QUEUE_PY, QUEUE_PATH, "build", id],
                      { encoding: "utf8" });
  if (r.status !== 0) {
    sendJson(res, 404, { ok: false, error: (r.stderr || "queue item not found").trim() });
    return;
  }
  // Kick the builder (detached, guarded against double-spawn).
  try { spawnBatchIfIdle(); } catch (_) {}
  sendJson(res, 200, { ok: true, id, status: "pending", building: true });
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

/**
 * Read the full request body and parse it as JSON.
 * Returns {} if body is empty or unparseable.
 */
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      try { resolve(JSON.parse(raw)); } catch { resolve({}); }
    });
    req.on("error", () => resolve({}));
  });
}

/** Write a JSON response with CORS headers. */
function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
    ...CORS_HEADERS,
  });
  res.end(payload);
}

/** One-line request logger. */
function logRequest(req, statusCode) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${req.method} ${req.url} → ${statusCode}`);
}

// Route table — matches method + exact path (or prefix for /discover)
// Path to the single-role autofill CLI (sibling of STAGE_JS).
const AUTOFILL_JS = path.join(REPO, "scripts/autofill.js");

/**
 * Resolve a ledger entry's built field-map.json path. Prefers entry.folder, but
 * many entries carry folder:null (reconcile never populated it), so we fall back
 * to scanning applied/ for the build whose field-map.json applyUrl matches this
 * entry's applyUrl. Returns an absolute path or null.
 */
function resolveFieldMap(entry) {
  const want = (entry.applyUrl || "").trim().replace(/\/+$/, "");
  const direct = entry.folder && path.join(entry.folder, "field-map.json");
  if (direct && fs.existsSync(direct)) return direct;
  if (!want) return null;
  const root = path.join(REPO, "applied");
  let dates;
  try { dates = fs.readdirSync(root); } catch (_) { return null; }
  const matches = (p) => {
    try {
      const fm = JSON.parse(fs.readFileSync(p, "utf8"));
      return (fm.applyUrl || "").trim().replace(/\/+$/, "") === want;
    } catch (_) { return false; }
  };
  for (const d of dates.sort().reverse()) {  // newest date first → prefer the most recent rebuild
    const dateDir = path.join(root, d);
    // Flat (legacy) layout: applied/<date>/field-map.json
    const flat = path.join(dateDir, "field-map.json");
    if (matches(flat)) return flat;
    // Company-folder layout: applied/<date>/<folder>/field-map.json
    let subs;
    try { subs = fs.readdirSync(dateDir); } catch (_) { continue; }
    for (const s of subs) {
      const p = path.join(dateDir, s, "field-map.json");
      if (matches(p)) return p;
    }
  }
  return null;
}

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

  // Resolve the ledger entry → its built field-map.json.
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
  const fieldMapPath = resolveFieldMap(entry);
  if (!fieldMapPath) {
    sendJson(res, 400, {
      ok: false,
      error: `no built field-map.json found for "${key}" (status: ${entry.status}) — build the role first`,
    });
    return;
  }

  // Fresh log header so the UI's stage-log tail (if watched) shows this run.
  fs.writeFileSync(
    STAGE_LOG,
    `[${new Date().toISOString()}] autofill.js started\n  key: ${key}\n  fieldMap: ${fieldMapPath}\n\n`,
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
    folder: path.dirname(fieldMapPath),
    note: "Autofill running in staging Chrome — fills + attaches, never submits. Review then submit.",
    pid: child.pid,
  });
}

const routes = [
  // ── v1 routes (preserved) ──────────────────────────────────────────────
  {
    method: "GET",
    test: (p) => p === "/health",
    handler: (req, res) => {
      sendJson(res, 200, { ok: true, service: "bridge", version: 2 });
    },
  },
  {
    method: "GET",
    test: (p) => p === "/discover" || p.startsWith("/discover?"),
    handler: (req, res) => handleDiscover(req, res),
  },
  {
    method: "POST",
    test: (p) => p === "/scout",
    handler: (req, res) => handleScout(req, res),
  },
  {
    method: "POST",
    test: (p) => p === "/build",
    handler: (req, res) => handleBuild(req, res),
  },
  // ── v2 intake + ledger routes ──────────────────────────────────────────
  {
    method: "GET",
    test: (p) => p === "/",
    handler: (req, res) => handleRoot(req, res),
  },
  {
    method: "POST",
    test: (p) => p === "/intake",
    handler: (req, res) => handleIntake(req, res),
  },
  {
    method: "POST",
    test: (p) => p === "/autofill",
    handler: (req, res) => handleAutofill(req, res),
  },
  {
    method: "GET",
    test: (p) => p === "/queue",
    handler: (req, res) => handleGetQueue(req, res),
  },
  {
    method: "GET",
    test: (p) => p === "/ledger",
    handler: (req, res) => handleGetLedger(req, res),
  },
  {
    method: "POST",
    test: (p) => p === "/ledger/mark",
    handler: (req, res) => handleLedgerMark(req, res),
  },
  {
    method: "POST",
    test: (p) => p === "/pass",
    handler: (req, res) => handlePass(req, res),
  },
  // ── control routes ─────────────────────────────────────────────────────────
  {
    method: "GET",
    test: (p) => p === "/control/status",
    handler: (req, res) => handleControlStatus(req, res),
  },
  {
    method: "POST",
    test: (p) => p === "/control/chrome",
    handler: (req, res) => handleControlChrome(req, res),
  },
  {
    method: "POST",
    test: (p) => p === "/control/stage",
    handler: (req, res) => handleControlStage(req, res),
  },
  {
    method: "GET",
    test: (p) => p === "/control/stage-log",
    handler: (req, res) => handleControlStageLog(req, res),
  },
  {
    method: "POST",
    test: (p) => p === "/control/watcher",
    handler: (req, res) => handleControlWatcher(req, res),
  },
  {
    method: "POST",
    test: (p) => p === "/control/discover",
    handler: (req, res) => handleControlDiscover(req, res),
  },
  {
    method: "POST",
    test: (p) => p === "/control/scan",
    handler: (req, res) => handleControlScan(req, res),
  },
  {
    method: "POST",
    test: (p) => p === "/control/cancel-build",
    handler: (req, res) => handleControlCancelBuild(req, res),
  },
  {
    method: "POST",
    test: (p) => p === "/control/rescore",
    handler: (req, res) => handleControlRescore(req, res),
  },
  {
    method: "POST",
    test: (p) => p === "/control/rescore-all",
    handler: (req, res) => handleControlRescoreAll(req, res),
  },
];

const server = http.createServer((req, res) => {
  // Network access control: localhost + Tailscale tailnet only.
  if (!isAllowedClient(req)) {
    res.writeHead(403, CORS_HEADERS);
    res.end("Forbidden: reachable only from localhost and your Tailscale tailnet.");
    logRequest(req, 403);
    return;
  }
  // Handle CORS preflight for all routes
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    logRequest(req, 204);
    return;
  }

  const pathname = new URL(req.url, `http://localhost:${PORT}`).pathname;
  const route = routes.find(
    (r) => r.method === req.method && r.test(pathname)
  );

  if (route) {
    const wrappedHandler = async () => {
      try {
        await route.handler(req, res);
        logRequest(req, res.statusCode);
      } catch (err) {
        console.error("Unhandled route error:", err);
        sendJson(res, 500, { ok: false, error: "Internal server error" });
        logRequest(req, 500);
      }
    };
    wrappedHandler();
  } else {
    sendJson(res, 404, { ok: false, error: "Not found" });
    logRequest(req, 404);
  }
});

// Pure URL/HTML helpers are exported so the unit-test suite can import and
// exercise them directly (no network, no subprocess). The server is unaffected:
// importers set BRIDGE_NO_LISTEN=1 to skip binding a port (below), while the
// production entrypoint and the integration suite run without it and listen.
export { parseJobUrl, canonicalKey, extractHtmlTitle, decodeEntities,
         visibleTextLength, isCsrfBlocked, isAllowedClient };

// Skip binding a port when imported purely for unit tests (BRIDGE_NO_LISTEN=1).
if (!process.env.BRIDGE_NO_LISTEN) {
server.listen(PORT, process.env.BRIDGE_HOST || "0.0.0.0", () => {
  console.log(`bridge server running on :${PORT} (localhost + Tailscale tailnet only)`);
  console.log(`  GET  /                  — intake UI (bookmark this)`);
  console.log(`  GET  /health            — liveness check`);
  console.log(`  GET  /discover          — fetch + filter open roles`);
  console.log(`  POST /intake            — stage a job URL for building`);
  console.log(`  GET  /queue             — review inbox + in-flight builds`);
  console.log(`  GET  /ledger            — application lifecycle ledger`);
  console.log(`  POST /ledger/mark       — set outcome / referral (records statusHistory)`);
  console.log(`  POST /build             — approve a 'new' inbox role → build`);
  console.log(`  POST /pass              — decline a role + train the fit-scorer`);
  console.log(`  POST /autofill          — fill + attach one built role in staging Chrome (never submits)`);
  console.log(`  GET  /control/status    — engine health + chrome/watcher state`);
  console.log(`  POST /control/chrome    — launch staging Chrome`);
  console.log(`  POST /control/stage     — run stage-apps.js (dryRun supported)`);
  console.log(`  GET  /control/stage-log — tail of stage.log`);
  console.log(`  POST /control/watcher   — turn watcher launchd job on/off`);
  console.log(`  POST /scout             — (stub) score a specific role`);
});
}
