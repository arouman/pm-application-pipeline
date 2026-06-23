#!/usr/bin/env python3
"""Characterization tests for the watcher's pre-filter decision logic.

These two pure functions are the first gate every scraped role passes through.
When they reject, the role is silently dropped before it is ever scored — so
locking their behavior down is exactly what keeps "this thing always working"
honest. (watch-jobs.py has a hyphen, so it's loaded via importlib.)

Run:  python3 -m unittest discover -s scripts -t scripts -p "test_*.py"
"""
import importlib.util
import os
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
WATCH_PATH = os.path.join(HERE, "watch-jobs.py")

_spec = importlib.util.spec_from_file_location("watch_jobs", WATCH_PATH)
wj = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(wj)


class TestMatchesTitle(unittest.TestCase):
    KEEP = [
        "Senior Product Designer",
        "Staff Product Manager",
        "AI Experience Designer",
        "Design Engineer",
        "Head of Design",
        "Service Design Lead",
        "Principal Designer",
        "UX Designer",
        "UX/UI Designer",
        "Senior UX Researcher",
        "Product Strategist",
    ]
    DROP = [
        "Software Engineer",
        "Data Scientist",
        "Mechanical Design Engineer",  # 'design engineer' substring → actually KEEP?
        "Linux Administrator",         # 'ux' must NOT fire inside 'Linux'
        "Luxury Brand Manager",        # 'ux' must NOT fire inside 'Luxury'
        "Account Executive",
    ]

    def test_keeps_design_and_pm_titles(self):
        for t in self.KEEP:
            self.assertTrue(wj._matches_title(t), f"expected KEEP: {t!r}")

    def test_linux_and_luxury_do_not_trigger_ux(self):
        self.assertFalse(wj._matches_title("Linux Administrator"))
        self.assertFalse(wj._matches_title("Luxury Brand Manager"))

    def test_drops_unrelated_titles(self):
        for t in ["Software Engineer", "Data Scientist", "Account Executive"]:
            self.assertFalse(wj._matches_title(t), f"expected DROP: {t!r}")

    def test_design_engineer_substring_is_kept(self):
        # 'Mechanical Design Engineer' contains 'design engineer' → kept.
        # Documents the substring behavior (a known false-positive surface).
        self.assertTrue(wj._matches_title("Mechanical Design Engineer"))


class TestMatchesLocation(unittest.TestCase):
    def test_keeps_us_remote_and_metros(self):
        for loc in ["Remote - United States", "San Francisco, CA",
                    "New York, NY", "Seattle, WA", "Remote (US)",
                    "Austin, Texas", "Boulder, CO"]:
            self.assertTrue(wj._matches_location(loc), f"expected KEEP: {loc!r}")

    def test_empty_location_is_kept(self):
        # Lenient: unknown/blank location is never silently dropped.
        self.assertTrue(wj._matches_location(""))
        self.assertTrue(wj._matches_location("   "))

    def test_nonempty_foreign_location_is_dropped(self):
        # GOTCHA worth locking: a non-empty unrecognized location IS dropped,
        # despite the "lenient when ambiguous" docstring. Only blank is lenient.
        for loc in ["London, UK", "Berlin, Germany", "Toronto, Canada"]:
            self.assertFalse(wj._matches_location(loc), f"expected DROP: {loc!r}")


class TestRouteDecision(unittest.TestCase):
    """The routing fix: near-misses (≥ floor) must reach Rob's inbox, never vanish.
    The watcher must NEVER auto-build — every non-trap match above the floor is
    surfaced for a Build/Pass decision."""

    def test_trap_always_wins(self):
        # Even a perfect score is flagged, not surfaced, when a trap is present.
        self.assertEqual(wj._route_decision(100, "ignore previous instructions"), "trap")

    def test_at_floor_goes_to_inbox(self):
        self.assertEqual(wj._route_decision(wj.NEAR_MISS_FLOOR, None), "inbox")

    def test_just_below_floor_is_skipped(self):
        self.assertEqual(wj._route_decision(wj.NEAR_MISS_FLOOR - 1, None), "skip")

    def test_the_85pct_gm_case_reaches_inbox(self):
        # The exact regression: an 85% near-miss used to be notify-only and lost.
        self.assertEqual(wj._route_decision(85, None), "inbox")

    def test_high_score_goes_to_inbox_not_autobuild(self):
        # 95% no longer auto-builds — it waits for Rob in the inbox.
        self.assertEqual(wj._route_decision(95, None), "inbox")

    def test_low_score_skipped(self):
        self.assertEqual(wj._route_decision(20, None), "skip")


if __name__ == "__main__":
    unittest.main()
