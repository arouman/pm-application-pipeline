#!/usr/bin/env python3
"""Characterization tests for ledger.py — the 6-month dedup store.

Two layers:
  1. Pure-function unit tests (import ledger directly): norm, canonical_key,
     _within_window. Fast, no I/O.
  2. CLI contract tests (subprocess): exercise the EXACT command surface the
     bridge server shells out to (check / add / mark / list). If these pass,
     the server's data layer behaves.

Run:  python3 -m unittest discover -s scripts/lib -t scripts/lib -p "test_*.py"
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from datetime import date, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
LEDGER_PY = os.path.join(HERE, "ledger.py")
sys.path.insert(0, HERE)
import ledger  # noqa: E402


def run_cli(path, *args):
    """Invoke ledger.py CLI; return (returncode, stdout, stderr)."""
    r = subprocess.run(
        ["python3", LEDGER_PY, path, *args],
        capture_output=True, text=True,
    )
    return r.returncode, r.stdout.strip(), r.stderr.strip()


def load(path):
    with open(path) as fh:
        return json.load(fh)


def iso(days_ago):
    return (date.today() - timedelta(days=days_ago)).isoformat()


# ---------------------------------------------------------------------------
# Pure functions
# ---------------------------------------------------------------------------

class TestNorm(unittest.TestCase):
    def test_lowercases_and_hyphenates(self):
        self.assertEqual(ledger.norm("Senior Product Designer"),
                         "senior-product-designer")

    def test_strips_punctuation_keeps_hyphens(self):
        self.assertEqual(ledger.norm("AI/ML, Product (Sr.)"),
                         "aiml-product-sr")

    def test_collapses_whitespace_and_underscores(self):
        self.assertEqual(ledger.norm("a   b_c"), "a-b-c")


class TestCanonicalKey(unittest.TestCase):
    def test_prefers_ats_and_jobid(self):
        self.assertEqual(
            ledger.canonical_key("greenhouse", "7821718", "Omada", "Staff PD"),
            "greenhouse:7821718",
        )

    def test_falls_back_to_company_title(self):
        self.assertEqual(
            ledger.canonical_key(None, None, "Omada Health", "Staff Designer"),
            "omada-health|staff-designer",
        )

    def test_missing_jobid_falls_back(self):
        # ats present but no jobId → still falls back to company|title
        self.assertEqual(
            ledger.canonical_key("greenhouse", None, "Omada", "PD"),
            "omada|pd",
        )


class TestWithinWindow(unittest.TestCase):
    def test_recent_firstseen_is_within(self):
        self.assertTrue(ledger._within_window({"firstSeen": iso(10)}))

    def test_old_firstseen_is_outside(self):
        self.assertFalse(ledger._within_window({"firstSeen": iso(200)}))

    def test_boundary_183_days_is_within(self):
        # cutoff = today - 183; an entry exactly at cutoff counts (>=)
        self.assertTrue(ledger._within_window({"firstSeen": iso(183)}))

    def test_old_firstseen_but_recent_applied_is_within(self):
        self.assertTrue(ledger._within_window(
            {"firstSeen": iso(300), "appliedDate": iso(5)}))

    def test_no_dates_is_outside(self):
        self.assertFalse(ledger._within_window({"company": "X"}))

    def test_garbage_date_ignored(self):
        self.assertFalse(ledger._within_window({"firstSeen": "not-a-date"}))


# ---------------------------------------------------------------------------
# CLI contract (subprocess) — what the server depends on
# ---------------------------------------------------------------------------

class TestLedgerCli(unittest.TestCase):
    def setUp(self):
        fd, self.path = tempfile.mkstemp(suffix=".json")
        os.close(fd)
        # Start from a clean ledger shell
        with open(self.path, "w") as fh:
            json.dump({"version": 1, "entries": []}, fh)

    def tearDown(self):
        os.unlink(self.path)

    def _entry(self, **over):
        e = {
            "key": "greenhouse:111",
            "company": "Acme",
            "title": "Product Designer",
            "ats": "greenhouse",
            "jobId": "111",
            "applyUrl": "https://x/y",
            "status": "queued",
        }
        e.update(over)
        return e

    def test_check_absent_key_not_duplicate(self):
        rc, out, _ = run_cli(self.path, "check", "nope:0")
        self.assertEqual(rc, 0)
        self.assertEqual(json.loads(out), {"duplicate": False, "entry": None})

    def test_add_then_check_is_duplicate(self):
        rc, out, err = run_cli(self.path, "add", "--json",
                               json.dumps(self._entry()))
        self.assertEqual(rc, 0, err)
        self.assertTrue(json.loads(out)["ok"])
        rc, out, _ = run_cli(self.path, "check", "greenhouse:111")
        res = json.loads(out)
        self.assertTrue(res["duplicate"])
        self.assertEqual(res["entry"]["company"], "Acme")

    def test_add_defaults_firstseen_today(self):
        # An entry added with no firstSeen gets today's date defaulted in.
        e = self._entry()
        e.pop("status", None)  # also exercises status default
        run_cli(self.path, "add", "--json", json.dumps(e))
        entry = load(self.path)["entries"][0]
        self.assertEqual(entry["firstSeen"], date.today().isoformat())
        self.assertEqual(entry["status"], "queued")  # default status
        self.assertIsNone(entry["appliedDate"])      # default appliedDate

    def test_add_upserts_merges_fields(self):
        run_cli(self.path, "add", "--json", json.dumps(self._entry()))
        run_cli(self.path, "add", "--json", json.dumps(
            self._entry(status="built", folder="applied/x")))
        data = load(self.path)
        # Still a single entry (upsert by key), with merged fields.
        keys = [e["key"] for e in data["entries"]]
        self.assertEqual(keys.count("greenhouse:111"), 1)
        e = data["entries"][0]
        self.assertEqual(e["status"], "built")
        self.assertEqual(e["folder"], "applied/x")

    def test_mark_submitted_sets_applied_date(self):
        run_cli(self.path, "add", "--json", json.dumps(self._entry()))
        rc, out, err = run_cli(self.path, "mark", "greenhouse:111",
                               "--status", "submitted")
        self.assertEqual(rc, 0, err)
        e = load(self.path)["entries"][0]
        self.assertEqual(e["status"], "submitted")
        self.assertEqual(e["appliedDate"], date.today().isoformat())

    def test_mark_missing_key_errors(self):
        rc, _, _ = run_cli(self.path, "mark", "ghost:0", "--status", "submitted")
        self.assertEqual(rc, 1)

    def test_old_entry_not_duplicate(self):
        run_cli(self.path, "add", "--json", json.dumps(
            self._entry(firstSeen=iso(300), appliedDate=iso(250))))
        rc, out, _ = run_cli(self.path, "check", "greenhouse:111")
        self.assertFalse(json.loads(out)["duplicate"])

    def test_list_status_filter(self):
        run_cli(self.path, "add", "--json", json.dumps(self._entry()))
        run_cli(self.path, "add", "--json", json.dumps(
            self._entry(key="lever:222", ats="lever", jobId="222",
                        status="submitted")))
        rc, out, _ = run_cli(self.path, "list", "--status", "submitted")
        entries = json.loads(out)
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["key"], "lever:222")

    # --- Redesign: status-history trail + referral flag ---

    def test_add_initializes_referral_and_history(self):
        run_cli(self.path, "add", "--json", json.dumps(self._entry(status="new")))
        e = load(self.path)["entries"][0]
        self.assertEqual(e["referral"], False)
        self.assertEqual(e["statusHistory"], [{"status": "new", "date": e["firstSeen"]}])

    def test_mark_appends_to_status_history(self):
        run_cli(self.path, "add", "--json", json.dumps(self._entry(status="built")))
        run_cli(self.path, "mark", "greenhouse:111", "--status", "submitted")
        run_cli(self.path, "mark", "greenhouse:111", "--status", "interview")
        hist = load(self.path)["entries"][0]["statusHistory"]
        self.assertEqual([h["status"] for h in hist],
                         ["built", "submitted", "interview"])

    def test_mark_history_dedupes_repeats(self):
        run_cli(self.path, "add", "--json", json.dumps(self._entry(status="built")))
        run_cli(self.path, "mark", "greenhouse:111", "--status", "submitted")
        run_cli(self.path, "mark", "greenhouse:111", "--status", "submitted")
        hist = load(self.path)["entries"][0]["statusHistory"]
        self.assertEqual([h["status"] for h in hist], ["built", "submitted"])

    def test_mark_referral_only(self):
        run_cli(self.path, "add", "--json", json.dumps(self._entry()))
        rc, out, err = run_cli(self.path, "mark", "greenhouse:111",
                               "--referral", "true")
        self.assertEqual(rc, 0, err)
        self.assertEqual(load(self.path)["entries"][0]["referral"], True)

    def test_mark_requires_status_or_referral(self):
        run_cli(self.path, "add", "--json", json.dumps(self._entry()))
        rc, _, _ = run_cli(self.path, "mark", "greenhouse:111")  # neither flag
        self.assertEqual(rc, 2)  # argparse usage error

    def test_upsert_does_not_clobber_referral(self):
        run_cli(self.path, "add", "--json", json.dumps(self._entry(status="built")))
        run_cli(self.path, "mark", "greenhouse:111", "--referral", "true")
        # A reconcile-style re-add must not reset the referral flag to False.
        run_cli(self.path, "add", "--json", json.dumps(
            self._entry(status="built", folder="applied/x")))
        self.assertEqual(load(self.path)["entries"][0]["referral"], True)


if __name__ == "__main__":
    unittest.main()
