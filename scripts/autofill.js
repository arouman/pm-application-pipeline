#!/usr/bin/env node
/**
 * autofill.js — single-role apply-form autofill for Rob's pipeline (Phase 5).
 *
 * Opens ONE built role's application page in the Job Applications Chrome
 * (port 9223), detects the ATS from the URL host, fills the standard identity
 * fields, attaches the resume + cover-letter PDFs, and leaves the tab open and
 * UN-SUBMITTED for Rob to review and submit.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * ATS COVERAGE
 *   • Greenhouse  (boards.greenhouse.io, job-boards.greenhouse.io)
 *       #first_name, #last_name, #email, #phone, plus custom LinkedIn/website
 *       text inputs matched by their label/name.
 *   • Lever       (jobs.lever.co)
 *       input[name="name"], input[name="email"], input[name="phone"],
 *       input[name="urls[LinkedIn]"], input[name="urls[Website|Portfolio]"], …
 *   • Ashby       (jobs.ashbyhq.com — React SPA)
 *       fields matched by visible label / name / aria-label, resilient to the
 *       SPA's controlled inputs. Values are typed via CDP Input.insertText so
 *       Ashby's validator sees TRUSTED events (synthetic JS events are ignored).
 *
 *   Any other host: we still open the page, attach files, and do a best-effort
 *   label-based text fill, but log that the ATS is unrecognised.
 *
 * "FILLS, NEVER SUBMITS" GUARANTEE
 *   This script NEVER clicks a submit button, NEVER presses Enter in a way that
 *   could submit a form, and NEVER sets dropdowns / radios / EEO fields. It only
 *   types text inputs/textarea, attaches the two PDFs, and stops. The tab is left
 *   open. Submitting is always Rob's manual step.
 *
 * BROWSER DRIVING
 *   Zero npm dependencies — same approach as scripts/stage-apps.js. Node ships a
 *   global WebSocket + fetch + http, so we speak the Chrome DevTools Protocol
 *   directly over raw WebSocket/HTTP to the debug port that scripts/chrome-debug.sh
 *   opens (9223). No playwright/puppeteer installed in this repo.
 *
 * Defensive by design: a missing selector is logged and skipped, never thrown.
 *
 * USAGE
 *   node scripts/autofill.js <abs-path-to-field-map.json>
 *   node scripts/autofill.js --key <ledgerKey>      # resolve folder from the ledger
 *   node scripts/autofill.js <field-map.json> --dry-run   # plan only, open no tab
 *
 * PREREQUISITE
 *   scripts/chrome-debug.sh must be running (Job Applications Chrome on port 9223).
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const http = require("http");

// ─── Paths / constants ─────────────────────────────────────────────────────────

const REPO         = path.resolve(__dirname, "..");
const PRIVATE_JSON = path.join(REPO, "private", "applicant-profile.json");
const LEDGER_PATH  = process.env.LEDGER_PATH || path.join(REPO, "applied/applied-ledger.json");
const CDP_HOST     = "127.0.0.1";
const CDP_PORT     = 9223;

// ─── CLI parsing ───────────────────────────────────────────────────────────────

const argv    = process.argv.slice(2);
const dryRun  = argv.includes("--dry-run");
const keyIdx  = argv.indexOf("--key");
const ledgerKey = keyIdx >= 0 ? argv[keyIdx + 1] : null;
// First positional arg that isn't a flag and isn't the --key value.
const positional = argv.find((a, i) =>
  !a.startsWith("--") && argv[i - 1] !== "--key");

function usage(msg) {
  if (msg) console.error("Error: " + msg + "\n");
  console.error("Usage:");
  console.error("  node scripts/autofill.js <abs-path-to-field-map.json> [--dry-run]");
  console.error("  node scripts/autofill.js --key <ledgerKey> [--dry-run]");
  process.exit(1);
}

/** Resolve a field-map.json path from a ledger key (uses the built entry's folder). */
function fieldMapFromLedgerKey(key) {
  let ledger;
  try {
    ledger = JSON.parse(fs.readFileSync(LEDGER_PATH, "utf8"));
  } catch (e) {
    usage(`could not read ledger at ${LEDGER_PATH}: ${e.message}`);
  }
  const entry = (ledger.entries || []).find(e => e.key === key);
  if (!entry) usage(`no ledger entry with key "${key}"`);
  if (!entry.folder) usage(`ledger entry "${key}" has no built folder (status: ${entry.status})`);
  const fmPath = path.join(entry.folder, "field-map.json");
  if (!fs.existsSync(fmPath)) usage(`field-map.json not found in folder ${entry.folder}`);
  return fmPath;
}

