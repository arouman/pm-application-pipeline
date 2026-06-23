/**
 * parse.test.js — unit tests for the pure URL/HTML helpers in server.js.
 *
 * These import the helpers directly (no HTTP, no subprocess, no network), so
 * they're fast and deterministic. BRIDGE_NO_LISTEN=1 tells server.js to export
 * its helpers without binding a port. Covers the ATS adapters that decide the
 * ledger dedup key: a wrong key here silently double-applies or mis-merges a
 * role, so every adapter gets an explicit assertion.
 *
 * Run:  BRIDGE_NO_LISTEN=1 node --test bridge/parse.test.js
 *       (run-tests.sh runs all bridge/*.test.js together)
 */
import { test } from "node:test";
import assert from "node:assert/strict";

// Importing server.js starts the HTTP server unless we suppress it. Set the
// flag BEFORE the import so the top-level listen() guard sees it.
process.env.BRIDGE_NO_LISTEN = "1";
const { parseJobUrl, canonicalKey, extractHtmlTitle, decodeEntities,
        visibleTextLength, isCsrfBlocked, isAllowedClient } = await import("./server.js");

// ---------------------------------------------------------------------------
// Workday adapter
// ---------------------------------------------------------------------------

test("Workday URL → workday:<JR> key (prefers the requisition token)", () => {
  const p = parseJobUrl(
    "https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/Product-Designer_JR-0094299",
    []);
  assert.equal(p.ats, "workday");
  assert.equal(p.slug, "nvidia/NVIDIAExternalCareerSite"); // tenant/site for CXS
  assert.equal(p.jobId, "JR-0094299");
  assert.equal(canonicalKey(p.ats, p.jobId), "workday:JR-0094299");
});

test("Workday URL without a <lang> segment still parses", () => {
  const p = parseJobUrl(
    "https://acme.wd1.myworkdayjobs.com/External/job/New-York/Staff-Engineer_R-12345",
    []);
  assert.equal(p.ats, "workday");
  assert.equal(p.slug, "acme/External");
  assert.equal(p.jobId, "R-12345");
});

test("Workday URL with no requisition token falls back to the last segment", () => {
  const p = parseJobUrl(
    "https://acme.wd1.myworkdayjobs.com/en-US/External/job/Remote/Some-Role-No-Id",
    []);
  assert.equal(p.ats, "workday");
  assert.equal(p.jobId, "Some-Role-No-Id"); // still collision-proof
});

test("Workday host without /job/ path is NOT mis-claimed (falls through)", () => {
  // A bare careers landing page on a Workday host shouldn't become a workday
  // job entry — it has no /job/ segment, so it drops to the web: fallback.
  const p = parseJobUrl(
    "https://acme.wd1.myworkdayjobs.com/en-US/External", []);
  assert.equal(p.ats, "web");
});

// ---------------------------------------------------------------------------
// careers.bcg.com (Phenom) adapter — must reproduce the watcher's bcg:<id> key
// ---------------------------------------------------------------------------

test("careers.bcg.com URL → bcg:<digits> key (dedupes with watcher entries)", () => {
  const p = parseJobUrl(
    "https://careers.bcg.com/global/en/job/54551/Associate-Experienced-Hire-United-States",
    []);
  assert.equal(p.ats, "bcg");
  assert.equal(p.slug, "bcg");
  assert.equal(p.jobId, "54551");
  // This MUST equal the existing ledger key shape exactly.
  assert.equal(canonicalKey(p.ats, p.jobId), "bcg:54551");
});

test("careers.bcg.com URL with a leading-space slug still keys on the digits", () => {
  const p = parseJobUrl(
    "https://careers.bcg.com/global/en/job/58305/-Senior-AI-Factory-Product-Builder-London-BCG-X",
    []);
  assert.equal(canonicalKey(p.ats, p.jobId), "bcg:58305");
});

test("careers.bcg.com without a numeric /job/<digits>/ is NOT claimed", () => {
  // A non-job BCG page (no numeric id) should fall through to web:, not pretend
  // to be a bcg job with a bogus id.
  const p = parseJobUrl("https://careers.bcg.com/global/en/search", []);
  assert.equal(p.ats, "web");
});

// ---------------------------------------------------------------------------
// frog must keep flowing through the generic web: fallback (regression guard)
// ---------------------------------------------------------------------------

test("frog careers URL stays on the web: fallback (NOT caught by bcg)", () => {
  const url =
    "https://www.frog.co/careers/jobs/699c5d66939f64fc32ab707b-london-design-422150";
  const p = parseJobUrl(url, []);
  assert.equal(p.ats, "web");
  assert.equal(p.slug, "www.frog.co"); // slug keeps the real host for fetching
  // jobId is now host-LESS (path only) so www./non-www. variants produce the same key.
  assert.equal(p.jobId, "careers/jobs/699c5d66939f64fc32ab707b-london-design-422150");
  assert.equal(canonicalKey(p.ats, p.jobId),
    "web:careers/jobs/699c5d66939f64fc32ab707b-london-design-422150");
});

