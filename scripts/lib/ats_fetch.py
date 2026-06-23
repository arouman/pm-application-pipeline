#!/usr/bin/env python3
"""ats_fetch.py — ATS fetchers and cheap pre-filters shared by watch-jobs.py and cloud_scrape.py.

This module is path-agnostic: no hardcoded /Users/... paths, no launchd PATH
mutations. It is safe to import on any platform (macOS, ubuntu-latest in CI).

Exported surface:
  TITLE_KEYWORDS            list[str]   — lowercase substrings to match
  LOCATION_KEEP_PATTERNS    list[str]   — regex patterns for US/remote locations
  fetch_company(company)    list[dict]  — dispatch to the right ATS fetcher
  matches_title(title)      bool        — cheap title pre-filter
  matches_location(loc)     bool        — cheap location pre-filter
  fetch_full_jd(job, log)   str         — full JD text for a job dict
"""

import html
import json
import logging
import re
import urllib.request
from typing import Optional

# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------

USER_AGENT = "RobStoutJobWatcher/1.0 (local dev automation)"
HTTP_TIMEOUT = 10  # seconds

# Workday rejects non-browser User-Agents with a 400.
BROWSER_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/138.0 Safari/537.36"
)


def _get_json(url: str) -> dict:
    """Fetch a URL and return parsed JSON. Raises on error."""
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _get_html(url: str) -> str:
    """Fetch a URL and return raw text. Raises on error."""
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
        return resp.read().decode("utf-8", "ignore")