let fieldMapPath;
if (ledgerKey) {
  fieldMapPath = fieldMapFromLedgerKey(ledgerKey);
} else if (positional) {
  fieldMapPath = path.resolve(positional);
} else {
  usage("provide a field-map.json path or --key <ledgerKey>");
}

if (!fs.existsSync(fieldMapPath)) usage(`field-map not found: ${fieldMapPath}`);

// ─── CDP plumbing (raw WebSocket + HTTP, no deps) — mirrors stage-apps.js ────────

/** Simple CDP over HTTP (for /json/* endpoints). */
function cdpGet(urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: CDP_HOST, port: CDP_PORT, path: urlPath }, res => {
      let data = "";
      res.on("data", c => (data += c));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`CDP JSON parse error on ${urlPath}: ${e.message}`)); }
      });
    });
    req.on("error", reject);
  });
}

/** Open a new CDP tab at the given URL (PUT for modern Chrome, GET fallback). */
function openNewTab(url) {
  const encoded = encodeURIComponent(url);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: CDP_HOST, port: CDP_PORT, path: `/json/new?${encoded}`, method: "PUT" },
      res => {
        let data = "";
        res.on("data", c => (data += c));
        res.on("end", () => {
          if (data.startsWith("Using unsafe")) {
            const req2 = http.get(
              { host: CDP_HOST, port: CDP_PORT, path: `/json/new?${encoded}` },
              res2 => {
                let d2 = "";
                res2.on("data", c => (d2 += c));
                res2.on("end", () => { try { resolve(JSON.parse(d2)); } catch (e) { reject(e); } });
              }
            );
            req2.on("error", reject);
            return;
          }
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error(`/json/new parse error: ${e.message} — raw: ${data.slice(0, 80)}`)); }
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

/** Wrap a CDP WebSocket session → { send(method, params), close() }. */
function cdpSession(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let nextId = 1;
    const pending = new Map();

    ws.onopen = () => {
      resolve({
        send(method, params = {}) {
          return new Promise((res, rej) => {
            const id = nextId++;
            pending.set(id, { res, rej });
            ws.send(JSON.stringify({ id, method, params }));
          });
        },
        close() { try { ws.close(); } catch (_) {} },
        ws,
      });
    };
    ws.onmessage = ({ data }) => {
      try {
        const msg = JSON.parse(data);
        if (msg.id && pending.has(msg.id)) {
          const { res, rej } = pending.get(msg.id);
          pending.delete(msg.id);
          if (msg.error) rej(new Error(`CDP ${msg.error.code}: ${msg.error.message}`));
          else res(msg.result);
        }
      } catch (_) {}
    };
    ws.onerror = e => reject(new Error(`WebSocket error: ${e.message || "unknown"}`));
    ws.onclose = () => {
      for (const { rej } of pending.values()) rej(new Error("WebSocket closed"));
      pending.clear();
    };
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Poll the page until a CSS selector matches or timeout. */
async function waitForSelector(cdp, selector, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await cdp.send("Runtime.evaluate", {
      expression: `!!document.querySelector(${JSON.stringify(selector)})`,
      returnByValue: true,
    }).catch(() => null);
    if (r && r.result && r.result.value === true) return true;
    await sleep(500);
  }
  return false;
}

// ─── ATS detection ──────────────────────────────────────────────────────────────

/** Detect ATS from the apply URL host. Returns "greenhouse" | "lever" | "ashby" | "unknown". */
function detectAts(url) {
  let host = "";
  try { host = new URL(url).hostname.toLowerCase(); } catch (_) { return "unknown"; }
  if (host === "boards.greenhouse.io" || host === "job-boards.greenhouse.io") return "greenhouse";
  if (host === "jobs.lever.co") return "lever";
  if (host === "jobs.ashbyhq.com") return "ashby";
  return "unknown";
}

/** Ashby's form lives at <jobUrl>/application — normalise so we land on the form. */
function normaliseApplyUrl(url, ats) {
  if (ats === "ashby" && !/\/application\/?$/.test(url)) {
    return url.replace(/\/?$/, "") + "/application";
  }
  return url;
}

// ─── Field plans, per ATS ───────────────────────────────────────────────────────
//
// Each plan is a list of { value, selectors[], labelKeys[], name } target descriptors.
//   selectors  — concrete CSS selectors tried first (fast path for stable ATSes).
//   labelKeys  — fallback substrings matched against a field's label/name/aria text.
// We try the explicit selectors first; if none hit, we fall back to label matching.
// This keeps Greenhouse/Lever robust (known ids/names) while staying resilient on
// Ashby (label-driven, ids are unstable hashes).

function greenhousePlan(id) {
  return [
    { value: id.firstName, selectors: ["#first_name", 'input[name="first_name"]', 'input[autocomplete="given-name"]'], labelKeys: ["first name", "given name", "legal first"], name: "First name" },
    { value: id.lastName,  selectors: ["#last_name", 'input[name="last_name"]', 'input[autocomplete="family-name"]'], labelKeys: ["last name", "family name", "surname", "legal last"], name: "Last name" },
    { value: id.email,     selectors: ["#email", 'input[name="email"]', 'input[type="email"]'], labelKeys: ["email"], name: "Email" },
    { value: id.phone,     selectors: ["#phone", 'input[name="phone"]', 'input[type="tel"]'], labelKeys: ["phone", "mobile", "telephone"], name: "Phone" },
    { value: id.linkedin,  selectors: [], labelKeys: ["linkedin"], name: "LinkedIn" },
    { value: id.website,   selectors: [], labelKeys: ["website", "portfolio", "personal site"], name: "Website" },
  ];
}

function leverPlan(id) {
  return [
    { value: id.fullName,  selectors: ['input[name="name"]'], labelKeys: ["full name", "your name", "name"], name: "Full name" },
    { value: id.email,     selectors: ['input[name="email"]', 'input[type="email"]'], labelKeys: ["email"], name: "Email" },
    { value: id.phone,     selectors: ['input[name="phone"]', 'input[type="tel"]'], labelKeys: ["phone", "mobile"], name: "Phone" },
    { value: id.location,  selectors: ['input[name="location"]'], labelKeys: ["location", "current location", "city"], name: "Location" },
    { value: id.linkedin,  selectors: ['input[name="urls[LinkedIn]"]', 'input[name="urls[Linkedin]"]'], labelKeys: ["linkedin"], name: "LinkedIn" },
    { value: id.website,   selectors: ['input[name="urls[Website]"]', 'input[name="urls[Portfolio]"]', 'input[name="urls[Other]"]'], labelKeys: ["website", "portfolio", "personal"], name: "Website" },
  ];
}

// Ashby: ids are unstable hashes, so we lean on label/name/aria matching. We still
// list a couple of common name attributes Ashby uses as a fast path.
function ashbyPlan(id) {
  return [
    { value: id.firstName, selectors: ['input[name="_systemfield_name"]'], labelKeys: ["first name", "given name", "legal first"], name: "First name" },
    { value: id.lastName,  selectors: [], labelKeys: ["last name", "family name", "surname", "legal last"], name: "Last name" },
    { value: id.fullName,  selectors: [], labelKeys: ["full name", "your name"], name: "Full name" },
    { value: id.email,     selectors: ['input[name="_systemfield_email"]', 'input[type="email"]'], labelKeys: ["email"], name: "Email" },
    { value: id.phone,     selectors: ['input[name="_systemfield_phone"]', 'input[type="tel"]'], labelKeys: ["phone", "mobile"], name: "Phone" },
    { value: id.linkedin,  selectors: [], labelKeys: ["linkedin"], name: "LinkedIn" },
    { value: id.website,   selectors: [], labelKeys: ["website", "portfolio", "personal site"], name: "Website" },
    { value: id.location,  selectors: [], labelKeys: ["location", "current location", "city"], name: "Location" },
  ];
}

// Generic best-effort for unknown hosts — pure label matching.
function genericPlan(id) {
  return [
    { value: id.firstName, selectors: [], labelKeys: ["first name", "given name"], name: "First name" },
    { value: id.lastName,  selectors: [], labelKeys: ["last name", "family name", "surname"], name: "Last name" },
    { value: id.fullName,  selectors: [], labelKeys: ["full name", "your name"], name: "Full name" },
    { value: id.email,     selectors: ['input[type="email"]'], labelKeys: ["email"], name: "Email" },
    { value: id.phone,     selectors: ['input[type="tel"]'], labelKeys: ["phone", "mobile"], name: "Phone" },
    { value: id.linkedin,  selectors: [], labelKeys: ["linkedin"], name: "LinkedIn" },
    { value: id.website,   selectors: [], labelKeys: ["website", "portfolio"], name: "Website" },
    { value: id.location,  selectors: [], labelKeys: ["location", "city"], name: "Location" },
  ];
}

function planForAts(ats, id) {
  switch (ats) {
    case "greenhouse": return greenhousePlan(id);
    case "lever":      return leverPlan(id);
    case "ashby":      return ashbyPlan(id);
    default:           return genericPlan(id);
  }
}

// ─── In-page resolver: tag the target element for each plan entry ────────────────
//
// We run ONE Runtime.evaluate that, for each plan entry, finds the best matching
// EMPTY, VISIBLE text input and tags it with data-rob-fill-id="<i>". It returns a
// report of which entries resolved. Typing happens afterwards via CDP Input.insertText
// (trusted events) — this is the Ashby-safe path proven in stage-apps.js.

function buildResolverExpression(plan) {
  // Only pass the matching metadata into the page (not the values — those are
  // typed via CDP so they never appear as untrusted JS-set values).
  const planMeta = plan.map((p, i) => ({
    i,
    name: p.name,
    selectors: p.selectors || [],
    labelKeys: p.labelKeys || [],
    hasValue: !!p.value,
  }));
  return `
  (function() {
    const plan = ${JSON.stringify(planMeta)};
    const visible = el => el && el.offsetParent !== null && !el.disabled && !el.readOnly;
    function labelFor(el) {
      let t = "";
      if (el.id) {
        const l = document.querySelector('label[for="' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id) + '"]');
        if (l) t += " " + l.textContent;
      }
      const lbldby = el.getAttribute("aria-labelledby");
      if (lbldby) lbldby.split(/\\s+/).forEach(id => { const n = document.getElementById(id); if (n) t += " " + n.textContent; });
      const wrap = el.closest("label"); if (wrap) t += " " + wrap.textContent;
      t += " " + (el.name||"") + " " + (el.id||"") + " " + (el.getAttribute("placeholder")||"") +
           " " + (el.getAttribute("aria-label")||"") + " " + (el.getAttribute("autocomplete")||"");
      return t.toLowerCase().replace(/\\s+/g, " ").trim();
    }
    const textInputs = [...document.querySelectorAll(
      'input[type="text"],input[type="email"],input[type="tel"],input[type="url"],input:not([type])'
    )].filter(visible);
    const used = new Set();
    const report = [];
    for (const p of plan) {
      if (!p.hasValue) { report.push({ name: p.name, status: "no-value" }); continue; }
      let el = null;
      // 1) explicit selectors
      for (const sel of p.selectors) {
        try {
          const cand = document.querySelector(sel);
          if (cand && visible(cand) && !used.has(cand)) { el = cand; break; }
        } catch (_) {}
      }
      // 2) label-key fallback over empty inputs
      if (!el) {
        el = textInputs.find(inp =>
          !used.has(inp) && !inp.value &&
          p.labelKeys.some(k => labelFor(inp).includes(k)));
      }
      if (el) {
        used.add(el);
        el.setAttribute("data-rob-fill-id", String(p.i));
        report.push({ name: p.name, status: "resolved", fillId: p.i });
      } else {
        report.push({ name: p.name, status: "not-found" });
      }
    }
    // Cover-letter textarea (only if the form has one and there's text to paste).
    let coverTextarea = null;
    const tas = [...document.querySelectorAll("textarea")].filter(visible).filter(t => !t.value);
    coverTextarea = tas.find(t => /cover letter|additional info|anything else|tell us more/.test(labelFor(t)));
    if (coverTextarea) {
      coverTextarea.setAttribute("data-rob-fill-id", "cover");
      report.push({ name: "Cover letter (textarea)", status: "resolved", fillId: "cover" });
    }
    // File inputs report (for attach assignment + manual flagging).
    const files = [...document.querySelectorAll('input[type="file"]')].map((f, idx) => {
      f.setAttribute("data-rob-file-id", String(idx));
      return { idx, label: labelFor(f).slice(0, 80) };
    });
    return JSON.stringify({ report, files });
  })()
  `;
}

// ─── Type a single tagged field via trusted CDP events ──────────────────────────

// Focus a tagged element and CLEAR any pre-existing value through the native value
// setter (so React/controlled inputs notice the reset). Without this, Input.insertText
// APPENDS to a field that's already populated — by a prior staging run OR by Chrome's
// own profile autofill, which silently re-inserts a saved name on page load (seen live:
// saved "Robert" + typed "Rob" → "RobertRob").
async function focusAndClear(cdp, sel) {
  const expr = `
    (function() {
      const el = document.querySelector('${sel}');
      if (!el) return false;
      el.scrollIntoView({ block: "center", behavior: "instant" });
      el.focus();
      if (el.value) {
        try {
          const proto = el.tagName === "TEXTAREA"
            ? window.HTMLTextAreaElement.prototype
            : window.HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
          setter.call(el, "");
          el.dispatchEvent(new Event("input", { bubbles: true }));
        } catch (_) { el.value = ""; }
      }
      try { el.setSelectionRange(0, 0); } catch (_) {}
      return true;
    })()
  `;
  const r = await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true }).catch(() => null);
  return r?.result?.value === true;
}