// Gap 1 regression: www. and non-www. frog URLs must produce the same key.
test("frog URL with www. and without produce identical web: key", () => {
  const withWww = parseJobUrl(
    "https://www.frog.co/careers/jobs/69dd8ae6939f64fc32b26ea9-munich-design", []);
  const noWww = parseJobUrl(
    "https://frog.co/careers/jobs/69dd8ae6939f64fc32b26ea9-munich-design", []);
  assert.equal(withWww.ats, "web");
  assert.equal(noWww.ats, "web");
  assert.equal(canonicalKey(withWww.ats, withWww.jobId),
               canonicalKey(noWww.ats, noWww.jobId),
               "www. and non-www. variants of the same URL must produce the same key");
});

// ---------------------------------------------------------------------------
// Existing adapters still resolve (guards against the new branches shadowing)
// ---------------------------------------------------------------------------

test("greenhouse board URL still → greenhouse:<id>", () => {
  const p = parseJobUrl(
    "https://job-boards.greenhouse.io/omadahealth/jobs/7821718", []);
  assert.equal(canonicalKey(p.ats, p.jobId), "greenhouse:7821718");
});

test("lever URL still → lever:<id>", () => {
  const p = parseJobUrl("https://jobs.lever.co/acme/abc-123", []);
  assert.equal(canonicalKey(p.ats, p.jobId), "lever:abc-123");
});

// ---------------------------------------------------------------------------
// Fix 5: ReachMee dedup — Norrøna incident (rmjob= on any host, reachmee.com)
// ---------------------------------------------------------------------------

test("parseJobUrl: Norrøna public URL with ?rmjob=718 → ats=reachmee", () => {
  const p = parseJobUrl(
    "https://www.norrona.com/en-GB/careers/1098/?rmjob=718&lang=UK&foo=bar", []);
  assert.ok(p, "should not return null");
  assert.equal(p.ats, "reachmee");
  assert.equal(p.jobId, "718");
});

test("parseJobUrl: reachmee.com internal URL with ?job_id=718 → ats=reachmee", () => {
  const p = parseJobUrl(
    "https://web103.reachmee.com/ext/I017/1098/job?job_id=718&site=7&validator=abc&lang=UK", []);
  assert.ok(p, "should not return null");
  assert.equal(p.ats, "reachmee");
  assert.equal(p.jobId, "718");
});

test("canonicalKey: same job via two ReachMee URL forms gives same key", () => {
  const url1 = parseJobUrl("https://www.norrona.com/en-GB/careers/1098/?rmjob=718", []);
  const url2 = parseJobUrl("https://web103.reachmee.com/ext/I017/1098/job?job_id=718", []);
  const key1 = canonicalKey(url1.ats, url1.jobId, "Norrøna", "Jr. Project Leader");
  const key2 = canonicalKey(url2.ats, url2.jobId, "Norrøna", "Jr. Project Leader");
  assert.equal(key1, "reachmee:718");
  assert.equal(key2, "reachmee:718");
  assert.equal(key1, key2, "Both URL forms must produce the same canonical key");
});

// ---------------------------------------------------------------------------
// HTML helpers used by the fetch fallbacks
// ---------------------------------------------------------------------------

test("extractHtmlTitle prefers og:title and strips the brand tail", () => {
  const html =
    `<meta property="og:title" content="Product Designer | Careers | frog">`;
  assert.equal(extractHtmlTitle(html), "Product Designer");
});

test("extractHtmlTitle decodes entities and keeps real hyphens in titles", () => {
  const html = `<title>Front-End Engineer &amp; Designer – Acme</title>`;
  // en-dash separator splits off "Acme"; the plain hyphen in "Front-End" stays.
  assert.equal(extractHtmlTitle(html), "Front-End Engineer & Designer");
});

test("decodeEntities handles the common JD entities", () => {
  assert.equal(decodeEntities("R&amp;D &lt;lead&gt;"), "R&D <lead>");
});

test("visibleTextLength ignores script/style and counts real text", () => {
  const html =
    `<style>.x{color:red}</style><script>var a=1;</script><p>Hello world</p>`;
  assert.equal(visibleTextLength(html), "Hello world".length);
});

test("visibleTextLength flags an empty JS shell as thin (< 600)", () => {
  const shell = `<html><head><title></title></head><body><div id="root">` +
                `</div><script>var x=1;</script></body></html>`;
  assert.ok(visibleTextLength(shell) < 600);
});

