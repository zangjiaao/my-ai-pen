import asyncio
import io
import json
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NODE = ROOT / "node"
PLATFORM = ROOT / "platform" / "backend"
for candidate in (NODE, PLATFORM):
    if str(candidate) not in sys.path:
        sys.path.insert(0, str(candidate))

from app.api.sync import import_report, load_report_package  # noqa: E402
from pentest_node.db import NodeDB  # noqa: E402
from pentest_node.export import export_session  # noqa: E402
from pentest_node.standalone.runner import StandaloneOptions  # noqa: E402
from textual.geometry import Offset  # noqa: E402
from textual.selection import Selection  # noqa: E402
from pentest_node.tui.app import PentestTUI  # noqa: E402


class StandalonePhase4Tests(unittest.TestCase):
    def test_finding_upsert_preserves_new_vulnerability_metadata(self):
        async def scenario():
            with tempfile.TemporaryDirectory() as tmp:
                output = Path(tmp)
                db = NodeDB(output / "pentest-node.sqlite3")
                await db.init()
                await db.create_session(
                    session_id="s-meta",
                    task_id="t-meta",
                    target={"type": "url", "value": "http://192.0.2.1/"},
                    scope={"allow": ["http://192.0.2.1/"], "deny": []},
                    instruction="test target",
                    output_dir=str(output),
                    status="running",
                )
                await db.save_event("s-meta", {"type": "vuln_found", "finding_id": "finding-1", "title": "Possible SQL injection", "severity": "high", "status": "candidate", "evidence_ids": ["ev-1"]})
                await db.save_event("s-meta", {"type": "vuln_found", "finding_id": "finding-1", "title": "Possible SQL injection", "vuln_type": "sql_injection", "severity": "high", "status": "confirmed", "affected_asset": "http://192.0.2.1", "location": "GET http://192.0.2.1/search parameter=q", "evidence_ids": ["ev-1"]})
                snapshot = await db.snapshot("s-meta")
                await db.close()
                return snapshot["findings"][0]

        finding = asyncio.run(scenario())

        self.assertEqual(finding["status"], "confirmed")
        self.assertEqual(finding["vuln_type"], "sql_injection")
        self.assertEqual(finding["location"], "GET http://192.0.2.1/search parameter=q")
    def test_export_session_writes_unified_report_package(self):
        async def scenario():
            with tempfile.TemporaryDirectory() as tmp:
                output = Path(tmp)
                db = NodeDB(output / "pentest-node.sqlite3")
                await db.init()
                await db.create_session(
                    session_id="s1",
                    task_id="t1",
                    target={"type": "url", "value": "http://192.0.2.1/"},
                    scope={"allow": ["http://192.0.2.1/"], "deny": []},
                    instruction="test target",
                    output_dir=str(output),
                    status="completed",
                )
                await db.save_event("s1", {"type": "text", "content": {"text": "started"}})
                await db.save_event("s1", {"type": "asset_discovered", "address": "http://192.0.2.1/", "asset_type": "web"})
                await db.save_event("s1", {"type": "vuln_found", "finding_id": "finding-1", "title": "Reflected XSS", "vuln_type": "xss", "severity": "medium", "status": "confirmed", "evidence_ids": ["ev-111111111111"]})
                await db.save_event("s1", {"type": "evidence_created", "evidence_id": "ev-111111111111", "evidence_type": "http_trace", "source_tool": "http_request", "tool_run_id": "tool-1", "raw_ref": "evidence/ev-111111111111", "summary": "HTTP trace"})
                await db.save_event("s1", {"type": "attack_surface_discovered", "surface": {"surface_id": "surface-1", "kind": "url", "url": "http://192.0.2.1/"}})
                await db.save_event("s1", {"type": "coverage_marked", "coverage": {"coverage_id": "cov-1", "endpoint": "GET http://192.0.2.1/", "vuln_type": "xss", "status": "passed", "evidence_ids": ["ev-111111111111"]}})
                await db.save_event("s1", {"type": "checkpoint_update", "checkpoint": {"phase": "complete", "iteration": 2, "state": {"phase": "complete", "iteration": 2}, "captured_traffic": [{"request_id": "req-1", "method": "POST", "url": "http://192.0.2.1/login", "status_code": 200, "rank_score": 82, "source": "browser", "source_tool": "browser", "parameter_names": ["username"], "is_static": False}]}})
                evidence_file = output / "session-s1" / "evidence" / "ev-111111111111" / "response.txt"
                evidence_file.parent.mkdir(parents=True)
                evidence_file.write_text("HTTP/1.1 200 OK", encoding="utf-8")
                await db.close()

                tar_path = await export_session(output, "s1", output / "report.tar.gz")
                with tarfile.open(tar_path, "r:gz") as tar:
                    names = set(tar.getnames())
                    for name in {
                        "manifest.json",
                        "conversation.jsonl",
                        "assets.json",
                        "vulnerabilities.json",
                        "evidence.json",
                        "attack_surface.json",
                        "coverage.json",
                        "traffic.json",
                        "checkpoints/latest.json",
                        "evidence/ev-111111111111/response.txt",
                    }:
                        self.assertIn(name, names)
                    manifest = json.load(tar.extractfile("manifest.json"))
                    conversation = [json.loads(line) for line in tar.extractfile("conversation.jsonl").read().decode("utf-8").splitlines()]
                    assets = json.load(tar.extractfile("assets.json"))
                    vulnerabilities = json.load(tar.extractfile("vulnerabilities.json"))
                    evidence = json.load(tar.extractfile("evidence.json"))
                    traffic = json.load(tar.extractfile("traffic.json"))
                package = load_report_package(tar_path.read_bytes())
                return manifest, conversation, assets, vulnerabilities, evidence, traffic, package

        manifest, conversation, assets, vulnerabilities, evidence, traffic, package = asyncio.run(scenario())

        self.assertEqual(manifest["format_version"], "mvp-demo-v1")
        self.assertEqual(manifest["session_id"], "s1")
        self.assertEqual(manifest["target"]["value"], "http://192.0.2.1/")
        self.assertEqual(manifest["scope"]["allow"], ["http://192.0.2.1/"])
        self.assertEqual(conversation[0]["content"]["text"], "started")
        self.assertEqual(assets[0]["address"], "http://192.0.2.1/")
        self.assertEqual(vulnerabilities[0]["title"], "Reflected XSS")
        self.assertEqual(evidence[0]["evidence_id"], "ev-111111111111")
        self.assertEqual(package.manifest["session_id"], "s1")
        self.assertEqual(len(package.attack_surface), 1)
        self.assertEqual(len(package.coverage), 1)
        self.assertEqual(traffic[0]["request_id"], "req-1")
        self.assertEqual(package.manifest["counts"]["traffic"], 1)
        self.assertEqual(package.traffic[0]["request_id"], "req-1")
        self.assertIn("evidence/ev-111111111111/response.txt", package.evidence_files)


    def test_platform_import_creates_conversation_read_models(self):
        async def scenario():
            raw = _make_report_package_bytes()
            fake_db = FakeDB()
            result = await import_report(FakeUpload(raw), {"user_id": "11111111-1111-1111-1111-111111111111"}, fake_db)
            return result, fake_db.objects, fake_db.committed

        result, objects, committed = asyncio.run(scenario())

        type_names = [type(obj).__name__ for obj in objects]
        self.assertTrue(committed)
        self.assertEqual(result["messages_imported"], 1)
        self.assertEqual(result["assets_imported"], 1)
        self.assertEqual(result["vulns_imported"], 1)
        self.assertEqual(result["evidence_imported"], 1)
        self.assertIn("Conversation", type_names)
        self.assertIn("Message", type_names)
        self.assertIn("Asset", type_names)
        self.assertIn("Vulnerability", type_names)
        self.assertIn("Evidence", type_names)
        self.assertIn("AuditLog", type_names)

    def test_platform_import_infers_assets_from_vulnerabilities_when_assets_are_empty(self):
        async def scenario():
            raw = _make_report_package_bytes(
                assets=[],
                vulnerabilities=[
                    {"title": "Reflected XSS", "severity": "medium", "status": "confirmed", "affected_asset": "http://192.0.2.1/login", "evidence_ids": ["ev-1"]},
                    {"title": "Candidate XSS", "severity": "medium", "status": "candidate", "affected_asset": "http://192.0.2.1/candidate", "evidence_ids": ["ev-1"]},
                ],
            )
            fake_db = FakeDB()
            result = await import_report(FakeUpload(raw), {"user_id": "11111111-1111-1111-1111-111111111111"}, fake_db)
            return result, fake_db.objects

        result, objects = asyncio.run(scenario())

        assets = [obj for obj in objects if type(obj).__name__ == "Asset"]
        vulns = [obj for obj in objects if type(obj).__name__ == "Vulnerability"]
        self.assertEqual(result["assets_imported"], 1)
        self.assertEqual(result["vulns_imported"], 1)
        self.assertEqual(assets[0].address, "http://192.0.2.1/login")
        self.assertEqual(vulns[0].asset_id, assets[0].id)

    def test_tui_export_command_writes_report_package(self):
        async def scenario():
            with tempfile.TemporaryDirectory() as tmp:
                output = Path(tmp)
                db = NodeDB(output / "pentest-node.sqlite3")
                await db.init()
                await db.create_session(
                    session_id="s1",
                    task_id="t1",
                    target={"type": "url", "value": "http://192.0.2.1/"},
                    scope={"allow": ["http://192.0.2.1/"], "deny": []},
                    instruction="test target",
                    output_dir=str(output),
                    status="completed",
                )
                await db.save_event("s1", {"type": "text", "content": {"text": "done"}})
                await db.save_event("s1", {"type": "asset_discovered", "address": "http://192.0.2.1/", "asset_type": "web"})
                await db.save_event("s1", {"type": "evidence_created", "evidence_id": "ev-tui-export", "evidence_type": "http_trace", "source_tool": "http_request", "summary": "HTTP trace"})
                await db.save_event("s1", {"type": "vuln_found", "finding_id": "finding-tui-export", "title": "TUI Export Finding", "severity": "medium", "status": "confirmed", "affected_asset": "http://192.0.2.1/", "evidence_ids": ["ev-tui-export"]})
                await db.save_event("s1", {"type": "attack_surface_discovered", "surface": {"surface_id": "surface-tui", "kind": "url"}})
                await db.save_event("s1", {"type": "coverage_marked", "coverage": {"coverage_id": "coverage-tui", "endpoint": "GET http://192.0.2.1/", "status": "passed"}})
                await db.save_event("s1", {"type": "checkpoint_update", "checkpoint": {"phase": "complete"}})
                await db.close()

                app = PentestTUI(StandaloneOptions(output=output, session_id="s1", check_connectivity=False))
                async with app.run_test(size=(120, 30)) as pilot:
                    await pilot.pause(0.1)
                    await app._export_current_session("/export")
                    await pilot.pause(0.1)
                tar_path = output / "report-s1.tar.gz"
                package = load_report_package(tar_path.read_bytes())
                return tar_path.exists(), package

        exists, package = asyncio.run(scenario())

        self.assertTrue(exists)
        self.assertEqual(package.manifest["session_id"], "s1")
        self.assertEqual(len(package.messages), 1)
        self.assertEqual(len(package.assets), 1)
        self.assertEqual(len(package.vulnerabilities), 1)
    def test_tui_resume_without_id_lists_recent_sessions_and_accepts_number(self):
        async def scenario():
            with tempfile.TemporaryDirectory() as tmp:
                output = Path(tmp)
                db = NodeDB(output / "pentest-node.sqlite3")
                await db.init()
                await db.create_session(
                    session_id="older-session",
                    task_id="t-old",
                    target={"type": "url", "value": "http://192.0.2.1/old"},
                    scope={"allow": ["http://192.0.2.1"], "deny": []},
                    instruction="old",
                    output_dir=str(output),
                    status="completed",
                )
                await db.create_session(
                    session_id="newer-session",
                    task_id="t-new",
                    target={"type": "url", "value": "http://192.0.2.1/new"},
                    scope={"allow": ["http://192.0.2.1"], "deny": []},
                    instruction="new",
                    output_dir=str(output),
                    status="completed",
                )
                listed = await db.list_sessions(limit=2)
                await db.close()

                app = PentestTUI(StandaloneOptions(output=output, check_connectivity=False))
                started = []
                app._start_run = lambda options: started.append(options)  # type: ignore[method-assign]
                async with app.run_test(size=(120, 30)) as pilot:
                    await pilot.pause(0.1)
                    await app._submit_command_text("/resume")
                    await app._submit_command_text("/resume 1")
                return listed, app.recent_sessions, started

        listed, recent, started = asyncio.run(scenario())

        self.assertEqual(listed[0]["id"], "newer-session")
        self.assertEqual(recent[0]["id"], "newer-session")
        self.assertEqual(started[0].resume, "newer-session")

    def test_tui_slash_panel_selects_resume_session(self):
        async def scenario():
            with tempfile.TemporaryDirectory() as tmp:
                output = Path(tmp)
                db = NodeDB(output / "pentest-node.sqlite3")
                await db.init()
                await db.create_session(
                    session_id="session-from-panel",
                    task_id="t-panel",
                    target={"type": "url", "value": "http://192.0.2.1/panel"},
                    scope={"allow": ["http://192.0.2.1"], "deny": []},
                    instruction="panel",
                    output_dir=str(output),
                    status="completed",
                )
                await db.close()

                app = PentestTUI(StandaloneOptions(output=output, check_connectivity=False))
                started = []
                app._start_run = lambda options: started.append(options)  # type: ignore[method-assign]
                async with app.run_test(size=(120, 30)) as pilot:
                    await pilot.pause(0.1)
                    await app._refresh_command_panel_for_input("/")
                    command_labels = [item["label"] for item in app.command_panel_items]
                    await app._accept_command_panel_selection()
                    resume_labels = [item["label"] for item in app.command_panel_items]
                    await app._accept_command_panel_selection()
                    await pilot.pause(0.1)
                return command_labels, resume_labels, started, app.command_panel_visible

        command_labels, resume_labels, started, visible = asyncio.run(scenario())

        self.assertIn("/resume", command_labels)
        self.assertEqual(resume_labels[0], "session-from-panel")
        self.assertEqual(started[0].resume, "session-from-panel")
        self.assertFalse(visible)


    def test_tui_slash_panel_tab_completes_without_executing(self):
        async def scenario():
            with tempfile.TemporaryDirectory() as tmp:
                output = Path(tmp)
                db = NodeDB(output / "pentest-node.sqlite3")
                await db.init()
                await db.create_session(
                    session_id="session-tab-complete",
                    task_id="t-tab",
                    target={"type": "url", "value": "http://192.0.2.1/tab"},
                    scope={"allow": ["http://192.0.2.1"], "deny": []},
                    instruction="tab",
                    output_dir=str(output),
                    status="completed",
                )
                await db.close()

                app = PentestTUI(StandaloneOptions(output=output, check_connectivity=False))
                started = []
                app._start_run = lambda options: started.append(options)  # type: ignore[method-assign]
                async with app.run_test(size=(120, 30)) as pilot:
                    await pilot.pause(0.1)
                    command_input = app.query_one("#command-input")
                    await app._refresh_command_panel_for_input("/")
                    await app._complete_command_panel_selection()
                    first_fill = command_input.text
                    first_cursor = command_input.cursor_location
                    await app._complete_command_panel_selection()
                    second_fill = command_input.text
                    second_cursor = command_input.cursor_location
                    visible = app.command_panel_visible
                return first_fill, first_cursor, second_fill, second_cursor, visible, started

        first_fill, first_cursor, second_fill, second_cursor, visible, started = asyncio.run(scenario())

        self.assertEqual(first_fill, "/resume ")
        self.assertEqual(first_cursor, (0, len(first_fill)))
        self.assertEqual(second_fill, "/resume session-tab-complete")
        self.assertEqual(second_cursor, (0, len(second_fill)))
        self.assertFalse(visible)
        self.assertEqual(started, [])

    def test_tui_followup_without_url_uses_current_target_context(self):
        app = PentestTUI(StandaloneOptions(output=Path("."), target="http://target.local/login.php", scope=["http://target.local"], check_connectivity=False))
        app.session_id = "session-current"

        options, error = app._options_from_command("continue testing low medium high levels")

        self.assertIsNone(error)
        self.assertEqual(options.resume, "session-current")
        self.assertEqual(options.target, "")
        self.assertIsNone(options.scope)
        self.assertIn("low medium high", options.instruction)

    def test_tui_remembers_target_context_from_resume_checkpoint(self):
        app = PentestTUI(StandaloneOptions(output=Path("."), check_connectivity=False))
        app.session_id = "session-1"
        app.target = "resume:session-1"
        app._remember_target_context({"checkpoint": {"resolved_target": "http://target.local/", "scope": {"allow": ["http://target.local"], "deny": []}}})

        options, error = app._options_from_command("continue testing medium level")

        self.assertIsNone(error)
        self.assertEqual(options.resume, "session-1")
        self.assertEqual(options.target, "")
        self.assertIsNone(options.scope)

    def test_tui_current_session_followup_preserves_findings_panel(self):
        async def scenario():
            app = PentestTUI(StandaloneOptions(output=Path("."), check_connectivity=False))
            started = []

            def fake_start(options, *, preserve_context=False):
                started.append((options, preserve_context))

            async with app.run_test(size=(120, 30)) as pilot:
                await pilot.pause(0.1)
                app.session_id = "session-current"
                app.target = "http://target.local/login.php"
                app.scope = ["http://target.local"]
                app.findings = 1
                app.assets = 2
                app.evidence = 3
                app.finding_lines = ["medium | Reflected XSS | GET /vulnerabilities/xss_r/"]
                app.plan_tree = [{"node_id": "plan-1", "title": "Existing test", "status": "done"}]
                app._start_run = fake_start  # type: ignore[method-assign]
                await app._submit_command_text("continue testing low medium high levels")
                return app.findings, app.assets, app.evidence, list(app.finding_lines), list(app.plan_tree), started

        findings, assets, evidence, finding_lines, plan_tree, started = asyncio.run(scenario())

        self.assertEqual(findings, 1)
        self.assertEqual(assets, 2)
        self.assertEqual(evidence, 3)
        self.assertEqual(finding_lines, ["medium | Reflected XSS | GET /vulnerabilities/xss_r/"])
        self.assertEqual(plan_tree[0]["node_id"], "plan-1")
        self.assertEqual(started[0][0].resume, "session-current")
        self.assertTrue(started[0][1])

    def test_tui_groups_consecutive_same_tool_cards(self):
        async def scenario():
            app = PentestTUI(StandaloneOptions(output=Path("."), check_connectivity=False))
            async with app.run_test(size=(120, 30)) as pilot:
                await pilot.pause(0.1)
                app.transcript = []
                app.tool_entries.clear()
                app._write_tool_card("http_request", "done", "GET /login 200", "run-1")
                app._write_tool_card("http_request", "done", "GET /admin 404", "run-2")
                app._write_tool_card("browser", "done", "opened /login", "run-3")
                app._write_tool_card("http_request", "done", "GET /setup 200", "run-4")
                await pilot.pause(0.1)
                return app.transcript, app.tool_entries

        transcript, tool_entries = asyncio.run(scenario())

        self.assertEqual([entry["name"] for entry in transcript if entry.get("type") == "tool"], ["http_request", "browser", "http_request"])
        first_http = transcript[0]
        self.assertEqual(first_http["run_count"], 2)
        self.assertIn("GET /login 200", first_http["line"])
        self.assertIn("GET /admin 404", first_http["line"])
        self.assertIs(tool_entries["run-1"], first_http)
        self.assertIs(tool_entries["run-2"], first_http)
        self.assertIsNot(tool_entries["run-4"], first_http)
    def test_tui_agent_log_allows_mouse_text_selection(self):
        async def scenario():
            app = PentestTUI(StandaloneOptions(output=Path("."), check_connectivity=False))
            async with app.run_test(size=(120, 30)) as pilot:
                await pilot.pause(0.1)
                agent_log = app.query_one("#agent-log")
                plan_tree_log = app.query_one("#plan-tree-log")
                findings_log = app.query_one("#findings-log")
                return (
                    agent_log.allow_select,
                    agent_log.can_focus,
                    plan_tree_log.allow_select,
                    plan_tree_log.can_focus,
                    findings_log.allow_select,
                    findings_log.can_focus,
                )

        agent_select, agent_focus, plan_select, plan_focus, findings_select, findings_focus = asyncio.run(scenario())

        self.assertTrue(agent_select)
        self.assertFalse(agent_focus)
        self.assertTrue(plan_select)
        self.assertFalse(plan_focus)
        self.assertTrue(findings_select)
        self.assertFalse(findings_focus)


    def test_tui_results_panel_splits_plan_tree_and_findings(self):
        async def scenario():
            app = PentestTUI(StandaloneOptions(output=Path("."), check_connectivity=False))
            async with app.run_test(size=(120, 30)) as pilot:
                await pilot.pause(0.1)
                app.plan_tree = [
                    {"node_id": "plan-phase-recon", "title": "Recon phase", "status": "done", "kind": "phase", "level": "phase", "priority": 100},
                    {"node_id": "plan-objective-recon-login", "title": "Hidden objective", "status": "running", "kind": "objective", "level": "objective", "parent_id": "plan-phase-recon"},
                    {"node_id": "plan-1", "title": "Test login SQLi", "status": "running", "endpoint": "POST http://target.local/login", "parameter": "username", "vuln_type": "sqli", "parent_id": "plan-objective-recon-login"},
                    {"node_id": "plan-phase-verify", "title": "Verify phase", "status": "running", "kind": "phase", "level": "phase", "priority": 300},
                ]
                app.finding_lines = ["medium | Reflected XSS | GET /vulnerabilities/xss_r/"]
                app._refresh_results_panel()
                plan_tree_log = app.query_one("#plan-tree-log")
                findings_log = app.query_one("#findings-log")
                plan_text = "\n".join(strip.text for strip in plan_tree_log.lines)
                findings_text = "\n".join(strip.text for strip in findings_log.lines)
                return plan_text, findings_text

        plan_text, findings_text = asyncio.run(scenario())

        self.assertIn("Recon phase", plan_text)
        self.assertIn("Verify phase", plan_text)
        self.assertNotIn("Hidden objective", plan_text)
        self.assertNotIn("Test login SQLi", plan_text)
        self.assertNotIn("POST http://target.local/login", plan_text)
        self.assertNotIn("Reflected XSS", plan_text)
        self.assertIn("Reflected XSS", findings_text)

    def test_tui_ctrl_c_is_not_intercepted_by_app(self):
        async def scenario():
            app = PentestTUI(StandaloneOptions(output=Path("."), check_connectivity=False))
            stopped = []
            aborted = []

            class Event:
                key = "ctrl+c"

                def stop(self):
                    stopped.append("stopped")

            async with app.run_test(size=(120, 30)) as pilot:
                await pilot.pause(0.1)
                app._abort_active_run = lambda message: aborted.append(message)  # type: ignore[method-assign]
                app.on_key(Event())
            return stopped, aborted

        stopped, aborted = asyncio.run(scenario())

        self.assertEqual(stopped, [])
        self.assertEqual(aborted, [])


    def test_tui_agent_log_selection_extracts_chat_text(self):
        async def scenario():
            app = PentestTUI(StandaloneOptions(output=Path("."), check_connectivity=False))
            async with app.run_test(size=(120, 30)) as pilot:
                await pilot.pause(0.1)
                app.transcript = [{"type": "agent", "text": "hello selectable"}]
                app._render_transcript()
                await pilot.pause(0.1)
                agent_log = app.query_one("#agent-log")
                return agent_log.get_selection(Selection(Offset(0, 0), Offset(5, 0)))

        selected = asyncio.run(scenario())

        self.assertIsNotNone(selected)
        self.assertEqual(selected[0], "hello")


    def test_tui_agent_log_mouse_drag_selects_chat_text(self):
        async def scenario():
            app = PentestTUI(StandaloneOptions(output=Path("."), check_connectivity=False))
            async with app.run_test(size=(120, 30)) as pilot:
                await pilot.pause(0.1)
                app.transcript = [{"type": "agent", "text": "hello selectable"}]
                app._render_transcript()
                await pilot.pause(0.1)
                await pilot.mouse_down("#agent-log", offset=(2, 1))
                await pilot.hover("#agent-log", offset=(8, 1))
                await pilot.mouse_up("#agent-log", offset=(8, 1))
                await pilot.pause(0.1)
                return app.screen.get_selected_text()

        selected = asyncio.run(scenario())

        self.assertIsNotNone(selected)
        self.assertIn("hello", selected)


    def test_tui_agent_log_selection_is_visibly_highlighted(self):
        async def scenario():
            app = PentestTUI(StandaloneOptions(output=Path("."), check_connectivity=False))
            async with app.run_test(size=(120, 30)) as pilot:
                await pilot.pause(0.1)
                app.transcript = [{"type": "agent", "text": "hello selectable"}]
                app._render_transcript()
                await pilot.pause(0.1)
                agent_log = app.query_one("#agent-log")
                app.screen.selections = {agent_log: Selection(Offset(0, 0), Offset(5, 0))}
                line = agent_log.render_line(0)
                return [segment.style.bgcolor.triplet.hex for segment in line if segment.style and segment.style.bgcolor]

        colors = asyncio.run(scenario())

        self.assertIn("#ffffff", colors)


    def test_tui_agent_markdown_urls_are_not_hyperlinks(self):
        async def scenario():
            app = PentestTUI(StandaloneOptions(output=Path("."), check_connectivity=False))
            async with app.run_test(size=(120, 30)) as pilot:
                await pilot.pause(0.1)
                app.transcript = [{"type": "agent", "text": "See http://example.test/path"}]
                app._render_transcript()
                await pilot.pause(0.1)
                agent_log = app.query_one("#agent-log")
                styles = []
                for line in agent_log.lines:
                    for segment in line:
                        if "example.test" in segment.text:
                            styles.append(segment.style)
                return styles

        styles = asyncio.run(scenario())

        self.assertTrue(styles)
        self.assertTrue(all(not (style and style.link) for style in styles))


