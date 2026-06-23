#!/usr/bin/env python3
"""url_normalize.py — canonical ATS URL / job-identity helper.

Shared by watch-jobs.py (key derivation), queue.py (dedup), and server.js
(via the Python bridge for ledger/queue checks), so that the same physical job
posting always maps to ONE identity regardless of which entry-point detected it.

Problem this solves: a ReachMee job can appear as:
  - reachmee:718        (watch-jobs.py, which uses the ATS API and knows the ATS)
  - web:en-GB/careers/1098/?rmjob=718&...  (bridge /intake — saw the human URL)
  - web:web103.reachmee.com/ext/...?job_id=718  (another URL form)

Without normalization these produce three distinct dedup keys, so the ledger
check misses the existing entry and the role gets re-enqueued.

normalize_job_url(url) → (ats, job_id) | (None, None)

Returns the canonical (ats, job_id) pair for a URL when the ATS can be
identified from the URL alone. Returns (None, None) when the URL is opaque
(non-ATS host) — callers fall back to their existing logic.

Recognized patterns:
  ReachMee:   any URL containing rmjob=<id> or job_id=<id> query params
              OR hosted at *.reachmee.com
  Greenhouse: job-boards.greenhouse.io/<slug>/jobs/<id>
              boards.greenhouse.io/<slug>/jobs/<id>
              *?gh_jid=<id>
  Ashby:      jobs.ashbyhq.com/<slug>/<uuid>
  Lever:      jobs.lever.co/<slug>/<id>
  Workday:    *.myworkdayjobs.com (last path segment after /job/)
  BCG:        careers.bcg.com/global/.../job/<digits>/
"""
import re
import sys
from urllib.parse import urlparse, parse_qs
from typing import Optional, Tuple


def normalize_job_url(url: str) -> Tuple[Optional[str], Optional[str]]:
    """
    Return (ats, job_id) for a URL when the ATS is identifiable.
    Returns (None, None) for opaque / unknown hosts.

    This is intentionally conservative: it only fires when the URL itself
    proves the ATS, so we never misidentify a non-ATS URL as one.
    """
    if not url:
        return None, None
    try:
        u = urlparse(url)
    except Exception:
        return None, None

    host = (u.hostname or "").lower()
    params = parse_qs(u.query)

    # ── ReachMee ──────────────────────────────────────────────────────────────
    # ReachMee job IDs appear in the query string as ?rmjob=<id> or ?job_id=<id>
    # on both the public-facing career page URLs AND the internal API URLs.
    # We match on any host — including the company's own domain — when these
    # query params are present.
    rmjob = params.get("rmjob") or params.get("job_id")
    if rmjob:
        jid = str(rmjob[0]).strip()
        if jid and re.match(r"^\d+$", jid):
            return "reachmee", jid
    # Also match hosting directly on reachmee.com
    if host.endswith("reachmee.com") or "reachmee.com" in host:
        # Try job_id param first (internal URL), then rmjob (public URL)
        for param in ("job_id", "rmjob"):
            vals = params.get(param, [])
            if vals:
                jid = str(vals[0]).strip()
                if jid and re.match(r"^\d+$", jid):
                    return "reachmee", jid

    # ── Greenhouse ────────────────────────────────────────────────────────────
    if host in ("job-boards.greenhouse.io", "boards.greenhouse.io"):
        parts = u.path.lstrip("/").split("/")
        if len(parts) >= 3 and parts[1] == "jobs":
            return "greenhouse", parts[2]
    gh_jid = params.get("gh_jid", [None])[0]
    if gh_jid:
        return "greenhouse", str(gh_jid)

    # ── Ashby ─────────────────────────────────────────────────────────────────
    if host == "jobs.ashbyhq.com":
        parts = u.path.lstrip("/").split("/")
        if len(parts) >= 2:
            return "ashby", parts[1]

    # ── Lever ─────────────────────────────────────────────────────────────────
    if host == "jobs.lever.co":
        parts = u.path.lstrip("/").split("/")
        if len(parts) >= 2:
            return "lever", parts[1]

    # ── Workday ───────────────────────────────────────────────────────────────
    if re.search(r"\.wd\d+\.myworkdayjobs\.com$", host) or host.endswith(".myworkdayjobs.com"):
        parts = u.path.lstrip("/").split("/")
        job_idx = next((i for i, p in enumerate(parts) if p == "job"), -1)
        if job_idx >= 1 and len(parts) > job_idx + 1:
            last = parts[-1]
            m = re.search(r"(?:^|[_-])((?:JR|REQ|R)-?\d[\w-]*)$", last, re.IGNORECASE)
            job_id = m.group(1) if m else last
            return "workday", job_id

    # ── BCG ───────────────────────────────────────────────────────────────────
    if host == "careers.bcg.com":
        parts = u.path.lstrip("/").split("/")
        job_idx = next((i for i, p in enumerate(parts) if p == "job"), -1)
        if job_idx != -1:
            candidate = parts[job_idx + 1] if job_idx + 1 < len(parts) else ""
            if re.match(r"^\d+$", candidate):
                return "bcg", candidate

    return None, None