def _post_json(url: str, payload: dict) -> dict:
    """POST JSON and return parsed JSON. Used by Workday's search API."""
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url, data=data,
        headers={
            "User-Agent": BROWSER_UA,
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
        return json.loads(resp.read().decode("utf-8"))


# ---------------------------------------------------------------------------
# Title keywords — mirrors bridge/server.js TITLE_KEYWORDS
# ---------------------------------------------------------------------------

TITLE_KEYWORDS = [
    "product designer",
    "design strateg",
    "service design",
    "experience design",
    "product manager",
    "product management",
    "design lead",
    "design director",
    "ai experience",
    "ai product design",
    "staff designer",
    "principal designer",
    "head of design",
    "vp of design",
    "vp, design",
    "staff product manager",
    "senior product manager",
    "senior product designer",
    "staff pm",
    "principal pm",
    "group product manager",
    "product lead",
    "product strategist",
    "ai product manager",
    "ai designer",
    "design engineer",
]

# UX is word-boundary matched separately in matches_title().
# Location: US-remote / major metros. Empty → keep (lenient).
# fmt: off
LOCATION_KEEP_PATTERNS = [
    r"remote",
    r"united states",
    r"\bus\b",
    r"san francisco",
    r"\bsf\b",
    r"new york",
    r"\bnyc\b",
    r"seattle",
    r"austin",
    r"denver",
    r"boulder",
    r"mountain view",
    r"menlo park",
    r"palo alto",
    r"burlingame",
    r"sunnyvale",
    r"los angeles",
    r"chicago",
    r"boston",
    r"atlanta",
    r"north america",
    r"nationwide",
    r"anywhere",
    r"distributed",
    r"hybrid",
    r"",  # empty / unknown → keep (lenient)
]
# fmt: on


# ---------------------------------------------------------------------------
# Pre-filters (cheap — run before any AI call)
# ---------------------------------------------------------------------------

def matches_title(title: str) -> bool:
    """Return True if title contains a role keyword. Mirrors bridge/server.js logic."""
    lower = title.lower()
    # UX: word-boundary match so "Linux" doesn't fire.
    if re.search(r"(?:^|[\s,/])(ux)(?:[^a-z]|$)", lower):
        return True
    return any(kw in lower for kw in TITLE_KEYWORDS)


def matches_location(location: str) -> bool:
    """Return True if location is US-remote or a target metro. Lenient when ambiguous."""
    lower = location.lower()
    if not lower.strip():
        return True  # empty → keep
    return any(re.search(pat, lower) for pat in LOCATION_KEEP_PATTERNS if pat)


# ---------------------------------------------------------------------------
# ATS fetchers
# ---------------------------------------------------------------------------

def _fetch_greenhouse(company: dict) -> list:
    """Fetch all jobs from a Greenhouse board."""
    url = f"https://boards-api.greenhouse.io/v1/boards/{company['slug']}/jobs"
    data = _get_json(url)
    jobs = data.get("jobs") or []
    return [
        {
            "company": company["name"],
            "ats": "greenhouse",
            "slug": company["slug"],
            "tier": company["tier"],
            "jobId": str(j.get("id") or ""),
            "title": j.get("title") or "",
            "location": (j.get("location") or {}).get("name") or "",
            "jdUrl": j.get("absolute_url") or "",
        }
        for j in jobs
    ]


def _fetch_ashby(company: dict) -> list:
    """Fetch all jobs from an Ashby board."""
    url = f"https://api.ashbyhq.com/posting-api/job-board/{company['slug']}"
    data = _get_json(url)
    jobs = data.get("jobs") or []
    return [
        {
            "company": company["name"],
            "ats": "ashby",
            "slug": company["slug"],
            "tier": company["tier"],
            "jobId": str(j.get("id") or ""),
            "title": j.get("title") or "",
            "location": "Remote" if j.get("isRemote") else (j.get("location") or ""),
            "jdUrl": j.get("jobUrl") or "",
        }
        for j in jobs
    ]


def _fetch_lever(company: dict) -> list:
    """Fetch all jobs from a Lever board."""
    url = f"https://api.lever.co/v0/postings/{company['slug']}?mode=json"
    data = _get_json(url)
    if not isinstance(data, list):
        raise ValueError("Unexpected Lever response shape")
    return [
        {
            "company": company["name"],
            "ats": "lever",
            "slug": company["slug"],
            "tier": company["tier"],
            "jobId": str(j.get("id") or ""),
            "title": j.get("text") or "",
            "location": (j.get("categories") or {}).get("location") or "",
            "jdUrl": j.get("hostedUrl") or "",
        }
        for j in data
    ]


def _fetch_reachmee(company: dict, _log: Optional[logging.Logger] = None) -> list:
    """Fetch all jobs from a ReachMee board.

    ReachMee serves HTML. The validator is a stable site hash (same for every
    visitor); if it ever rotates this returns no jobs and logs a warning.
    """
    _log = _log or logging.getLogger(__name__)
    server = company.get("server", "web103")
    customer = company["customer"]
    site = company.get("site", "7")
    validator = company["validator"]
    lang = company.get("lang", "UK")
    url = (
        f"https://{server}.reachmee.com/ext/{customer}/main"
        f"?site={site}&validator={validator}&lang={lang}"
    )
    raw = _get_html(url)
    pub = company.get("publicUrl")
    out, seen = [], set()
    for m in re.finditer(r"job_id=(\d+)'[^>]*>([^<]+)", raw):
        jid, title = m.group(1), html.unescape(m.group(2)).strip()
        if not jid or jid in seen or not title:
            continue
        seen.add(jid)
        out.append({
            "company": company["name"],
            "ats": "reachmee",
            "slug": company["slug"],
            "tier": company["tier"],
            "jobId": jid,
            "title": title,
            "location": company.get("location", ""),
            "jdUrl": pub.format(id=jid) if pub else url,
            "_jdFetch": (
                f"https://{server}.reachmee.com/ext/{customer}/job"
                f"?job_id={jid}&site={site}&validator={validator}&lang={lang}"
            ),
        })
    if not out:
        _log.warning(
            "ReachMee %s returned no jobs — validator may have rotated.",
            company.get("name"),
        )
    return out


def _fetch_workday(company: dict) -> list:
    """Fetch jobs from a Workday tenant.

    Each target must carry host/tenant/site fields derived from the company's
    real careers URL. Paginates up to ~5 pages (100 roles total).
    """
    host = company["host"]
    tenant = company["tenant"]
    site = company["site"]
    locale = company.get("locale", "en-US")
    api = f"https://{host}/wday/cxs/{tenant}/{site}/jobs"
    out = []
    for offset in range(0, 100, 20):
        data = _post_json(
            api,
            {"limit": 20, "offset": offset, "searchText": "", "appliedFacets": {}},
        )
        postings = data.get("jobPostings") or []
        for j in postings:
            ext = j.get("externalPath") or ""
            reqid = ext.rstrip("/").split("_")[-1] or ext
            out.append({
                "company": company["name"],
                "ats": "workday",
                "slug": company.get("slug", tenant),
                "tier": company["tier"],
                "jobId": reqid,
                "title": j.get("title") or "",
                "location": j.get("locationsText") or company.get("location", ""),
                "jdUrl": f"https://{host}/{locale}/{site}{ext}",
                "_jdFetch": f"https://{host}/wday/cxs/{tenant}/{site}{ext}",
            })
        if len(postings) < 20:
            break
    return out


def fetch_company(company: dict, _log: Optional[logging.Logger] = None) -> list:
    """Dispatch to the right fetcher based on company.ats.

    Returns a list of normalized job dicts. Raises ValueError for unknown ATS.
    """
    ats = company.get("ats")
    if ats == "greenhouse":
        return _fetch_greenhouse(company)
    if ats == "ashby":
        return _fetch_ashby(company)
    if ats == "lever":
        return _fetch_lever(company)
    if ats == "reachmee":
        return _fetch_reachmee(company, _log)
    if ats == "workday":
        return _fetch_workday(company)
    raise ValueError(f"Unknown ATS: {ats}")


# ---------------------------------------------------------------------------
# Full JD text fetch (used by cloud_scrape and watch-jobs for scoring)
# ---------------------------------------------------------------------------

def fetch_full_jd(job: dict, _log: Optional[logging.Logger] = None) -> str:
    """Fetch the full job-description text for a job dict.

    Returns a plain-text string (HTML stripped) or a short fallback on failure.
    Handles Greenhouse, Ashby, Lever, ReachMee, and Workday.
    """
    _log = _log or logging.getLogger(__name__)
    ats = job["ats"]
    try:
        if ats == "greenhouse":
            url = (
                f"https://boards-api.greenhouse.io/v1/boards/{job['slug']}"
                f"/jobs/{job['jobId']}?content=true"
            )
            data = _get_json(url)
            content = re.sub(r"<[^>]+>", " ", data.get("content") or "")
            content = re.sub(r"\s+", " ", content).strip()
            return (
                f"Title: {data.get('title', job['title'])}\n"
                f"Location: {(data.get('location') or {}).get('name', job['location'])}\n"
                f"URL: {job['jdUrl']}\n\n"
                f"{content}"
            )

        if ats == "ashby":
            url = f"https://api.ashbyhq.com/posting-api/job-board/{job['slug']}"
            data = _get_json(url)
            for j in (data.get("jobs") or []):
                if str(j.get("id") or "") == job["jobId"]:
                    desc = j.get("descriptionHtml") or j.get("descriptionPlain") or j.get("description") or ""
                    desc = re.sub(r"<[^>]+>", " ", desc)
                    desc = re.sub(r"\s+", " ", desc).strip()
                    return (
                        f"Title: {j.get('title', job['title'])}\n"
                        f"Location: {'Remote' if j.get('isRemote') else j.get('location', job['location'])}\n"
                        f"URL: {job['jdUrl']}\n\n"
                        f"{desc}"
                    )
            return f"Title: {job['title']}\nURL: {job['jdUrl']}\n\n(description not found)"

        if ats == "lever":
            url = f"https://api.lever.co/v0/postings/{job['slug']}?mode=json"
            data = _get_json(url)
            for j in data:
                if str(j.get("id") or "") == job["jobId"]:
                    lists = j.get("lists") or []
                    parts = []
                    for section in lists:
                        parts.append(section.get("text") or "")
                        parts.append(re.sub(r"<[^>]+>", " ", section.get("content") or ""))
                    additional = re.sub(r"<[^>]+>", " ", j.get("additional") or "")
                    desc = re.sub(r"\s+", " ", " ".join(parts + [additional])).strip()
                    return (
                        f"Title: {j.get('text', job['title'])}\n"
                        f"Location: {(j.get('categories') or {}).get('location', job['location'])}\n"
                        f"URL: {job['jdUrl']}\n\n"
                        f"{desc}"
                    )
            return f"Title: {job['title']}\nURL: {job['jdUrl']}\n\n(description not found)"

        if ats == "reachmee":
            raw = _get_html(job.get("_jdFetch") or job["jdUrl"])
            desc = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", raw)).strip()
            return (
                f"Title: {job['title']}\n"
                f"Location: {job['location']}\n"
                f"URL: {job['jdUrl']}\n\n"
                f"{desc[:8000]}"
            )

        if ats == "workday":
            req = urllib.request.Request(
                job["_jdFetch"],
                headers={"User-Agent": BROWSER_UA, "Accept": "application/json"},
            )
            with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as r:
                data = json.loads(r.read().decode("utf-8"))
            info = data.get("jobPostingInfo") or {}
            desc = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", info.get("jobDescription") or "")).strip()
            return (
                f"Title: {info.get('title', job['title'])}\n"
                f"Location: {info.get('location', job['location'])}\n"
                f"URL: {job['jdUrl']}\n\n"
                f"{desc[:8000]}"
            )

        # Unknown ATS — fall back to title-only so the scorer still runs.
        return (
            f"Title: {job['title']}\nLocation: {job['location']}\n"
            f"URL: {job['jdUrl']}\n\n(no description fetcher for {ats})"
        )

    except Exception as exc:
        _log.warning("Full JD fetch failed for %s:%s — %s", ats, job.get("jobId"), exc)
        return (
            f"Title: {job['title']}\nLocation: {job['location']}\n"
            f"URL: {job['jdUrl']}\n\n(could not fetch description)"
        )
