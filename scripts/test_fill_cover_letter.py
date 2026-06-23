#!/usr/bin/env python3
"""Tests for fill-cover-letter.py's empty-paragraph dropper — the fix that stops
unused RISK_*/MAP_* fields from leaving blank gaps mid-letter.

Run:  python3 -m unittest discover -s scripts -t scripts -p "test_*.py"
"""
import importlib.util
import os
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("fill_cl", os.path.join(HERE, "fill-cover-letter.py"))
fcl = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(fcl)

ALL = {"{{RISK_1}}", "{{RISK_2}}", "{{RISK_3}}", "{{MAP_1_LEAD}}", "{{MAP_1_BODY}}"}


def P(*tokens):
    """A minimal <w:p> containing the given tokens inside <w:t> runs."""
    runs = "".join(f"<w:r><w:t>{t}</w:t></w:r>" for t in tokens)
    return f"<w:p><w:pPr><w:spacing w:after=\"140\"/></w:pPr>{runs}</w:p>"


class TestDropEmptyParagraphs(unittest.TestCase):
    def test_drops_paragraph_with_only_empty_token(self):
        text = P("{{RISK_1}}") + P("{{RISK_2}}") + P("{{RISK_3}}")
        out = fcl.drop_empty_paragraphs(text, {"{{RISK_2}}", "{{RISK_3}}"}, ALL)
        self.assertIn("{{RISK_1}}", out)
        self.assertNotIn("{{RISK_2}}", out)
        self.assertNotIn("{{RISK_3}}", out)
        self.assertEqual(out.count("<w:p>"), 1)  # only RISK_1's paragraph remains

    def test_keeps_spacer_paragraph_without_tokens(self):
        # A deliberate empty spacer (the date→body gap) has no token → must stay.
        spacer = '<w:p><w:pPr><w:spacing w:after="150"/></w:pPr></w:p>'
        text = spacer + P("{{RISK_2}}")
        out = fcl.drop_empty_paragraphs(text, {"{{RISK_2}}"}, ALL)
        self.assertIn(spacer, out)
        self.assertNotIn("{{RISK_2}}", out)

    def test_keeps_paragraph_mixing_empty_and_filled_tokens(self):
        # If a paragraph has one empty + one filled token, keep it (don't lose data).
        text = P("{{MAP_1_LEAD}}", "{{MAP_1_BODY}}")
        out = fcl.drop_empty_paragraphs(text, {"{{MAP_1_BODY}}"}, ALL)
        self.assertEqual(out, text)

    def test_no_empty_tokens_is_noop(self):
        text = P("{{RISK_1}}") + P("{{MAP_1_LEAD}}", "{{MAP_1_BODY}}")
        self.assertEqual(fcl.drop_empty_paragraphs(text, set(), ALL), text)


if __name__ == "__main__":
    unittest.main()