class FakeUpload:
    def __init__(self, raw: bytes):
        self.raw = raw

    async def read(self) -> bytes:
        return self.raw


class FakeResult:
    def scalar_one_or_none(self):
        return None


class FakeDB:
    def __init__(self):
        self.objects = []
        self.committed = False

    def add(self, obj):
        self.objects.append(obj)

    async def flush(self):
        return None

    async def execute(self, _statement):
        return FakeResult()

    async def commit(self):
        self.committed = True


def _make_report_package_bytes(assets: list[dict] | None = None, vulnerabilities: list[dict] | None = None) -> bytes:
    if assets is None:
        assets = [{"id": "asset-1", "address": "http://192.0.2.1/", "asset_type": "web"}]
    if vulnerabilities is None:
        vulnerabilities = [{"title": "Reflected XSS", "severity": "medium", "status": "confirmed", "affected_asset": "http://192.0.2.1/", "evidence_ids": ["ev-1"]}]
    payloads = {
        "manifest.json": {"format_version": "mvp-demo-v1", "session_id": "s1", "target": {"value": "http://192.0.2.1/"}, "scope": {"allow": ["http://192.0.2.1/"]}, "status": "completed"},
        "assets.json": assets,
        "vulnerabilities.json": vulnerabilities,
        "evidence.json": [{"evidence_id": "ev-1", "evidence_type": "http_trace", "source_tool": "http_request", "summary": "HTTP trace"}],
        "attack_surface.json": [{"surface_id": "surface-1"}],
        "coverage.json": [{"coverage_id": "cov-1"}],
        "checkpoints/latest.json": {"phase": "complete"},
    }
    out = io.BytesIO()
    with tarfile.open(fileobj=out, mode="w:gz") as tar:
        for name, payload in payloads.items():
            raw = json.dumps(payload).encode("utf-8")
            info = tarfile.TarInfo(name)
            info.size = len(raw)
            tar.addfile(info, io.BytesIO(raw))
        row = {"id": "msg-1", "session_id": "s1", "role": "agent", "msg_type": "text", "content": {"text": "done"}}
        raw = (json.dumps(row) + "\n").encode("utf-8")
        info = tarfile.TarInfo("conversation.jsonl")
        info.size = len(raw)
        tar.addfile(info, io.BytesIO(raw))
    return out.getvalue()


if __name__ == "__main__":
    unittest.main()
