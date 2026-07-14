"""Phase B/C/D pure transforms + schedule fire (no fake findings theater)."""
from __future__ import annotations

import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "platform" / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from app.services.engagement_dashboard import (
    activity_from_snapshot_messages,
    build_engagement_dashboard,
)
from app.services.engagement_report import build_engagement_report_markdown
from app.services.schedule_tasks import (
    ScheduleStore,
    build_task_assign_envelope,
    materialize_schedule_fire,
    parse_interval_seconds,
    should_fire,
)


class EngagementReportTests(unittest.TestCase):
    def test_report_includes_real_finding_titles_and_severities(self):
        findings = [
            {
                "title": "SQL Injection on /search",
                "severity": "high",
                "description": "Boolean-based difference on q=",
                "poc": "q=1' OR '1'='1",
                "remediation": "Use parameterized queries",
                "evidence_ids": ["ev-1"],
            },
            {
                "title": "Reflected XSS name",
                "severity": "medium",
                "description": "name reflected unescaped",
                "evidence_ids": [],
            },
        ]
        md = build_engagement_report_markdown(
            title="Lab report",
            target="http://127.0.0.1:8080",
            scope="http://127.0.0.1:8080",
            engagement="pentest",
            conversation_id="conv-1",
            findings=findings,
            evidence_by_id={"ev-1": {"summary": "HTTP 200 differential"}},
        )
        self.assertIn("SQL Injection on /search", md)
        self.assertIn("Reflected XSS name", md)
        self.assertIn("high", md)
        self.assertIn("medium", md)
        self.assertIn("http://127.0.0.1:8080", md)
        self.assertIn("parameterized queries", md)
        self.assertIn("ev-1", md)
        self.assertIn("_(none in source data)_", md)  # no invented CVE
        self.assertNotIn("CVE-2024-FAKE", md)

    def test_empty_findings_no_fabricated_rows(self):
        md = build_engagement_report_markdown(findings=[])
        self.assertIn("Findings booked: **0**", md)
        self.assertIn("_No confirmed findings", md)


class EngagementDashboardTests(unittest.TestCase):
    def test_dashboard_surfaces_real_findings_only(self):
        dto = build_engagement_dashboard(
            conversation={"id": "c1", "title": "DVWA", "status": "running", "task": {"engagement": "pentest", "target": "http://t"}},
            agent_state={"phase": "recon", "activeTool": "shell"},
            findings=[
                {"id": "1", "title": "Command Injection IP", "severity": "critical", "status": "confirmed"},
                {"title": "CSRF logout", "severity": "low"},
            ],
            timeline_events=[{"id": "e1", "type": "status", "title": "tool burst", "at": "2026-07-14T00:00:00Z"}],
            engagement="pentest",
            target="http://t",
            progress={"current": 2, "total": 5},
        )
        self.assertEqual(dto["findings_count"], 2)
        titles = [f["title"] for f in dto["findings"]]
        self.assertIn("Command Injection IP", titles)
        self.assertIn("CSRF logout", titles)
        self.assertEqual(dto["severity_counts"].get("critical"), 1)
        self.assertEqual(dto["engagement"], "pentest")
        self.assertEqual(dto["agent"]["active_tool"], "shell")
        self.assertEqual(len(dto["activity"]), 1)
        # Must not invent extra findings
        self.assertEqual(len(dto["findings"]), 2)

    def test_activity_from_message_summary_shaped_rows(self):
        """Real snapshot rows use msg_type + nested content (not type/text)."""
        messages = [
            {
                "id": "m1",
                "msg_type": "tool_call",
                "content": {"tool_name": "shell", "status": "done", "command": "curl -s http://t/"},
                "created_at": "2026-07-14T01:00:00Z",
            },
            {
                "id": "m2",
                "msg_type": "status",
                "content": {"phase": "recon", "text": "mapping modules", "active_tool": "session"},
                "created_at": "2026-07-14T01:00:01Z",
            },
            {
                "id": "m3",
                "msg_type": "vuln_card",
                "content": {"title": "SQLi on /search", "severity": "high"},
                "created_at": "2026-07-14T01:00:02Z",
            },
            {
                "id": "m4",
                "msg_type": "user",
                "content": {"text": "hello"},
                "created_at": "2026-07-14T01:00:03Z",
            },
        ]
        activity = activity_from_snapshot_messages(messages)
        self.assertGreaterEqual(len(activity), 3)
        types = {a["type"] for a in activity}
        self.assertIn("tool_call", types)
        self.assertIn("status", types)
        self.assertIn("vuln_card", types)
        self.assertNotIn("user", types)
        titles = " ".join(a["title"] for a in activity)
        self.assertTrue("shell" in titles or "mapping" in titles or "SQLi" in titles)
        dto = build_engagement_dashboard(
            conversation={"id": "c1", "status": "running"},
            findings=[{"title": "SQLi on /search", "severity": "high"}],
            timeline_events=activity,
        )
        self.assertGreaterEqual(len(dto["activity"]), 3)
        self.assertEqual(dto["findings"][0]["title"], "SQLi on /search")