async function readValue(cdp, sel) {
  const r = await cdp.send("Runtime.evaluate", {
    expression: `document.querySelector('${sel}')?.value`,
    returnByValue: true,
  }).catch(() => null);
  return r?.result?.value;
}

// Clear → type (trusted CDP events) → verify. If the field didn't end up exactly
// equal to our value (e.g. Chrome autofill re-injected a saved value mid-type),
// clear + retype once. Returns { ok, landed }. Never submits, never presses Enter.
async function typeIntoTagged(cdp, fillId, value) {
  const sel = `[data-rob-fill-id="${fillId}"]`;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!(await focusAndClear(cdp, sel))) return { ok: false, reason: "could not focus" };
    await sleep(70);
    await cdp.send("Input.insertText", { text: value }).catch(() => {});
    await sleep(70);
    await cdp.send("Runtime.evaluate", {
      expression: `document.querySelector('${sel}')?.blur()`,
      returnByValue: false,
    }).catch(() => {});
    await sleep(40);

    const landed = await readValue(cdp, sel);
    if (landed === value) return { ok: true, landed };
    // For phone/location etc. the ATS may re-format (e.g. "(970) 581-2133"); accept
    // a non-empty result that CONTAINS our digits/letters as a pass on the 2nd try.
    if (attempt === 1 && typeof landed === "string" && landed.length > 0) {
      return { ok: true, landed };
    }
  }
  const landed = await readValue(cdp, sel);
  return { ok: typeof landed === "string" && landed.length > 0, landed };
}

