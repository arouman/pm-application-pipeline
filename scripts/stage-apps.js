#!/usr/bin/env node
/**
 * stage-apps.js — open each application's form in Chrome, attach PDFs via CDP,
 * fill text fields via CDP Input.insertText (real keystrokes), and leave everything
 * staged for Rob.
 *
 * Dependency decision: ZERO npm deps. Node 26 ships built-in WebSocket (global) and
 * fetch, so we speak the Chrome DevTools Protocol directly over raw WebSocket + HTTP.
 * This keeps the tool self-contained — no node_modules, no npm install needed.
 *
 * Usage:
 *   node scripts/stage-apps.js <abs-path-to-applied/YYYY-MM-DD> [options]
 *
 * Options:
 *   --only <FolderName>   process only that one subfolder
 *   --max <N>             process at most N folders
 *   --dry-run             validate + print plan; open no tabs, touch no forms
 *   --refill              instead of opening new tabs, find ALREADY-OPEN tabs on port
 *                         9223 whose URLs match the date-dir folders, and re-type the
 *                         identity/essay fields on each. Does NOT re-attach files.
 *                         Use this to fix Ashby "required field" errors without
 *                         reopening everything.
 *
 * Prerequisites:
 *   scripts/chrome-debug.sh must be running (Job Applications Chrome on port 9223).
 *
 * Why CDP Input.insertText instead of injected JS events?
 *   Ashby (and some Greenhouse variants) use internal form state that only updates
 *   when the browser dispatches TRUSTED input events — i.e. events that originated
 *   from real user interaction or from the browser's own input pipeline. Synthetic
 *   events dispatched from injected JavaScript have isTrusted=false and are ignored
 *   by Ashby's validator, causing "required field" errors on submit even when the
 *   field visually shows a value.
 *
 *   CDP Input.insertText fires through the browser's own input stack and produces
 *   trusted events indistinguishable from typing. The autofill.js planOnly mode
 *   identifies and tags the target elements; stage-apps.js then types into them
 *   via CDP instead of setting values from JS.
 *
 * What it does per folder (new-tab mode):
 *   1. Opens a new tab at field-map.json#applyUrl
 *   2. Waits up to 20s for the form to hydrate (polls for <form> or <input type=file>)
 *   3. Attaches PDFs to file inputs via CDP DOM.setFileInputFiles
 *   4. Injects autofill.js in planOnly mode to tag target elements
 *   5. Types each value via CDP Input.insertText (focus → select-all → insertText → blur)
 *   6. Runs flagManual + panel via autofill.js for the orange outlines and summary panel
 *   7. Logs what was typed and what Rob needs to finish
 *   8. Never clicks submit. Never touches EEO dropdowns/radios.
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const http = require("http");

// ─── Paths ───────────────────────────────────────────────────────────────────

const REPO          = path.resolve(__dirname, "..");
const AUTOFILL_JS   = path.join(REPO, "extension", "autofill.js");
const PRIVATE_JSON  = path.join(REPO, "private", "applicant-profile.json");
const CDP_HOST      = "127.0.0.1";
const CDP_PORT      = 9223;

// ─── CLI parsing ─────────────────────────────────────────────────────────────

const args    = process.argv.slice(2);
const dateDir = args.find(a => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--only" && args[args.indexOf(a) - 1] !== "--max");

if (!dateDir) {
  console.error("Usage: node scripts/stage-apps.js <abs-path-to-applied/YYYY-MM-DD> [--only Folder] [--max N] [--dry-run] [--refill]");
  process.exit(1);
}

const onlyIdx   = args.indexOf("--only");
const maxIdx    = args.indexOf("--max");
const dryRun    = args.includes("--dry-run");
const refill    = args.includes("--refill");
const onlyName  = onlyIdx >= 0 ? args[onlyIdx + 1] : null;
const maxCount  = maxIdx  >= 0 ? parseInt(args[maxIdx + 1], 10) : Infinity;

// ─── Utilities ────────────────────────────────────────────────────────────────

/** Simple CDP over HTTP (for /json/* endpoints). */
function cdpGet(urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: CDP_HOST, port: CDP_PORT, path: urlPath }, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`CDP JSON parse error on ${urlPath}: ${e.message}`)); }
      });
    });
    req.on("error", reject);
  });
}

/** Open a new CDP tab at the given URL. Returns the target's webSocketDebuggerUrl.
 *
 * Newer Chrome (since ~v115) requires PUT for /json/new. We try PUT first;
 * if the response is the "unsafe HTTP verb" warning text we retry with GET
 * for any older Chrome still in the wild.
 */