// ---------------------------------------------------------------------------
// SEC-1 / SEC-3 — isCsrfBlocked: network-guard unit tests
//
// These pin the exact attack vectors the reviewer found plus the boundary cases
// that must be ALLOWED (localhost and real tailnet IPs/hostnames). The helper
// accepts a mock { headers: { origin } } object — no live server needed.
// ---------------------------------------------------------------------------

function fakeReq(origin) {
  return { headers: { origin } };
}

// --- BLOCK cases ---

test("isCsrfBlocked: attacker hostname mimicking tailnet IP is blocked (SEC-1 repro)", () => {
  // The original regex anchored only the START of the hostname, letting
  // "100.64.1.2.attacker.com" pass. The fixed code requires a full IPv4 literal.
  assert.equal(isCsrfBlocked(fakeReq("http://100.64.1.2.attacker.com")), true);
});

test("isCsrfBlocked: another attacker CGNAT-prefix hostname is blocked", () => {
  assert.equal(isCsrfBlocked(fakeReq("http://100.99.0.1.evil")), true);
});

test("isCsrfBlocked: non-tailnet public IP is blocked", () => {
  assert.equal(isCsrfBlocked(fakeReq("http://1.2.3.4")), true);
});

test("isCsrfBlocked: LAN IP 192.168.x is blocked", () => {
  assert.equal(isCsrfBlocked(fakeReq("http://192.168.1.5")), true);
});

test("isCsrfBlocked: random cross-origin host is blocked", () => {
  assert.equal(isCsrfBlocked(fakeReq("http://evil.example.com")), true);
});

test("isCsrfBlocked: CGNAT lower-boundary 100.63.x is blocked", () => {
  assert.equal(isCsrfBlocked(fakeReq("http://100.63.255.255")), true);
});

test("isCsrfBlocked: CGNAT upper-boundary 100.128.x is blocked", () => {
  assert.equal(isCsrfBlocked(fakeReq("http://100.128.0.1")), true);
});

test("isCsrfBlocked: bare ts.net (no subdomain) is blocked", () => {
  // A host of exactly "ts.net" must not be treated as a valid MagicDNS host.
  assert.equal(isCsrfBlocked(fakeReq("https://ts.net")), true);
});

// --- ALLOW cases ---

test("isCsrfBlocked: exact tailnet CGNAT IP is allowed", () => {
  // 100.64.0.5 is the lower boundary of the 100.64/10 range.
  assert.equal(isCsrfBlocked(fakeReq("http://100.64.0.5:8787")), false);
});

test("isCsrfBlocked: CGNAT upper-edge 100.127.x is allowed", () => {
  assert.equal(isCsrfBlocked(fakeReq("http://100.127.255.254")), false);
});

test("isCsrfBlocked: MagicDNS *.ts.net host is allowed", () => {
  assert.equal(isCsrfBlocked(fakeReq("https://foo.ts.net")), false);
});

test("isCsrfBlocked: deeper MagicDNS subdomain is allowed", () => {
  assert.equal(isCsrfBlocked(fakeReq("https://rob-iphone.tailabcde.ts.net")), false);
});

test("isCsrfBlocked: no Origin header (same-origin page fetch) is allowed", () => {
  assert.equal(isCsrfBlocked({ headers: {} }), false);
});

// --- isAllowedClient table (SEC-3) ---
// isAllowedClient reads from req.socket.remoteAddress (always a real IP literal).

function fakeClientReq(remoteAddress) {
  return { socket: { remoteAddress } };
}

test("isAllowedClient: loopback 127.0.0.1 is allowed", () => {
  assert.equal(isAllowedClient(fakeClientReq("127.0.0.1")), true);
});

test("isAllowedClient: IPv6 loopback ::1 is allowed", () => {
  assert.equal(isAllowedClient(fakeClientReq("::1")), true);
});

test("isAllowedClient: IPv4-mapped tailnet IP ::ffff:100.64.0.1 is allowed", () => {
  assert.equal(isAllowedClient(fakeClientReq("::ffff:100.64.0.1")), true);
});

test("isAllowedClient: plain tailnet IP 100.100.0.1 is allowed", () => {
  assert.equal(isAllowedClient(fakeClientReq("100.100.0.1")), true);
});

test("isAllowedClient: LAN IP 192.168.1.5 is blocked", () => {
  assert.equal(isAllowedClient(fakeClientReq("192.168.1.5")), false);
});

test("isAllowedClient: IPv4-mapped LAN IP ::ffff:192.168.1.5 is blocked", () => {
  assert.equal(isAllowedClient(fakeClientReq("::ffff:192.168.1.5")), false);
});

test("isAllowedClient: CGNAT lower-boundary 100.63.x is blocked", () => {
  assert.equal(isAllowedClient(fakeClientReq("100.63.255.255")), false);
});

test("isAllowedClient: CGNAT upper-boundary 100.128.0.1 is blocked", () => {
  assert.equal(isAllowedClient(fakeClientReq("100.128.0.1")), false);
});