// ─── File-input assignment (resume vs cover letter) ──────────────────────────────

function assignFiles(files, resumePdf, coverLetterPdf) {
  if (!files.length) return [];
  if (files.length === 1) {
    return [{ idx: files[0].idx, file: resumePdf, label: files[0].label, note: "cover letter is manual" }];
  }
  const coverIn  = files.find(f => /cover|letter/i.test(f.label));
  const resumeIn = files.find(f => /resume|cv/i.test(f.label)) || files[0];
  const out = [];
  if (resumeIn) out.push({ idx: resumeIn.idx, file: resumePdf, label: resumeIn.label, note: null });
  if (coverIn && coverIn !== resumeIn) out.push({ idx: coverIn.idx, file: coverLetterPdf, label: coverIn.label, note: null });
  return out;
}

// ─── Merge private profile into the field-map identity (same logic as stage-apps) ─

function buildIdentity(fieldMap) {
  let priv = {};
  if (fs.existsSync(PRIVATE_JSON)) {
    try { priv = JSON.parse(fs.readFileSync(PRIVATE_JSON, "utf8")); } catch (_) {}
  }
  const p = priv.identity || {};
  const fm = fieldMap.identity || {};
  return {
    firstName: fm.firstName || p.fullName?.split(" ")[0],
    lastName:  fm.lastName  || p.fullName?.split(" ").slice(1).join(" "),
    fullName:  fm.fullName  || p.fullName,
    email:     fm.email     || p.email,
    phone:     fm.phone     || p.phone,
    linkedin:  fm.linkedin  || p.linkedin,
    website:   fm.website   || p.website,
    location:  fm.location  || p.locationForApplications || p.location,
  };
}