async function openNewTab(url) {
  const encoded = encodeURIComponent(url);
  return new Promise((resolve, reject) => {
    const options = {
      host: CDP_HOST,
      port: CDP_PORT,
      path: `/json/new?${encoded}`,
      method: "PUT",
    };
    const req = http.request(options, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        // Chrome returns a plain-text warning when the wrong HTTP verb is used.
        if (data.startsWith("Using unsafe")) {
          // Fall back to GET for older Chrome.
          const req2 = http.get(
            { host: CDP_HOST, port: CDP_PORT, path: `/json/new?${encoded}` },
            res2 => {
              let d2 = "";
              res2.on("data", c => d2 += c);
              res2.on("end", () => {
                try { resolve(JSON.parse(d2)); } catch (e) { reject(e); }
              });
            }
          );
          req2.on("error", reject);
          return;
        }
        try {
          const tab = JSON.parse(data);
          resolve(tab);
        } catch (e) { reject(new Error(`/json/new parse error: ${e.message} — raw: ${data.slice(0, 80)}`)); }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

/** Wrap a CDP WebSocket session. Returns a helper { send(method,params), close() }. */
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
        close() { ws.close(); },
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

    ws.onerror = (e) => reject(new Error(`WebSocket error: ${e.message || "unknown"}`));
    ws.onclose = () => {
      for (const { rej } of pending.values()) rej(new Error("WebSocket closed"));
      pending.clear();
    };
  });
}

/** Poll the page until a CSS selector matches or timeout ms elapses. */
async function waitForSelector(cdp, selector, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await cdp.send("Runtime.evaluate", {
      expression: `!!document.querySelector(${JSON.stringify(selector)})`,
      returnByValue: true,
    });
    if (r.result && r.result.value === true) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

/** sleep helper */
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── File-input heuristics ────────────────────────────────────────────────────

/**
 * Given all visible file inputs on the page (as array of {nodeId, label}),
 * decide which gets the resume PDF and which gets the cover letter PDF.
 *
 * Rules:
 *   - If only 1 input: attach resume there; cover letter is manual.
 *   - If 2+ inputs: the one whose label matches /cover|letter/ gets cover; the one
 *     that matches /resume|cv/ (or the first) gets resume.
 */
function assignFiles(inputs, resumePdf, coverLetterPdf) {
  if (inputs.length === 0) return [];
  if (inputs.length === 1) {
    return [{ nodeId: inputs[0].nodeId, file: resumePdf, label: inputs[0].label, note: "cover-letter is manual" }];
  }
  const coverInput = inputs.find(i => /cover|letter/i.test(i.label));
  const resumeInput = inputs.find(i => /resume|cv/i.test(i.label)) || inputs[0];
  const assignments = [];
  if (resumeInput) assignments.push({ nodeId: resumeInput.nodeId, file: resumePdf, label: resumeInput.label, note: null });
  if (coverInput && coverInput !== resumeInput) {
    assignments.push({ nodeId: coverInput.nodeId, file: coverLetterPdf, label: coverInput.label, note: null });
  }
  return assignments;
}

// ─── CDP typed-fill ───────────────────────────────────────────────────────────

/**
 * Run the planOnly autofill pass, then type each value via CDP Input.insertText.
 *
 * Why: Ashby's form-state tracker only responds to trusted browser input events.
 * Synthetic JS events (isTrusted=false) make the value visible but the validator
 * never registers it, causing "required field" errors on submit. CDP Input.insertText
 * fires through the browser's own input pipeline and produces trusted events.
 *
 * Sequence per field:
 *   1. JS: scrollIntoView + focus() the element by data-rob-fill-id
 *   2. JS: setSelectionRange(0, 99999) if it's an input, or select-all for textarea
 *   3. CDP Input.insertText with the full value
 *   4. JS: blur() (triggers Ashby's onBlur validation handler)
 *
 * After all fields are typed, runs the panel/flagManual pass via autofill.js
 * (same code path as the console-snippet default, so counts are accurate).
 *
 * @param {object} cdp         - CDP session helper
 * @param {string} autofillEngine - full text of autofill.js
 * @param {object} enrichedMap - merged field-map payload
 * @returns {{ typed: string[], manual: string[] }}
 */
async function runTypedFill(cdp, autofillEngine, enrichedMap) {
  const payload = JSON.stringify(enrichedMap);

  // Step 1: inject autofill in planOnly mode to tag elements and build the plan
  const planSnippet = `${autofillEngine}\nrobAutofill(${payload}, {planOnly: true});`;
  const planResult = await cdp.send("Runtime.evaluate", {
    expression: planSnippet,
    returnByValue: true,
    awaitPromise: false,
  });

  // Read the plan from window.__robFillPlan
  const planReadResult = await cdp.send("Runtime.evaluate", {
    expression: "JSON.stringify(window.__robFillPlan || [])",
    returnByValue: true,
  });

  let plan = [];
  try {
    plan = JSON.parse(planReadResult.result.value || "[]");
  } catch (_) {}

  if (plan.length === 0) {
    return { typed: [], manual: [] };
  }

  const typed = [];

  // Step 2: for each planned field, focus → select-all → insertText → blur
  for (const field of plan) {
    const fillId = field.id;
    const value  = field.value;

    if (!value) continue;

    // Focus and select-all existing content so our text replaces it
    const focusExpr = `
      (function() {
        const el = document.querySelector('[data-rob-fill-id="${fillId}"]');
        if (!el) return false;
        el.scrollIntoView({ block: "center", behavior: "instant" });
        el.focus();
        if (el.tagName === "TEXTAREA") {
          el.setSelectionRange(0, el.value.length);
        } else {
          el.setSelectionRange(0, el.value.length);
        }
        return true;
      })()
    `;
    const focusResult = await cdp.send("Runtime.evaluate", {
      expression: focusExpr,
      returnByValue: true,
    });

    if (!focusResult.result || focusResult.result.value !== true) {
      console.log(`      WARN: could not focus element data-rob-fill-id="${fillId}" (${field.label})`);
      continue;
    }

    // Small pause so focus settles before we type
    await sleep(80);

    // Type the value via CDP — produces trusted events
    await cdp.send("Input.insertText", { text: value });

    // Small pause then blur — triggers Ashby's onBlur validation handler
    await sleep(80);
    await cdp.send("Runtime.evaluate", {
      expression: `document.querySelector('[data-rob-fill-id="${fillId}"]')?.blur()`,
      returnByValue: false,
    });

    await sleep(50);

    // Verify the value landed
    const verifyResult = await cdp.send("Runtime.evaluate", {
      expression: `document.querySelector('[data-rob-fill-id="${fillId}"]')?.value`,
      returnByValue: true,
    });
    const landed = verifyResult.result?.value;
    const ok = typeof landed === "string" && landed.length > 0;
    typed.push(`${field.label}: ${ok ? "OK" : "EMPTY — check manually"}`);
    console.log(`      Typed [${field.label}]: ${ok ? `OK (${landed.slice(0, 40)}${landed.length > 40 ? "…" : ""})` : "EMPTY — verify manually"}`);
  }

  // Step 3: run flagManual + panel (the non-planOnly path in autofill.js)
  // We inject the engine again in normal fill mode but with an already-filled
  // form — fillFields will skip non-empty inputs, so it just runs panel + outlines.
  const panelSnippet = `${autofillEngine}\nrobAutofill(${payload});`;
  await cdp.send("Runtime.evaluate", {
    expression: panelSnippet,
    returnByValue: true,
    awaitPromise: false,
  });

  // Read manual list from the second pass return value isn't easily catchable
  // via returnByValue on the panel pass (it also sets up DOM), so we read the
  // flagManual result separately.
  const manualResult = await cdp.send("Runtime.evaluate", {
    expression: `
      (function() {
        // Re-run flagManual logic inline to read the current state
        const visible = el => el.offsetParent !== null && !el.disabled && !el.readOnly;
        const manual = [];
        document.querySelectorAll("select").forEach(el => {
          if (visible(el)) manual.push("dropdown: " + (el.name || el.id || "?").slice(0,40));
        });
        document.querySelectorAll('[role="combobox"],[role="listbox"]').forEach(el => {
          if (el.offsetParent !== null) manual.push("dropdown: " + (el.getAttribute("aria-label") || "?").slice(0,40));
        });
        document.querySelectorAll('input[type="radio"],input[type="checkbox"]').forEach(el => {
          if (visible(el)) manual.push(el.type + ": " + (el.name || el.id || "?").slice(0,40));
        });
        return JSON.stringify([...new Set(manual)]);
      })()
    `,
    returnByValue: true,
  });

  let manual = [];
  try { manual = JSON.parse(manualResult.result?.value || "[]"); } catch (_) {}

  return { typed, manual };
}

// ─── JD-page → form-page URL rewrites ────────────────────────────────────────

/**
 * Known ATS platforms where the JD page URL can be deterministically rewritten
 * to the form URL without any DOM interaction. Add new entries here as they are
 * discovered.
 *
 * Rules:
 *   - Stripe: /jobs/listing/<slug>/<id>  →  /jobs/listing/<slug>/<id>/apply
 *     Stripe's apply form is always at the listing URL + "/apply".
 *
 * Ashby is handled separately below (appends /application).
 * Never rewrite to a submit endpoint — only to a form-load URL.
 */
function rewriteToFormUrl(url) {
  // Stripe: jobs/listing/<slug>/<id> → jobs/listing/<slug>/<id>/apply
  if (/stripe\.com\/jobs\/listing\/[^/]+\/\d+\/?$/.test(url)) {
    return url.replace(/\/?$/, "") + "/apply";
  }
  return url;
}

// ─── Apply-button advance ─────────────────────────────────────────────────────

/**
 * After page load, check if we're on a JD page (no form present) and, if so,
 * click the "Apply" control to advance to the actual application form.
 *
 * Strategy:
 *   1. If a <form> or <input type=file> is already present → nothing to do.
 *   2. Find an <a href> whose text starts with "apply" → navigate via Page.navigate
 *      (more reliable than synthetic click; avoids re-rendering the tab's history).
 *   3. Find a <button> or [role=button] whose text starts with "apply" → el.click().
 *      This is navigation, not form submission — it is always safe to click an
 *      element whose text matches /^\s*apply(\s|$)/i.
 *
 * SAFETY COMMENT — never-submit boundary:
 *   - The apply-text regex requires the text to START WITH "apply". This rules out
 *     "Submit application", "Submit your application", or any other submit-adjacent
 *     phrasing. A button whose text is "Apply" or "Apply now" is an entry point to
 *     a form; a button whose text contains "submit" is the form's submission trigger.
 *   - We additionally guard with /submit/i — if any candidate element's text matches
 *     /submit/i, we skip it unconditionally, even if it also matches the apply regex.
 *   - We never click anything when a form/file-input is already present on the page.
 *     That is the hard never-submit boundary: once a form is in the DOM, we stop
 *     all advance logic and proceed with attach+fill.
 *
 * @param {object} cdp  - CDP session helper
 * @param {string} tabUrl - current tab URL (used for Page.navigate base)
 * @returns {{ advanced: boolean, method: string, href?: string }}
 */
async function advanceToForm(cdp, tabUrl) {
  // Step 1: bail immediately if a VISIBLE form or file input is already present.
  // "Visible" means not hidden by a [hidden] attribute and has layout (offsetParent
  // is not null). Some pages (e.g. Airbnb) embed a Greenhouse form in a hidden panel
  // that is in the DOM before the "Apply" tab is clicked — that should NOT count.
  //
  // NEVER-SUBMIT BOUNDARY: once a visible form is in the DOM, we stop all advance
  // logic unconditionally. Advancing past a visible form risks clicking something
  // that submits it. The [hidden] carve-out is deliberate and narrow.
  const formPresent = await cdp.send("Runtime.evaluate", {
    expression: `
      (function() {
        // Check visible <form> elements (not hidden, has layout)
        const forms = Array.from(document.querySelectorAll('form'));
        for (const f of forms) {
          if (!f.hasAttribute('hidden') && f.offsetParent !== null) return true;
        }
        // Check visible file inputs
        const files = Array.from(document.querySelectorAll('input[type="file"]'));
        for (const fi of files) {
          if (!fi.hasAttribute('hidden') && !fi.closest('[hidden]')) return true;
        }
        return false;
      })()
    `,
    returnByValue: true,
  });
  if (formPresent.result?.value === true) {
    return { advanced: false, method: "form-already-present" };
  }

  // Step 2: look for an <a href> whose trimmed text starts with "apply" (case-insensitive)
  // and does NOT contain "submit". If found, use Page.navigate instead of clicking.
  const linkResult = await cdp.send("Runtime.evaluate", {
    expression: `
      (function() {
        const applyRe = /^\\s*apply(\\s|$)/i;
        const submitRe = /submit/i;
        const links = Array.from(document.querySelectorAll('a[href]'));
        for (const a of links) {
          const text = (a.textContent || a.getAttribute('aria-label') || '').trim();
          if (applyRe.test(text) && !submitRe.test(text)) {
            // Return absolute href
            return a.href || null;
          }
        }
        return null;
      })()
    `,
    returnByValue: true,
  });
  const applyHref = linkResult.result?.value;
  if (applyHref && typeof applyHref === "string" && applyHref.startsWith("http")) {
    console.log(`    Apply link found → navigating to: ${applyHref}`);
    await cdp.send("Page.navigate", { url: applyHref });
    // Wait for load event to fire after navigation
    await sleep(2000);
    return { advanced: true, method: "link-navigate", href: applyHref };
  }

  // Step 3: look for a <button> or [role=button] whose text starts with "apply".
  // el.click() here is safe — this is a navigation action, not form submission.
  const buttonResult = await cdp.send("Runtime.evaluate", {
    expression: `
      (function() {
        const applyRe = /^\\s*apply(\\s|$)/i;
        const submitRe = /submit/i;
        const candidates = Array.from(
          document.querySelectorAll('button, [role="button"]')
        );
        for (const el of candidates) {
          const text = (el.textContent || el.getAttribute('aria-label') || '').trim();
          if (applyRe.test(text) && !submitRe.test(text)) {
            el.click();
            return text;
          }
        }
        return null;
      })()
    `,
    returnByValue: true,
  });
  const clickedText = buttonResult.result?.value;
  if (clickedText && typeof clickedText === "string") {
    console.log(`    Apply button clicked: "${clickedText}"`);
    await sleep(2000);
    return { advanced: true, method: "button-click", label: clickedText };
  }

  return { advanced: false, method: "no-apply-control-found" };
}

// ─── URL matching helpers ─────────────────────────────────────────────────────

/**
 * Normalize an Ashby URL for matching: strip /application suffix if present,
 * strip trailing slash, lowercase.
 */
function normalizeUrl(url) {
  return url
    .replace(/\/application\/?$/, "")
    .replace(/\/$/, "")
    .toLowerCase();
}

/**
 * Given a tab URL and a field-map applyUrl, return true if they refer to the
 * same application form (regardless of /application suffix, trailing slash, or
 * apply-path variants for Stripe etc.).
 *
 * Greenhouse: field-map uses boards.greenhouse.io; tab may show job-boards.greenhouse.io —
 * match on the job ID path segment.
 */
function urlsMatch(tabUrl, fieldMapUrl) {
  const normTab = normalizeUrl(tabUrl);
  const normMap = normalizeUrl(fieldMapUrl);

  // Exact normalized match
  if (normTab === normMap) return true;

  // Prefix match: tab URL starts with the normalized field-map URL
  if (normTab.startsWith(normMap)) return true;

  // Greenhouse: boards.greenhouse.io vs job-boards.greenhouse.io — same job ID path
  const ghJobId = fieldMapUrl.match(/greenhouse\.io\/[^/]+\/jobs\/(\d+)/);
  if (ghJobId) {
    const tabGhId = tabUrl.match(/greenhouse\.io\/[^/]+\/jobs\/(\d+)/);
    if (tabGhId && tabGhId[1] === ghJobId[1]) return true;
  }

  // Stripe: listing URL vs /apply variant — match on the numeric job ID
  const stripeId = fieldMapUrl.match(/stripe\.com\/jobs\/(?:listing|search)[^/]*\/(\d+)/);
  if (stripeId) {
    const tabStripeId = tabUrl.match(/stripe\.com\/jobs\/(?:listing|search)[^/]*\/(\d+)/);
    if (tabStripeId && tabStripeId[1] === stripeId[1]) return true;
    // Also match gh_jid= query param (Stripe sometimes uses Greenhouse backend)
    const ghParam = tabUrl.match(/gh_jid=(\d+)/);
    if (ghParam && ghParam[1] === stripeId[1]) return true;
  }

  // Stripe gh_jid in field-map URL matches tab listing URL
  const mapGhJid = fieldMapUrl.match(/gh_jid=(\d+)/);
  if (mapGhJid) {
    const tabNum = tabUrl.match(/\/(\d+)(?:\/|$|\?)/);
    if (tabNum && tabNum[1] === mapGhJid[1]) return true;
    const tabGhJid = tabUrl.match(/gh_jid=(\d+)/);
    if (tabGhJid && tabGhJid[1] === mapGhJid[1]) return true;
  }

  return false;
}

// ─── Shared: build enrichedMap ────────────────────────────────────────────────

function buildEnrichedMap(fieldMap) {
  let privateProfile = {};
  if (fs.existsSync(PRIVATE_JSON)) {
    privateProfile = JSON.parse(fs.readFileSync(PRIVATE_JSON, "utf8"));
  }

  const privateId = privateProfile.identity || {};
  const mergedIdentity = {
    firstName: fieldMap.identity?.firstName || privateId.fullName?.split(" ")[0],
    lastName:  fieldMap.identity?.lastName  || privateId.fullName?.split(" ").slice(1).join(" "),
    fullName:  fieldMap.identity?.fullName  || privateId.fullName,
    email:     fieldMap.identity?.email     || privateId.email,
    phone:     fieldMap.identity?.phone     || privateId.phone,
    linkedin:  fieldMap.identity?.linkedin  || privateId.linkedin,
    github:    fieldMap.identity?.github    || privateId.github,
    website:   fieldMap.identity?.website   || privateId.website,
    location:  fieldMap.identity?.location  || privateId.locationForApplications || privateId.location,
  };

  return { ...fieldMap, identity: mergedIdentity };
}

// ─── Per-folder staging logic (new-tab mode) ──────────────────────────────────

async function stageFolder(folderPath, dryRun) {
  const name = path.basename(folderPath);
  const fieldMapPath = path.join(folderPath, "field-map.json");

  // --- Validate ---
  if (!fs.existsSync(fieldMapPath)) {
    console.log(`  [${name}] SKIP — no field-map.json`);
    return { skipped: true };
  }

  const fieldMap = JSON.parse(fs.readFileSync(fieldMapPath, "utf8"));
  const { resumePdf, coverLetterPdf } = fieldMap;

  if (!fieldMap.applyUrl) {
    console.log(`  [${name}] SKIP — field-map.json missing applyUrl`);
    return { skipped: true };
  }

  // ── URL rewrites: known JD-page → form-page shortcuts ──────────────────────
  // These avoid the apply-button-click step entirely by jumping straight to the
  // form URL when the ATS has a predictable form URL pattern.
  //
  // SAFETY: never rewrite to a submit endpoint. All targets here are form-load URLs.
  let applyUrl = rewriteToFormUrl(fieldMap.applyUrl);

  // Ashby job-listing URLs don't show a form; the form is at <url>/application.
  // Normalise: append /application if it's an Ashby URL without it.
  if (/jobs\.ashbyhq\.com/i.test(applyUrl) && !/\/application\/?$/.test(applyUrl)) {
    applyUrl = applyUrl.replace(/\/?$/, "") + "/application";
  }

  const resumeExists      = resumePdf      && fs.existsSync(resumePdf);
  const coverLetterExists = coverLetterPdf && fs.existsSync(coverLetterPdf);

  if (dryRun) {
    console.log(`\n  [DRY-RUN] ${name}`);
    console.log(`    URL:         ${applyUrl}`);
    console.log(`    Resume PDF:  ${resumePdf  ? (resumeExists  ? "FOUND" : "MISSING") : "not set"} ${resumePdf  ? path.basename(resumePdf)  : ""}`);
    console.log(`    Cover PDF:   ${coverLetterPdf ? (coverLetterExists ? "FOUND" : "MISSING") : "not set"} ${coverLetterPdf ? path.basename(coverLetterPdf) : ""}`);
    console.log(`    Company:     ${fieldMap.company || "?"}`);
    return { skipped: false, dryRun: true };
  }

  if (!resumeExists) {
    console.log(`  [${name}] WARN — resume PDF not found at ${resumePdf}`);
  }
  if (!coverLetterExists) {
    console.log(`  [${name}] WARN — cover letter PDF not found at ${coverLetterPdf}`);
  }

  // --- Load autofill engine ---
  const autofillEngine = fs.readFileSync(AUTOFILL_JS, "utf8");
  const enrichedMap = buildEnrichedMap(fieldMap);

  console.log(`\n  [${name}] Opening ${applyUrl}`);

  // --- Open tab ---
  let tab;
  try {
    tab = await openNewTab(applyUrl);
  } catch (e) {
    console.error(`  [${name}] FAILED to open tab: ${e.message}`);
    console.error(`           Is Chrome running? Run: bash scripts/chrome-debug.sh`);
    return { skipped: false, error: e.message };
  }

  const wsUrl = tab.webSocketDebuggerUrl;
  if (!wsUrl) {
    console.error(`  [${name}] No webSocketDebuggerUrl in tab response`);
    return { skipped: false, error: "no wsUrl" };
  }

  // --- Connect CDP session ---
  let cdp;
  try {
    cdp = await cdpSession(wsUrl);
  } catch (e) {
    console.error(`  [${name}] CDP connect failed: ${e.message}`);
    return { skipped: false, error: e.message };
  }

  try {
    // Enable necessary domains
    await cdp.send("Page.enable");
    await cdp.send("DOM.enable");
    await cdp.send("Runtime.enable");

    // Wait for page to load (Page.loadEventFired equivalent via polling)
    console.log(`    Waiting for page load...`);
    const formFound = await waitForSelector(cdp, "form, input, textarea", 20000);
    if (!formFound) {
      console.log(`    Warn: no form/input detected within 20s — will try apply-advance step`);
    }

    // Extra settle time — ATS forms (especially Ashby/Greenhouse) hydrate React after DOMContentLoaded
    console.log(`    Settling 3s for React hydration...`);
    await sleep(3000);

    // ── Apply-advance step ───────────────────────────────────────────────────
    // If we landed on a JD page (no form/file-input present), look for an
    // "Apply" link or button and advance the tab to the actual form.
    // Skipped automatically when the form is already present.
    const tabUrlForAdvance = applyUrl; // used only for logging context
    const advanceResult = await advanceToForm(cdp, tabUrlForAdvance);
    if (advanceResult.advanced) {
      console.log(`    Advanced to form via ${advanceResult.method} — waiting for form to hydrate...`);
      // Re-run the wait-for-form with a fresh 20s budget after advancing
      const formFoundAfterAdvance = await waitForSelector(cdp, "form, input, textarea", 20000);
      if (!formFoundAfterAdvance) {
        console.log(`    No form found after apply-advance — proceeding anyway (may need login or manual navigation)`);
      }
      // Additional React hydration settle after the advance
      await sleep(3000);
    }
    // ────────────────────────────────────────────────────────────────────────

    // Wait for file inputs specifically (may appear after hydration)
    await waitForSelector(cdp, 'input[type="file"]', 8000);
    await sleep(500);

    // --- Get all file inputs via CDP DOM ---
    const docResult = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
    const rootNodeId = docResult.root.nodeId;

    const fileInputsResult = await cdp.send("DOM.querySelectorAll", {
      nodeId: rootNodeId,
      selector: 'input[type="file"]',
    });

    const fileInputNodeIds = fileInputsResult.nodeIds || [];

    // Get label context for each file input
    const inputInfos = [];
    for (const nodeId of fileInputNodeIds) {
      const attrsResult = await cdp.send("DOM.getAttributes", { nodeId });
      const attrs = attrsResult.attributes || [];
      const attrMap = {};
      for (let i = 0; i < attrs.length - 1; i += 2) attrMap[attrs[i].toLowerCase()] = attrs[i + 1];

      const labelHint = [attrMap.name, attrMap.id, attrMap.accept, attrMap["aria-label"], attrMap["data-testid"]]
        .filter(Boolean).join(" ").toLowerCase();
      inputInfos.push({ nodeId, label: labelHint });
    }

    // Assign PDFs to inputs
    const assignments = assignFiles(inputInfos, resumePdf, coverLetterPdf);

    // --- Attach files via CDP DOM.setFileInputFiles ---
    const attached = [];
    for (const { nodeId, file, label, note } of assignments) {
      if (!file || !fs.existsSync(file)) {
        console.log(`    SKIP attach: file not found: ${file}`);
        continue;
      }
      try {
        await cdp.send("DOM.setFileInputFiles", {
          nodeId,
          files: [file],
        });
        const fname = path.basename(file);
        const msg = note ? `${fname} → (${label || "file input"}) [${note}]` : `${fname} → (${label || "file input"})`;
        console.log(`    Attached: ${msg}`);
        attached.push(msg);
      } catch (e) {
        console.log(`    WARN: setFileInputFiles failed for nodeId ${nodeId}: ${e.message}`);
        try {
          const jsAttach = await cdp.send("Runtime.evaluate", {
            expression: `
              (function() {
                const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
                if (!inputs.length) return 'no-inputs';
                return 'found:' + inputs.length;
              })()
            `,
            returnByValue: true,
          });
          console.log(`    Note: shadow-DOM probe result: ${jsAttach.result?.value}`);
        } catch (_) {}
      }
    }

    if (fileInputNodeIds.length > 0 && attached.length === 0) {
      console.log(`    WARN: ${fileInputNodeIds.length} file input(s) found but none could be attached (may be shadow DOM or iframe). Rob: attach PDFs manually.`);
    } else if (fileInputNodeIds.length === 0) {
      console.log(`    No file inputs detected at page load — may appear after interaction, or this ATS uses drag-drop. Rob: attach PDFs manually.`);
    }

    if (assignments.length === 1 && assignments[0].note === "cover-letter is manual" && coverLetterPdf) {
      console.log(`    Note: only 1 file input found — cover letter PDF is manual: ${path.basename(coverLetterPdf)}`);
    }

    // --- Type fields via CDP (trusted events) ---
    console.log(`    Typing identity/essay fields via CDP...`);
    const { typed, manual } = await runTypedFill(cdp, autofillEngine, enrichedMap);

    console.log(`    Text fields typed: ${typed.length}`);
    if (manual.length > 0) {
      console.log(`    Manual (Rob finishes):`);
      manual.forEach(m => console.log(`      - ${m}`));
    }

    console.log(`    Tab staged and left open. Do NOT submit — Rob reviews and submits.`);

    cdp.close();
    return { skipped: false, attached: attached.length, filled: typed.length, manual };

  } catch (e) {
    console.error(`  [${name}] Error during staging: ${e.message}`);
    cdp.close();
    return { skipped: false, error: e.message };
  }
}

// ─── Refill mode ─────────────────────────────────────────────────────────────

/**
 * --refill: enumerate already-open tabs on port 9223, match each tab's URL against
 * the date-dir folders' applyUrls, and for each match re-type identity/essay fields
 * via CDP Input.insertText.
 *
 * Does NOT re-attach files (they're already there). Does NOT navigate tabs.
 * Does NOT touch non-matching tabs.
 */
async function runRefill(dateDir, folders) {
  console.log(`\nRefill mode — re-typing fields on already-open tabs`);
  console.log(`Port: ${CDP_PORT}  |  Folders: ${folders.length}\n`);

  // Get list of all open page tabs
  let allTabs;
  try {
    allTabs = await cdpGet("/json");
  } catch (e) {
    console.error(`Cannot list tabs on port ${CDP_PORT}: ${e.message}`);
    process.exit(1);
  }

  const pageTabs = allTabs.filter(t => t.type === "page" && t.webSocketDebuggerUrl);
  console.log(`Open page tabs: ${pageTabs.length}\n`);

  // Load autofill engine once
  const autofillEngine = fs.readFileSync(AUTOFILL_JS, "utf8");

  // Build a map: normalized field-map applyUrl → { folder, fieldMap, enrichedMap }
  const folderByUrl = new Map();
  for (const folderPath of folders) {
    const fieldMapPath = path.join(folderPath, "field-map.json");
    if (!fs.existsSync(fieldMapPath)) continue;
    const fieldMap = JSON.parse(fs.readFileSync(fieldMapPath, "utf8"));
    if (!fieldMap.applyUrl) continue;
    const enrichedMap = buildEnrichedMap(fieldMap);
    folderByUrl.set(folderPath, { folderPath, fieldMap, enrichedMap });
  }

  const results = [];

  for (const tab of pageTabs) {
    const tabUrl = tab.url || "";
    const tabId  = tab.id;

    // Find matching folder
    let matched = null;
    for (const [fp, entry] of folderByUrl) {
      if (urlsMatch(tabUrl, entry.fieldMap.applyUrl)) {
        matched = entry;
        break;
      }
    }

    if (!matched) {
      console.log(`  SKIP  [${tabUrl.slice(0, 70)}]  — no matching folder`);
      results.push({ tab: tabUrl, status: "skipped", reason: "no match" });
      continue;
    }

    const company = matched.fieldMap.company || path.basename(matched.folderPath);
    console.log(`\n  REFILL  [${company}]`);
    console.log(`    Tab:  ${tabUrl}`);
    console.log(`    Map:  ${matched.fieldMap.applyUrl}`);

    // Connect to the tab
    let cdp;
    try {
      cdp = await cdpSession(tab.webSocketDebuggerUrl);
    } catch (e) {
      console.error(`    CDP connect failed: ${e.message}`);
      results.push({ tab: tabUrl, company, status: "error", reason: e.message });
      continue;
    }

    try {
      await cdp.send("Page.enable");
      await cdp.send("Runtime.enable");

      // Brief settle in case the page is mid-render
      await sleep(300);

      // ── Apply-advance step (refill mode) ──────────────────────────────────
      // If this tab is sitting on a JD page (no form), advance it to the form
      // before attempting to re-type fields.
      const refillAdvance = await advanceToForm(cdp, tabUrl);
      if (refillAdvance.advanced) {
        console.log(`    Advanced to form via ${refillAdvance.method} — waiting for form...`);
        const refillFormFound = await waitForSelector(cdp, "form, input, textarea", 20000);
        if (!refillFormFound) {
          console.log(`    No form found after apply-advance — may need login or manual navigation`);
        }
        await sleep(3000);
      }
      // ──────────────────────────────────────────────────────────────────────

      // Type fields via CDP
      const { typed, manual } = await runTypedFill(cdp, autofillEngine, matched.enrichedMap);

      console.log(`    Typed: ${typed.length} field(s)`);
      if (typed.length === 0) {
        console.log(`    (no matching empty fields found — may already be filled or form differs)`);
      }
      if (manual.length > 0) {
        console.log(`    Manual: ${manual.slice(0, 4).join(", ")}${manual.length > 4 ? ` +${manual.length - 4} more` : ""}`);
      }

      cdp.close();
      results.push({ tab: tabUrl, company, status: "refilled", typed: typed.length, manual: manual.length });

    } catch (e) {
      console.error(`    Error: ${e.message}`);
      try { cdp.close(); } catch (_) {}
      results.push({ tab: tabUrl, company, status: "error", reason: e.message });
    }

    // Brief pause between tabs
    await sleep(800);
  }

  // Summary table
  console.log(`\n${"─".repeat(70)}`);
  console.log(`Refill results (${results.length} tabs examined)`);
  console.log(`${"─".repeat(70)}`);
  const colW = 28;
  for (const r of results) {
    const name = (r.company || r.tab.slice(-40)).slice(0, colW).padEnd(colW);
    if (r.status === "refilled") {
      console.log(`  ${name}  refilled  ${r.typed} field(s)  |  ${r.manual} manual`);
    } else if (r.status === "skipped") {
      console.log(`  ${name}  skipped   (${r.reason})`);
    } else {
      console.log(`  ${name}  ERROR     ${r.reason}`);
    }
  }

  const refilled = results.filter(r => r.status === "refilled").length;
  const skipped  = results.filter(r => r.status === "skipped").length;
  const errors   = results.filter(r => r.status === "error").length;
  console.log(`\nRefilled: ${refilled}  Skipped: ${skipped}  Errors: ${errors}`);
  console.log("All tabs left open. Rob reviews and submits each form.");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // Validate dateDir exists
  if (!fs.existsSync(dateDir)) {
    console.error(`Error: directory not found: ${dateDir}`);
    process.exit(1);
  }

  // Check Chrome is reachable (unless dry-run)
  if (!dryRun) {
    try {
      await cdpGet("/json/version");
    } catch (e) {
      console.error(`Cannot reach Job Applications Chrome on port ${CDP_PORT}: ${e.message}`);
      console.error(`Run: bash scripts/chrome-debug.sh`);
      process.exit(1);
    }
  }

  // Discover folders
  const entries = fs.readdirSync(dateDir, { withFileTypes: true });
  let folders = entries
    .filter(e => e.isDirectory())
    .map(e => path.join(dateDir, e.name))
    .filter(f => fs.existsSync(path.join(f, "field-map.json")));

  if (onlyName) {
    folders = folders.filter(f => path.basename(f) === onlyName);
    if (folders.length === 0) {
      console.error(`No folder named "${onlyName}" with a field-map.json under ${dateDir}`);
      process.exit(1);
    }
  }

  folders = folders.slice(0, maxCount);

  if (folders.length === 0) {
    console.log("No folders with field-map.json found.");
    process.exit(0);
  }

  // ── Refill mode ──
  if (refill) {
    await runRefill(dateDir, folders);
    return;
  }

  // ── Normal (new-tab) mode ──
  console.log(`\nstage-apps.js — ${dryRun ? "DRY RUN" : "LIVE"}`);
  console.log(`Directory: ${dateDir}`);
  console.log(`Folders:   ${folders.length}`);
  if (onlyName) console.log(`Filter:    --only ${onlyName}`);
  if (maxCount < Infinity) console.log(`Max:       ${maxCount}`);
  console.log("");

  let processed = 0, skipped = 0, errors = 0;

  for (const folder of folders) {
    const result = await stageFolder(folder, dryRun);
    if (result.skipped) skipped++;
    else if (result.error) errors++;
    else processed++;

    // Brief pause between tabs so Chrome can settle
    if (!dryRun && folders.indexOf(folder) < folders.length - 1) {
      await sleep(2000);
    }
  }

  console.log(`\nDone. Staged: ${processed}  Skipped: ${skipped}  Errors: ${errors}`);
  if (!dryRun && processed > 0) {
    console.log("Tabs are open in Chrome. Rob: finish dropdowns, EEO, and submit each form.");
    console.log("REMINDER: Never submit — that's always Rob's step.");
  }
}

main().catch(e => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