def canonical_key_from_url(url: str, company: str = "", title: str = "") -> str:
    """
    Derive a canonical dedup key from a URL. Uses the ATS-based key when the
    ATS can be identified; otherwise falls back to norm(company)|norm(title).
    Mirrors ledger.py's canonical_key() but adds URL-based detection.
    """
    ats, job_id = normalize_job_url(url)
    if ats and job_id:
        return f"{ats}:{job_id}"
    # Fall back to ledger.py's company|title key
    def _norm(s: str) -> str:
        import re as _re
        t = s.lower()
        t = _re.sub(r"[^\w\s-]", "", t)
        t = _re.sub(r"[\s_]+", "-", t.strip())
        return t
    return f"{_norm(company)}|{_norm(title)}"


_TRACKING_PARAMS = frozenset({
    "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
    "gclid", "fbclid", "ref", "src", "source", "mc_cid", "mc_eid",
})


def normalize_url_for_dedup(url: str) -> str:
    """
    Return a normalised string form of ``url`` suitable for equality comparison
    across superficially-different representations of the same job posting.

    Transformations applied:
    - lower-case the host
    - strip the ``www.`` subdomain
    - strip the scheme (``https://``, ``http://``)
    - drop known tracking query params (utm_*, gclid, fbclid, ref, src …)
    - sort remaining query params so ordering differences collapse
    - strip a trailing slash from the path

    This is intentionally NOT the same as the canonical *key* (which is
    path-only for ``web:`` entries).  It is used as a secondary dedup signal:
    if two keys differ but their normalised URLs match, they are the same job.

    Returns an empty string when the URL cannot be parsed.
    """
    if not url:
        return ""
    try:
        u = urlparse(url)
    except Exception:
        return ""
    raw_host = (u.hostname or "").lower()
    host = raw_host[4:] if raw_host.startswith("www.") else raw_host
    path = u.path.rstrip("/")
    kept = sorted(
        f"{k}={v}"
        for k, v in parse_qs(u.query, keep_blank_values=True).items()
        if k.lower() not in _TRACKING_PARAMS
        for v in [v[0]]  # parse_qs returns lists; take first value
    )
    result = host + path
    if kept:
        result += "?" + "&".join(kept)
    if u.fragment:
        result += "#" + u.fragment
    return result


if __name__ == "__main__":
    # Quick smoke test: normalize_job_url <url>
    if len(sys.argv) < 2:
        print("usage: url_normalize.py <url>")
        sys.exit(1)
    ats, jid = normalize_job_url(sys.argv[1])
    print(f"ats={ats!r}  job_id={jid!r}  key={ats}:{jid}" if ats else "no match")
