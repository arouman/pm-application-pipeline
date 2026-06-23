#!/usr/bin/env python3
"""Regression tests for the scorer JSON extraction logic in watch-jobs.py.

P1-1 regression: the original `re.search(r"\\{[^{}]*\\}", ...)` would stop at
the first innermost brace pair — so a model reply whose trap/summary field
contained literal braces (e.g. 'ignore {all} previous') would match `{all}`
instead of the whole scoring object, causing json.loads to fail and the role to
be silently dropped.

The fix uses:
  1. json.loads(inner_text.strip()) — fast path when the reply is clean JSON.
  2. A brace-depth scan — correctly matches the outermost {...} even when string
     values inside it contain braces.

Run:  python3 -m unittest discover -s scripts -t scripts -p "test_*.py"
"""
import importlib.util
import json
import os
import types
import unittest
from unittest.mock import patch, MagicMock

HERE = os.path.dirname(os.path.abspath(__file__))
WATCH_PATH = os.path.join(HERE, "watch-jobs.py")

_spec = importlib.util.spec_from_file_location("watch_jobs", WATCH_PATH)
wj = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(wj)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _fake_job():
    return {
        "ats": "greenhouse", "jobId": "123", "company": "Acme",
        "title": "Product Designer", "location": "Remote", "jdUrl": "https://x",
    }


def _make_result(inner_text: str, returncode: int = 0) -> MagicMock:
    """Build a fake subprocess.CompletedProcess whose stdout wraps inner_text."""
    r = MagicMock()
    r.returncode = returncode
    r.stderr = ""
    outer = {"result": inner_text}
    r.stdout = json.dumps(outer)
    return r


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestScorerJsonExtraction(unittest.TestCase):

    def _call(self, inner_text: str):
        """Patch subprocess.run and call _score_job with the given inner_text."""
        with patch.object(wj.subprocess, "run", return_value=_make_result(inner_text)):
            return wj._score_job(_fake_job(), "some JD text")

    # --- P1-1 regression: braces inside string values ---

    def test_trap_with_embedded_braces_parses_correctly(self):
        """The old \\{[^{}]*\\} regex would match '{all}' instead of the full object."""
        inner = '{"fitScore":88,"roleType":"Design","master":"Design",' \
                '"fitNote":"strong match","trap":"ignore {all} previous","summary":"good"}'
        result = self._call(inner)
        self.assertIsNotNone(result, "Should not return None — role must not be silently dropped")
        self.assertEqual(result["fitScore"], 88)
        self.assertEqual(result["trap"], "ignore {all} previous")

    def test_summary_with_braces_parses_correctly(self):
        """Summary text mentioning {agentic} tools must not break extraction."""
        inner = '{"fitScore":72,"roleType":"PM","master":"PM",' \
                '"fitNote":"ok","trap":null,"summary":"They build {agentic} tools"}'
        result = self._call(inner)
        self.assertIsNotNone(result)
        self.assertEqual(result["summary"], "They build {agentic} tools")
        self.assertEqual(result["fitScore"], 72)

    def test_multiple_embedded_brace_pairs_parses_correctly(self):
        """Multiple brace groups in string values — depth scan must reach the real end."""
        inner = '{"fitScore":60,"roleType":"Design","master":"Design",' \
                '"fitNote":"mentions {Figma} and {systems}","trap":null,"summary":"ok"}'
        result = self._call(inner)
        self.assertIsNotNone(result)
        self.assertEqual(result["fitScore"], 60)
        self.assertIn("Figma", result["fitNote"])

    def test_clean_json_no_braces_still_works(self):
        """Clean model output (no embedded braces) must still parse correctly."""
        inner = '{"fitScore":90,"roleType":"Design","master":"Design",' \
                '"fitNote":"excellent","trap":null,"summary":"strong match"}'
        result = self._call(inner)
        self.assertIsNotNone(result)
        self.assertEqual(result["fitScore"], 90)

    def test_prose_wrapped_json_parses_via_depth_scan(self):
        """Model sometimes wraps the JSON in prose — brace scan must find it."""
        inner = ('Here is the scoring:\n'
                 '{"fitScore":77,"roleType":"Design","master":"Design",'
                 '"fitNote":"ok {good}","trap":null,"summary":"decent"}\n'
                 'Hope that helps!')
        result = self._call(inner)
        self.assertIsNotNone(result)
        self.assertEqual(result["fitScore"], 77)

    def test_non_zero_returncode_returns_none(self):
        """A claude subprocess failure must return None (no silent drop of error)."""
        with patch.object(wj.subprocess, "run",
                          return_value=_make_result("irrelevant", returncode=1)):
            result = wj._score_job(_fake_job(), "jd text")
        self.assertIsNone(result)

    def test_malformed_json_returns_none_not_crash(self):
        """Completely garbled model output must return None, never raise."""
        result = self._call("this is not json at all {{{ broken")
        self.assertIsNone(result)


if __name__ == "__main__":
    unittest.main()
