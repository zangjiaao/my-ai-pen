"""Unit tests for node connectivity sparkline helpers."""
from __future__ import annotations

import unittest
from datetime import datetime, timedelta, timezone

from app.api.nodes import (
    _build_connectivity_bars,
    _collapse_reconnect_blips,
)


class CollapseReconnectBlipsTests(unittest.TestCase):
    def test_drops_short_offline_flaps(self):
        t0 = datetime(2026, 1, 1, 12, 0, tzinfo=timezone.utc)
        events = [
            (t0, True),
            (t0 + timedelta(seconds=30), False),  # blip offline
            (t0 + timedelta(seconds=45), True),  # back within 120s
            (t0 + timedelta(minutes=10), False),  # real outage
            (t0 + timedelta(minutes=15), True),
        ]
        out = _collapse_reconnect_blips(events, min_down=timedelta(seconds=120))
        # Short flap removed; real offline kept.
        self.assertEqual(
            [(online) for _, online in out],
            [True, False, True],
        )
        self.assertEqual(out[1][0], t0 + timedelta(minutes=10))

    def test_keeps_long_outage(self):
        t0 = datetime(2026, 1, 1, 12, 0, tzinfo=timezone.utc)
        events = [
            (t0, True),
            (t0 + timedelta(minutes=1), False),
            (t0 + timedelta(minutes=5), True),
        ]
        out = _collapse_reconnect_blips(events, min_down=timedelta(seconds=120))
        self.assertEqual(len(out), 3)
        self.assertFalse(out[1][1])


class BuildConnectivityBarsTests(unittest.TestCase):
    def test_stable_online_is_all_up(self):
        now = datetime(2026, 1, 2, 12, 0, tzinfo=timezone.utc)
        window_start = now - timedelta(hours=24)
        bars = _build_connectivity_bars(
            events=[(window_start - timedelta(hours=1), True)],
            now=now,
            window_start=window_start,
            buckets=10,
            current_online=True,
            registered_at=window_start - timedelta(days=7),
        )
        self.assertTrue(all(b.status == "up" for b in bars))

    def test_brief_flap_majority_stays_up(self):
        now = datetime(2026, 1, 2, 12, 0, tzinfo=timezone.utc)
        window_start = now - timedelta(hours=1)
        # One 10s offline blip in the only bucket window (1h / 1 bucket).
        events = [
            (window_start - timedelta(minutes=5), True),
            (window_start + timedelta(minutes=30), False),
            (window_start + timedelta(minutes=30, seconds=10), True),
        ]
        bars = _build_connectivity_bars(
            events=events,
            now=now,
            window_start=window_start,
            buckets=1,
            current_online=True,
            registered_at=window_start - timedelta(days=1),
        )
        self.assertEqual(len(bars), 1)
        self.assertEqual(bars[0].status, "up")

    def test_full_outage_bucket_is_down(self):
        now = datetime(2026, 1, 2, 12, 0, tzinfo=timezone.utc)
        window_start = now - timedelta(hours=2)
        events = [
            (window_start - timedelta(minutes=1), True),
            (window_start + timedelta(minutes=5), False),
        ]
        bars = _build_connectivity_bars(
            events=events,
            now=now,
            window_start=window_start,
            buckets=2,
            current_online=False,
            registered_at=window_start - timedelta(days=1),
        )
        # Second half of window stays offline.
        self.assertEqual(bars[-1].status, "down")


if __name__ == "__main__":
    unittest.main()