// ─── Main ────────────────────────────────────────────────────────────────────────

async function main() {
  const fieldMap = JSON.parse(fs.readFileSync(fieldMapPath, "utf8"));
  const id       = buildIdentity(fieldMap);
  const { resumePdf, coverLetterPdf, coverLetterText, company, title } = fieldMap;

  const rawApplyUrl = fieldMap.applyUrl;
  if (!rawApplyUrl) usage("field-map.json has no applyUrl");

  const ats      = detectAts(rawApplyUrl);
  const applyUrl = normaliseApplyUrl(rawApplyUrl, ats);
  const plan     = planForAts(ats, id);

  console.log("─".repeat(64));
  console.log(`autofill.js — ${company || "?"} — ${title || "?"}`);
  console.log(`  ATS:    ${ats}${ats === "unknown" ? " (best-effort label fill)" : ""}`);
  console.log(`  URL:    ${applyUrl}`);
  const resumeExists = resumePdf && fs.existsSync(resumePdf);
  const coverExists  = coverLetterPdf && fs.existsSync(coverLetterPdf);
  console.log(`  Resume: ${resumePdf ? (resumeExists ? "FOUND " : "MISSING ") : "not set "}${resumePdf ? path.basename(resumePdf) : ""}`);
  console.log(`  Cover:  ${coverLetterPdf ? (coverExists ? "FOUND " : "MISSING ") : "not set "}${coverLetterPdf ? path.basename(coverLetterPdf) : ""}`);
  console.log("─".repeat(64));

  if (dryRun) {
    console.log("\n[DRY RUN] No tab opened. Planned text fields (value present):");
    for (const p of plan) {
      console.log(`  ${p.value ? "•" : "○"} ${p.name}${p.value ? `  → ${String(p.value).slice(0, 40)}` : "  (no value)"}`);
    }
    console.log(`  ${coverLetterText ? "•" : "○"} Cover-letter textarea fallback ${coverLetterText ? "(text available)" : "(none)"}`);
    console.log("\n[DRY RUN] would attach resume + cover-letter PDFs; would NEVER submit.");
    return;
  }

  // --- Verify Chrome is reachable ---
  try { await cdpGet("/json/version"); }
  catch (e) {
    console.error(`\nCannot reach Job Applications Chrome on port ${CDP_PORT}: ${e.message}`);
    console.error("Run: bash scripts/chrome-debug.sh");
    process.exit(1);
  }

  // --- Open the apply page ---
  let tab;
  try { tab = await openNewTab(applyUrl); }
  catch (e) { console.error(`Failed to open tab: ${e.message}`); process.exit(1); }
  if (!tab.webSocketDebuggerUrl) { console.error("No webSocketDebuggerUrl in tab response"); process.exit(1); }

  let cdp;
  try { cdp = await cdpSession(tab.webSocketDebuggerUrl); }
  catch (e) { console.error(`CDP connect failed: ${e.message}`); process.exit(1); }

  const filled = [];
  const notFound = [];

  try {
    await cdp.send("Page.enable").catch(() => {});
    await cdp.send("DOM.enable").catch(() => {});
    await cdp.send("Runtime.enable").catch(() => {});

    console.log("\nWaiting for the form to load...");
    await waitForSelector(cdp, "form, input, textarea", 20000);
    console.log("Settling 3s for React hydration...");
    await sleep(3000);
    await waitForSelector(cdp, 'input[type="file"]', 6000);
    await sleep(400);

    // --- Resolve + tag targets in one pass ---
    const resolveRes = await cdp.send("Runtime.evaluate", {
      expression: buildResolverExpression(plan),
      returnByValue: true,
    }).catch(e => ({ error: e.message }));

    let resolved = { report: [], files: [] };
    try { resolved = JSON.parse(resolveRes.result?.value || "{}"); } catch (_) {}

    // --- Attach files via CDP DOM.setFileInputFiles ---
    const assignments = assignFiles(resolved.files || [], resumePdf, coverLetterPdf);
    if (!assignments.length) {
      console.log("\nNo file inputs detected — Rob attaches PDFs manually (or they appear after interaction).");
    }
    for (const a of assignments) {
      if (!a.file || !fs.existsSync(a.file)) {
        console.log(`  Attach SKIP: file not found: ${a.file}`);
        continue;
      }
      // Resolve the tagged file input to a nodeId, then set its files.
      try {
        const doc = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
        const q = await cdp.send("DOM.querySelector", {
          nodeId: doc.root.nodeId,
          selector: `input[type="file"][data-rob-file-id="${a.idx}"]`,
        });
        if (q.nodeId) {
          await cdp.send("DOM.setFileInputFiles", { nodeId: q.nodeId, files: [a.file] });
          const msg = `${path.basename(a.file)} → file input ${a.idx}${a.note ? ` [${a.note}]` : ""}`;
          console.log(`  Attached: ${msg}`);
        } else {
          console.log(`  Attach WARN: could not resolve file input ${a.idx} (shadow DOM / iframe?) — attach manually.`);
        }
      } catch (e) {
        console.log(`  Attach WARN: ${e.message} — attach manually.`);
      }
    }

    // --- Type each resolved text field via trusted CDP events ---
    console.log("\nFilling text fields...");
    for (const p of plan) {
      const rep = (resolved.report || []).find(r => r.name === p.name);
      if (!p.value) continue;
      if (!rep || rep.status !== "resolved") { notFound.push(p.name); continue; }
      const r = await typeIntoTagged(cdp, rep.fillId, String(p.value));
      if (r.ok) { filled.push(p.name); console.log(`  ✓ ${p.name}: ${String(r.landed).slice(0, 40)}`); }
      else { notFound.push(`${p.name} (typed but empty — verify)`); console.log(`  ✗ ${p.name}: ${r.reason || "did not stick"}`); }
    }

    // --- Cover-letter textarea fallback (only if a textarea was found) ---
    const coverRep = (resolved.report || []).find(r => r.fillId === "cover");
    if (coverRep && coverLetterText) {
      const r = await typeIntoTagged(cdp, "cover", coverLetterText);
      if (r.ok) { filled.push("Cover letter (pasted into textarea)"); console.log("  ✓ Cover letter pasted into textarea"); }
      else { notFound.push("Cover letter textarea (paste failed — paste manually)"); }
    } else if (coverLetterText && coverExists) {
      console.log("  Cover letter: form expects a PDF upload (no textarea) — attached as file.");
    }

  } catch (e) {
    console.error(`\nError during autofill: ${e.message}`);
  } finally {
    // Leave the tab OPEN for Rob. Just drop our debugging socket.
    cdp.close();
  }

  // --- Summary ---
  console.log("\n" + "─".repeat(64));
  console.log(`Filled (${filled.length}): ${filled.join(", ") || "none"}`);
  console.log(`Not found / Rob finishes (${notFound.length}): ${notFound.join(", ") || "none"}`);
  console.log("Dropdowns, EEO questions, and any other custom fields are Rob's to finish.");
  console.log("Tab left OPEN and UN-SUBMITTED. Rob reviews and submits. (autofill never submits.)");
  console.log("─".repeat(64));
}

main().catch(e => { console.error("Fatal:", e.message); process.exit(1); });
