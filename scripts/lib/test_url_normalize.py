#!/usr/bin/env python3
"""Tests for url_normalize.py — canonical ATS URL / job-identity helper.

These tests lock down the dedup-across-key-forms logic that caused the Norrøna
duplicate incident (reachmee:718 vs web:...?rmjob=718 vs web:...?job_id=718).

Run:  python3 -m unittest discover -s scripts/lib -t scripts/lib -p "test_*.py"
"""
import sys
import os
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from url_normalize import normalize_job_url, canonical_key_from_url, normalize_url_for_dedup


class TestNormalizeJobUrl(unittest.TestCase):

    # ── ReachMee ────────────────────────────────────────────────────────────

    def test_reachmee_rmjob_param_on_company_domain(self):
        """Public company career page URL with ?rmjob= → reachmee:<id>"""
        ats, jid = normalize_job_url("https://www.norrona.com/en-GB/careers/1098/?rmjob=718&lang=UK")
        self.assertEqual(ats, "reachmee")
        self.assertEqual(jid, "718")

    def test_reachmee_job_id_param_on_reachmee_host(self):
        """Internal reachmee.com API URL with ?job_id= → reachmee:<id>"""
        ats, jid = normalize_job_url(
            "https://web103.reachmee.com/ext/I017/1098/job?job_id=718&site=7&validator=abc")
        self.assertEqual(ats, "reachmee")
        self.assertEqual(jid, "718")

    def test_reachmee_rmjob_and_job_id_same_number(self):
        """Both param variants for the same job id produce the same canonical key."""
        url1 = "https://www.norrona.com/en-GB/careers/1098/?rmjob=718&lang=UK"
        url2 = "https://web103.reachmee.com/ext/I017/1098/job?job_id=718&site=7"
        _, jid1 = normalize_job_url(url1)
        _, jid2 = normalize_job_url(url2)
        self.assertEqual(jid1, jid2, "Both ReachMee URL forms must resolve to the same job_id")

    def test_reachmee_non_numeric_job_id_not_matched(self):
        """Non-numeric rmjob params should not trigger reachmee detection."""
        ats, jid = normalize_job_url("https://example.com/careers/?rmjob=abc-123")
        self.assertNotEqual(ats, "reachmee")

    def test_reachmee_no_param_on_unrelated_host(self):
        """A URL on an unrelated host with no rmjob param must not match reachmee."""
        ats, jid = normalize_job_url("https://example.com/careers/jobs/123")
        self.assertNotEqual(ats, "reachmee")

    # ── Greenhouse ──────────────────────────────────────────────────────────

    def test_greenhouse_board_url(self):
        ats, jid = normalize_job_url(
            "https://job-boards.greenhouse.io/anthropic/jobs/5127559008")
        self.assertEqual(ats, "greenhouse")
        self.assertEqual(jid, "5127559008")

    def test_greenhouse_boards_alternate_host(self):
        ats, jid = normalize_job_url(
            "https://boards.greenhouse.io/omadahealth/jobs/7821718")
        self.assertEqual(ats, "greenhouse")
        self.assertEqual(jid, "7821718")

    def test_greenhouse_gh_jid_param(self):
        ats, jid = normalize_job_url(
            "https://anthropic.com/careers?gh_jid=5127559008")
        self.assertEqual(ats, "greenhouse")
        self.assertEqual(jid, "5127559008")

    # ── Ashby ───────────────────────────────────────────────────────────────

    def test_ashby_url(self):
        ats, jid = normalize_job_url(
            "https://jobs.ashbyhq.com/openai/abc12345-6789-def0-1234-56789abcdef0")
        self.assertEqual(ats, "ashby")
        self.assertEqual(jid, "abc12345-6789-def0-1234-56789abcdef0")

    # ── Lever ───────────────────────────────────────────────────────────────

    def test_lever_url(self):
        ats, jid = normalize_job_url(
            "https://jobs.lever.co/figma/def45678-1234-abcd-ef01-2345678abcde")
        self.assertEqual(ats, "lever")
        self.assertEqual(jid, "def45678-1234-abcd-ef01-2345678abcde")

    # ── Workday ─────────────────────────────────────────────────────────────

    def test_workday_url(self):
        ats, jid = normalize_job_url(
            "https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/"
            "job/Santa-Clara-CA/Senior-Product-Manager_JR1997214")
        self.assertEqual(ats, "workday")
        self.assertEqual(jid, "JR1997214")

    # ── BCG ─────────────────────────────────────────────────────────────────

    def test_bcg_url(self):
        ats, jid = normalize_job_url(
            "https://careers.bcg.com/global/en/job/12345/Senior-Consultant")
        self.assertEqual(ats, "bcg")
        self.assertEqual(jid, "12345")

    # ── Opaque / generic ────────────────────────────────────────────────────

    def test_opaque_url_returns_none(self):
        ats, jid = normalize_job_url("https://example.com/careers/jobs/some-slug")
        self.assertIsNone(ats)
        self.assertIsNone(jid)

    def test_empty_url_returns_none(self):
        ats, jid = normalize_job_url("")
        self.assertIsNone(ats)
        self.assertIsNone(jid)

    def test_malformed_url_returns_none(self):
        ats, jid = normalize_job_url("not a url at all !!!")
        self.assertIsNone(ats)
        self.assertIsNone(jid)


