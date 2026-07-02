"""Smoke check for MVP Demo Phase 4 standalone export/import.

Default mode is offline and deterministic: build a local Node SQLite session,
export report.tar.gz, parse it with the platform importer, and compare counts.
Pass --platform-url and --token to also upload the package to a running platform.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "node"))
sys.path.insert(0, str(ROOT / "platform" / "backend"))

from app.api.sync import load_report_package  # noqa: E402
from pentest_node.db import NodeDB  # noqa: E402
from pentest_node.export import export_session, sync_to_platform  # noqa: E402


async def build_sample_session(workspace: Path, session_id: str) -> None:
    db = NodeDB(workspace / "pentest-node.sqlite3")
    await db.init()
    await db.create_session(
        session_id=session_id,
        task_id="phase4-smoke-task",
        target={"type": "url", "value": "http://192.0.2.1/"},
        scope={"allow": ["http://192.0.2.1/"], "deny": []},
        instruction="Phase 4 export/import smoke",
        output_dir=str(workspace),
        status="completed",
    )
    await db.save_event(session_id, {"type": "text", "content": {"text": "Phase 4 smoke started"}})
    await db.save_event(session_id, {"type": "asset_discovered", "address": "http://192.0.2.1/", "asset_type": "web"})
    await db.save_event(session_id, {"type": "evidence_created", "evidence_id": "ev-phase4-smoke", "evidence_type": "http_trace", "source_tool": "http_request", "tool_run_id": "tool-phase4", "raw_ref": "evidence/ev-phase4-smoke", "summary": "HTTP trace"})
    await db.save_event(session_id, {"type": "vuln_found", "finding_id": "finding-phase4", "title": "Phase 4 Smoke Finding", "vuln_type": "xss", "severity": "medium", "status": "confirmed", "affected_asset": "http://192.0.2.1/", "evidence_ids": ["ev-phase4-smoke"]})
    await db.save_event(session_id, {"type": "attack_surface_discovered", "surface": {"surface_id": "surface-phase4", "kind": "url", "url": "http://192.0.2.1/"}})
    await db.save_event(session_id, {"type": "coverage_marked", "coverage": {"coverage_id": "coverage-phase4", "endpoint": "GET http://192.0.2.1/", "vuln_type": "xss", "status": "passed", "evidence_ids": ["ev-phase4-smoke"]}})
    await db.save_event(session_id, {"type": "checkpoint_update", "checkpoint": {"phase": "complete", "iteration": 1, "state": {"phase": "complete", "iteration": 1}}})
    evidence_file = workspace / f"session-{session_id}" / "evidence" / "ev-phase4-smoke" / "response.txt"
    evidence_file.parent.mkdir(parents=True, exist_ok=True)
    evidence_file.write_text("HTTP/1.1 200 OK", encoding="utf-8")
    await db.close()


async def run(args: argparse.Namespace) -> dict:
    session_id = args.session_id
    if args.workspace:
        workspace = Path(args.workspace).resolve()
        workspace.mkdir(parents=True, exist_ok=True)
        cleanup = None
    else:
        cleanup = tempfile.TemporaryDirectory()
        workspace = Path(cleanup.name)
    try:
        await build_sample_session(workspace, session_id)
        tar_path = await export_session(workspace, session_id, Path(args.output) if args.output else workspace / "report.tar.gz")
        package = load_report_package(tar_path.read_bytes())
        counts = {
            "messages": len(package.messages),
            "assets": len(package.assets),
            "vulnerabilities": len(package.vulnerabilities),
            "evidence": len(package.evidence),
            "attack_surface": len(package.attack_surface),
            "coverage": len(package.coverage),
        }
        expected = {key: 1 for key in counts}
        if counts != expected:
            raise SystemExit(f"count mismatch: expected={expected} actual={counts}")
        result = {"ok": True, "tar_path": str(tar_path), "session_id": session_id, "counts": counts}
        if args.platform_url and args.token:
            result["platform_import"] = await sync_to_platform(tar_path, args.platform_url, args.token)
        return result
    finally:
        if cleanup:
            cleanup.cleanup()


def main() -> None:
    parser = argparse.ArgumentParser(description="Smoke check standalone export/import")
    parser.add_argument("--session-id", default="phase4-smoke")
    parser.add_argument("--workspace", default=None)
    parser.add_argument("--output", default=None)
    parser.add_argument("--platform-url", default=None)
    parser.add_argument("--token", default=None)
    args = parser.parse_args()
    print(json.dumps(asyncio.run(run(args)), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
