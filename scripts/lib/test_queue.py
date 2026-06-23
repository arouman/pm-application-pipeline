#!/usr/bin/env python3
"""Characterization tests for queue.py — the build work-queue.

CLI contract tests (subprocess) exercising the exact surface run-batch.sh and
the bridge server depend on: add / status / list / next / claim / complete /
fail / skip / reset-building.

Item lifecycle (current): pending -> building -> built | error | skipped

Run:  python3 -m unittest discover -s scripts/lib -t scripts/lib -p "test_*.py"
"""
import json
import os
import subprocess
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
QUEUE_PY = os.path.join(HERE, "queue.py")


def run_cli(path, *args):
    r = subprocess.run(
        ["python3", QUEUE_PY, path, *args],
        capture_output=True, text=True,
    )
    return r.returncode, r.stdout.strip(), r.stderr.strip()


def load(path):
    with open(path) as fh:
        return json.load(fh)


def item(_id, **over):
    it = {"id": _id, "company": "Acme", "title": "Product Designer"}
    it.update(over)
    return it


class TestQueueCli(unittest.TestCase):
    def setUp(self):
        fd, self.path = tempfile.mkstemp(suffix=".json")
        os.close(fd)
        with open(self.path, "w") as fh:
            json.dump({"version": 1, "items": []}, fh)

    def tearDown(self):
        os.unlink(self.path)

    def _items(self):
        return load(self.path)["items"]

    def _by_id(self, _id):
        return next((x for x in self._items() if x["id"] == _id), None)

    def test_add_sets_pending_default(self):
        rc, out, err = run_cli(self.path, "add", "--json", json.dumps(item("a")))
        self.assertEqual(rc, 0, err)
        self.assertEqual(self._by_id("a")["status"], "pending")

    def test_add_dedups_by_id(self):
        run_cli(self.path, "add", "--json", json.dumps(item("a")))
        rc, out, _ = run_cli(self.path, "add", "--json", json.dumps(item("a")))
        self.assertIn("dup", out)
        self.assertEqual(len(self._items()), 1)

    def test_status_counts(self):
        run_cli(self.path, "add", "--json", json.dumps(item("a")))
        run_cli(self.path, "add", "--json", json.dumps(item("b")))
        rc, out, _ = run_cli(self.path, "status")
        counts = json.loads(out)
        self.assertEqual(counts["total"], 2)
        self.assertEqual(counts["pending"], 2)

    def test_next_claims_pending_to_building(self):
        run_cli(self.path, "add", "--json", json.dumps(item("a")))
        rc, out, err = run_cli(self.path, "next")
        self.assertEqual(rc, 0, err)
        claimed = json.loads(out)
        self.assertEqual(claimed["id"], "a")
        self.assertEqual(self._by_id("a")["status"], "building")

    def test_next_empty_when_no_pending(self):
        # An item already building should not be re-claimed.
        run_cli(self.path, "add", "--json", json.dumps(item("a")))
        run_cli(self.path, "next")            # a -> building
        rc, out, _ = run_cli(self.path, "next")
        self.assertEqual(out, "")             # nothing left pending

    def test_complete_sets_built_with_folder(self):
        run_cli(self.path, "add", "--json", json.dumps(item("a")))
        run_cli(self.path, "claim", "a")
        run_cli(self.path, "complete", "a", "--folder", "applied/x",
                "--coverage", "93")
        it = self._by_id("a")
        self.assertEqual(it["status"], "built")
        self.assertEqual(it["folder"], "applied/x")
        self.assertEqual(it["coverage"], "93")

    def test_fail_sets_error_with_message(self):
        run_cli(self.path, "add", "--json", json.dumps(item("a")))
        run_cli(self.path, "fail", "a", "--error", "API 500")
        it = self._by_id("a")
        self.assertEqual(it["status"], "error")
        self.assertEqual(it["error"], "API 500")

    def test_skip_sets_skipped(self):
        run_cli(self.path, "add", "--json", json.dumps(item("a")))
        run_cli(self.path, "skip", "a", "--error", "passed by Rob")
        self.assertEqual(self._by_id("a")["status"], "skipped")

    def test_reset_building_recovers_crashed(self):
        run_cli(self.path, "add", "--json", json.dumps(item("a")))
        run_cli(self.path, "add", "--json", json.dumps(item("b")))
        run_cli(self.path, "claim", "a")
        run_cli(self.path, "claim", "b")
        rc, out, _ = run_cli(self.path, "reset-building")
        self.assertEqual(out, "reset 2")
        self.assertEqual(self._by_id("a")["status"], "pending")
        self.assertEqual(self._by_id("b")["status"], "pending")

    def test_list_default_pending(self):
        run_cli(self.path, "add", "--json", json.dumps(item("a")))
        run_cli(self.path, "add", "--json", json.dumps(item("b")))
        run_cli(self.path, "claim", "b")          # b -> building
        rc, out, _ = run_cli(self.path, "list")   # default: pending
        self.assertEqual(out, "a")

    # --- Redesign: review-inbox lifecycle (new → pending via build; → passed) ---

    def test_build_promotes_new_to_pending(self):
        run_cli(self.path, "add", "--json", json.dumps(item("a", status="new")))
        rc, out, err = run_cli(self.path, "build", "a")
        self.assertEqual(rc, 0, err)
        self.assertEqual(self._by_id("a")["status"], "pending")

    def test_pass_sets_passed(self):
        run_cli(self.path, "add", "--json", json.dumps(item("a", status="new")))
        rc, out, err = run_cli(self.path, "pass", "a")
        self.assertEqual(rc, 0, err)
        self.assertEqual(self._by_id("a")["status"], "passed")

    def test_build_missing_id_errors(self):
        rc, _, _ = run_cli(self.path, "build", "ghost")
        self.assertEqual(rc, 1)

    def test_next_never_claims_new(self):
        # The watcher writes "new" items; run-batch must NOT auto-build them.
        run_cli(self.path, "add", "--json", json.dumps(item("a", status="new")))
        rc, out, _ = run_cli(self.path, "next")
        self.assertEqual(out, "")                       # nothing claimable
        self.assertEqual(self._by_id("a")["status"], "new")  # untouched
        # After Rob clicks Build, it becomes claimable.
        run_cli(self.path, "build", "a")
        rc, out, _ = run_cli(self.path, "next")
        self.assertEqual(json.loads(out)["id"], "a")

    # --- Fix 4: startedAt timestamp stamped on claim/next ---

    def test_next_stamps_startedAt(self):
        """queue.py next must stamp startedAt (unix seconds) on the claimed item."""
        import time
        before = int(time.time())
        run_cli(self.path, "add", "--json", json.dumps(item("a")))
        run_cli(self.path, "next")
        after = int(time.time())
        it = self._by_id("a")
        self.assertIn("startedAt", it, "startedAt missing after next")
        ts = it["startedAt"]
        self.assertGreaterEqual(ts, before)
        self.assertLessEqual(ts, after)

    def test_claim_stamps_startedAt(self):
        """queue.py claim must also stamp startedAt."""
        import time
        before = int(time.time())
        run_cli(self.path, "add", "--json", json.dumps(item("a")))
        run_cli(self.path, "claim", "a")
        after = int(time.time())
        it = self._by_id("a")
        self.assertIn("startedAt", it)
        self.assertGreaterEqual(it["startedAt"], before)
        self.assertLessEqual(it["startedAt"], after)

    # --- Fix 1/4: stale-building resets orphaned building items ---

    def test_stale_building_resets_old_items(self):
        """stale-building resets items whose startedAt is older than threshold."""
        run_cli(self.path, "add", "--json", json.dumps(item("a")))
        run_cli(self.path, "claim", "a")
        # Manually set startedAt far in the past to simulate a crashed build.
        with open(self.path) as fh:
            data = json.load(fh)
        data["items"][0]["startedAt"] = 1000000  # epoch 1970-ish, definitely stale
        with open(self.path, "w") as fh:
            json.dump(data, fh)
        rc, out, _ = run_cli(self.path, "stale-building", "--older-than", "60")
        self.assertEqual(rc, 0)
        self.assertIn("reset 1", out)
        self.assertEqual(self._by_id("a")["status"], "pending")

    def test_stale_building_does_not_reset_fresh_items(self):
        """stale-building must not reset a recently-started build."""
        run_cli(self.path, "add", "--json", json.dumps(item("a")))
        run_cli(self.path, "next")  # stamps startedAt = now
        rc, out, _ = run_cli(self.path, "stale-building", "--older-than", "9999")
        self.assertEqual(rc, 0)
        self.assertIn("reset 0", out)
        self.assertEqual(self._by_id("a")["status"], "building")

    def test_stale_building_resets_legacy_items_without_startedAt(self):
        """An item in building with no startedAt (legacy orphan) must be reset."""
        run_cli(self.path, "add", "--json", json.dumps(item("a")))
        run_cli(self.path, "claim", "a")
        # Remove startedAt to simulate a pre-fix orphan.
        with open(self.path) as fh:
            data = json.load(fh)
        data["items"][0].pop("startedAt", None)
        with open(self.path, "w") as fh:
            json.dump(data, fh)
        rc, out, _ = run_cli(self.path, "stale-building", "--older-than", "0")
        self.assertEqual(rc, 0)
        self.assertIn("reset 1", out)
        self.assertEqual(self._by_id("a")["status"], "pending")

    def test_reset_building_clears_startedAt(self):
        """reset-building should also clear startedAt so the item is clean."""
        run_cli(self.path, "add", "--json", json.dumps(item("a")))
        run_cli(self.path, "next")
        # Manually verify startedAt is there, then reset.
        self.assertIn("startedAt", self._by_id("a"))
        run_cli(self.path, "reset-building")
        # After reset, status must be pending; startedAt may remain (not harmful)
        # but the item must be pending (that's what matters for run-batch).
        self.assertEqual(self._by_id("a")["status"], "pending")


if __name__ == "__main__":
    unittest.main()