class TestCanonicalKeyFromUrl(unittest.TestCase):

    def test_reachmee_url_gives_ats_key(self):
        key = canonical_key_from_url(
            "https://www.norrona.com/en-GB/careers/1098/?rmjob=718")
        self.assertEqual(key, "reachmee:718")

    def test_greenhouse_url_gives_ats_key(self):
        key = canonical_key_from_url(
            "https://job-boards.greenhouse.io/anthropic/jobs/5127559008")
        self.assertEqual(key, "greenhouse:5127559008")

    def test_opaque_url_falls_back_to_company_title(self):
        key = canonical_key_from_url(
            "https://example.com/careers/jobs/designer",
            company="Acme Corp",
            title="Senior Designer",
        )
        self.assertEqual(key, "acme-corp|senior-designer")

    def test_opaque_url_empty_company_title(self):
        key = canonical_key_from_url("https://example.com/careers/jobs/123")
        self.assertEqual(key, "|")  # both empty after norm — harmless, just not an ats key


class TestNormalizeUrlForDedup(unittest.TestCase):
    """P1-2 regression: lstrip("www.") strips a character SET, corrupting hosts
    that begin with w/'.'. The fix uses startswith("www.") prefix stripping."""

    def test_www_stripped_correctly(self):
        """www.frog.co → frog.co (the intended case)."""
        self.assertEqual(normalize_url_for_dedup("https://www.frog.co/jobs/123"),
                         "frog.co/jobs/123")

    def test_wework_not_corrupted(self):
        """wework.com must NOT become ework.com (P1-2 regression case)."""
        result = normalize_url_for_dedup("https://wework.com/jobs/designer")
        self.assertEqual(result, "wework.com/jobs/designer",
                         f"wework.com was corrupted to: {result!r}")

    def test_workday_not_corrupted(self):
        """workday.com must NOT become orkday.com."""
        result = normalize_url_for_dedup("https://workday.com/en-US/x")
        self.assertEqual(result, "workday.com/en-US/x",
                         f"workday.com was corrupted to: {result!r}")

    def test_watford_not_corrupted(self):
        """watford.io must NOT become atford.io."""
        result = normalize_url_for_dedup("https://watford.io/careers")
        self.assertEqual(result, "watford.io/careers",
                         f"watford.io was corrupted to: {result!r}")

    def test_wwww_not_stripped_at_all(self):
        """A four-w host wwww.test must not be stripped — 'wwww.' != 'www.'."""
        result = normalize_url_for_dedup("https://wwww.test/path")
        # startswith("www.") is False for "wwww.test", so it must be returned unchanged.
        self.assertEqual(result, "wwww.test/path",
                         f"wwww.test was incorrectly stripped to: {result!r}")

    def test_no_www_prefix_unchanged(self):
        """A host without www. is returned as-is."""
        self.assertEqual(normalize_url_for_dedup("https://example.com/jobs/42"),
                         "example.com/jobs/42")

    def test_same_wework_urls_collide(self):
        """Two wework.com URLs that differ only in www. must normalize to the same key."""
        a = normalize_url_for_dedup("https://wework.com/jobs/designer")
        b = normalize_url_for_dedup("https://www.wework.com/jobs/designer")
        self.assertEqual(a, b, "www. and non-www. wework.com URLs must collide in dedup")

    def test_tracking_params_stripped(self):
        """utm_* and similar tracking params are removed."""
        result = normalize_url_for_dedup(
            "https://example.com/jobs/42?utm_source=linkedin&utm_medium=cpc")
        self.assertEqual(result, "example.com/jobs/42")

    def test_trailing_slash_stripped(self):
        """Trailing slash is normalized away."""
        self.assertEqual(normalize_url_for_dedup("https://example.com/jobs/42/"),
                         "example.com/jobs/42")

    def test_empty_url_returns_empty(self):
        self.assertEqual(normalize_url_for_dedup(""), "")


if __name__ == "__main__":
    unittest.main()
