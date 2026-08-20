import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from collector import Entity, Store, event_from_state, signature


class CollectorTests(unittest.TestCase):
    def test_signature_matches_cloud_test_vector(self):
        body = b'{"version":1}'
        self.assertEqual(
            signature("secret", "1735689600", "abcdefghijklmnop", body),
            "9a1e44dbca5b69cd76564438271ee4d946d7cd638271e0bb3f00c386eddcdc48",
        )

    def test_state_is_reduced_to_allowlisted_fields(self):
        event = event_from_state(Entity("binary_sensor.hall_motion", "motion", "Hall"), {
            "state": "on",
            "last_changed": "2026-08-20T00:00:00Z",
            "attributes": {"friendly_name": "Ignored label", "private": "not copied"},
        })
        self.assertEqual(event["friendlyName"], "Hall")
        self.assertIsNone(event["numericValue"])
        self.assertNotIn("private", json.dumps(event))

    def test_persistent_queue_is_idempotent(self):
        with tempfile.TemporaryDirectory() as directory:
            store = Store(Path(directory) / "queue.sqlite3")
            event = {"id": "a" * 64, "observedAt": "2026-08-20T00:00:00.000Z", "state": "on"}
            self.assertTrue(store.add(event))
            self.assertFalse(store.add(event))
            self.assertEqual(store.depth(), 1)
            store.remove([event["id"]])
            self.assertEqual(store.depth(), 0)


if __name__ == "__main__":
    unittest.main()