class ScheduleTasksTests(unittest.TestCase):
    def test_parse_interval(self):
        self.assertEqual(parse_interval_seconds("5m"), 300)
        self.assertEqual(parse_interval_seconds("2h"), 7200)
        self.assertGreaterEqual(parse_interval_seconds(30), 60)

    def test_task_assign_envelope_has_structured_engagement(self):
        store = ScheduleStore()
        st = store.create(
            user_id="u1",
            target="http://127.0.0.1:8080",
            scope="http://127.0.0.1:8080",
            engagement="pentest",
            instruction="Authorized retest of web app",
            interval="1h",
            fire_immediately=True,
        )
        env = build_task_assign_envelope(st, task_id="task-fixed")
        self.assertEqual(env["type"], "task_assign")
        self.assertEqual(env["engagement"], "pentest")
        self.assertEqual(env["role"], "pentest")
        self.assertEqual(env["target"], "http://127.0.0.1:8080")
        self.assertIn("instruction", env)
        self.assertEqual(env["task_id"], "task-fixed")
        self.assertEqual(env["schedule_id"], st.id)

    def test_tick_fires_due_schedule(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "schedules.json"
            store = ScheduleStore(path)
            st = store.create(
                user_id="u1",
                target="http://example.test",
                scope="http://example.test",
                engagement="ctf",
                instruction="Retest flags within scope",
                interval="1h",
                fire_immediately=True,
            )
            now = datetime.now(timezone.utc)
            self.assertTrue(should_fire(st, now))
            fired = store.tick(now, user_id="u1")
            self.assertEqual(len(fired), 1)
            self.assertEqual(fired[0]["engagement"], "ctf")
            self.assertEqual(fired[0]["target"], "http://example.test")
            self.assertTrue(fired[0]["task_id"])
            # Second tick should not re-fire immediately (next_fire advanced)
            st2 = store.get(st.id)
            assert st2 is not None
            future_ok = should_fire(st2, now + timedelta(seconds=10))
            self.assertFalse(future_ok)
            # After interval, fires again
            later = now + timedelta(seconds=st2.interval_seconds + 5)
            self.assertTrue(should_fire(st2, later))
            fired2 = store.tick(later, user_id="u1")
            self.assertEqual(len(fired2), 1)
            self.assertEqual(fired2[0]["engagement"], "ctf")

    def test_tick_does_not_advance_other_users_schedules(self):
        store = ScheduleStore()
        a = store.create(
            user_id="alice",
            target="http://a.test",
            scope="http://a.test",
            engagement="pentest",
            instruction="A",
            interval="1h",
            fire_immediately=True,
        )
        b = store.create(
            user_id="bob",
            target="http://b.test",
            scope="http://b.test",
            engagement="pentest",
            instruction="B",
            interval="1h",
            fire_immediately=True,
        )
        bob_before = store.get(b.id)
        assert bob_before is not None
        bob_next_before = bob_before.next_fire_at
        fired = store.tick(user_id="alice")
        self.assertEqual(len(fired), 1)
        self.assertEqual(fired[0]["target"], "http://a.test")
        bob_after = store.get(b.id)
        assert bob_after is not None
        self.assertEqual(bob_after.next_fire_at, bob_next_before)
        self.assertIsNone(bob_after.last_task_id)

    def test_materialize_schedule_fire_has_task_assign_and_audit(self):
        store = ScheduleStore()
        st = store.create(
            user_id="u1",
            target="http://127.0.0.1:8080",
            scope="http://127.0.0.1:8080",
            engagement="pentest",
            instruction="Authorized retest",
            interval="1h",
            fire_immediately=True,
            node_id="00000000-0000-0000-0000-000000000099",
        )
        env = build_task_assign_envelope(st)
        record = materialize_schedule_fire(env, user_id="u1")
        self.assertEqual(record["audit"]["action"], "schedule.fire")
        self.assertEqual(record["task_assign"]["type"], "task_assign")
        self.assertEqual(record["task_assign"]["engagement"], "pentest")
        self.assertEqual(record["task_assign"]["target"], "http://127.0.0.1:8080")
        self.assertIn("task_id", record["task_assign"])
        self.assertEqual(record["conversation_context"]["task"]["engagement"], "pentest")
        self.assertEqual(record["conversation_context"]["source"], "schedule")
        # Durable observability: audit detail embeds full task_assign
        self.assertEqual(record["audit"]["detail"]["task_assign"]["engagement"], "pentest")
        self.assertEqual(record["audit"]["detail"]["target"], "http://127.0.0.1:8080")


if __name__ == "__main__":
    unittest.main()
