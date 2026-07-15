#!/usr/bin/env python3
"""Structural + pure-function verification for multi-expert plan Phases 1–4."""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRATCH = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("/tmp/grok-goal-verify")
SCRATCH.mkdir(parents=True, exist_ok=True)
log_lines: list[str] = []


def log(msg: str) -> None:
    print(msg)
    log_lines.append(msg)


def assert_true(cond: bool, msg: str) -> None:
    if not cond:
        raise AssertionError(msg)
    log(f"OK {msg}")


def main() -> None:
    # --- Phase 2 skills ---
    pack = json.loads((ROOT / "experts/pentest/pack.json").read_text())
    required = [
        "pentest-surface-enum",
        "pentest-external-intel",
        "pentest-authz-logic",
        "pentest-component-rce",
        "pentest-service-exposure",
        "pentest-postex-host",
        "pentest-lateral",
    ]
    for sid in required:
        assert_true(sid in pack["skillIds"], f"pack lists {sid}")
        skill = ROOT / "experts/pentest/skills" / sid / "SKILL.md"
        assert_true(skill.is_file(), f"skill file {sid}")
        body = skill.read_text()
        assert_true(len(body) > 80, f"skill body non-empty {sid}")
        assert_true("CVE-20" not in body and "answer key" not in body.lower(), f"no CVE answer keys {sid}")
    (SCRATCH / "pentest-skills.log").write_text("\n".join(log_lines) + "\n", encoding="utf-8")

    # --- Phase 4 packs ---
    catalog = json.loads((ROOT / "experts/catalog.json").read_text())
    pack_ids = {p["id"] for p in catalog["packs"]}
    for pid in ("llm-security", "code-audit", "alert-triage"):
        assert_true(pid in pack_ids, f"catalog has {pid}")
        pdir = ROOT / "experts" / pid
        assert_true((pdir / "pack.json").is_file(), f"{pid}/pack.json")
        assert_true((pdir / "mission.md").is_file(), f"{pid}/mission.md")
        assert_true((pdir / "work.md").is_file(), f"{pid}/work.md")
        manifest = json.loads((pdir / "pack.json").read_text())
        for sid in manifest.get("skillIds") or []:
            assert_true((pdir / "skills" / sid / "SKILL.md").is_file(), f"{pid} skill {sid}")
    (SCRATCH / "new-packs-install.log").write_text(
        "catalog+filesystem packs verified (install via expert-cli when node online)\n"
        + "\n".join(log_lines[-20:])
        + "\n",
        encoding="utf-8",
    )

    # --- Phase 1 Python RoE ---
    sys.path.insert(0, str(ROOT / "platform/backend"))
    from app.services.case_engagement import resolve_allow_postex, normalize_engagement_template

    assert_true(normalize_engagement_template("app_assessment") == "app_assessment", "tmpl app")
    assert_true(resolve_allow_postex(engagement_template="app_assessment") is False, "roe assess")
    assert_true(resolve_allow_postex(engagement_template="redteam_deep") is True, "roe deep")
    assert_true(normalize_engagement_template("hack the dvwa box please") is None, "no NLP invent")
    (SCRATCH / "engagement-roe.log").write_text(
        "case_engagement pure mapping ok\napp_assessment postex=false\nredteam_deep postex=true\nno free-text invent\n",
        encoding="utf-8",
    )

    # --- Phase 3 structural: APIs exist ---
    conv_api = (ROOT / "platform/backend/app/api/conversations.py").read_text()
    assert_true("/case" in conv_api and "handoff" in conv_api, "case+handoff API routes")
    case_svc = (ROOT / "platform/backend/app/services/case_engagement.py").read_text()
    assert_true("merge_case_into_context" in case_svc, "case merge helper")
    fe = (ROOT / "platform/frontend/src/pages/ConversationPage.tsx").read_text()
    assert_true("engagementTemplate" in fe and "ENGAGEMENT_TEMPLATES" in fe, "UI engagement selector")
    assert_true("caseHandoff" in fe and "一键选用" in fe, "UI handoff one-click")
    (SCRATCH / "case-fields.log").write_text("case API + UI contracts present\n", encoding="utf-8")
    (SCRATCH / "handoff.log").write_text("handoff POST + UI confirm present\n", encoding="utf-8")

    # Node4 pure test
    node = ROOT / "node4"
    r = subprocess.run(
        ["node", "--import", "tsx", "src/runtime/engagement-roe.test.ts"],
        cwd=node,
        capture_output=True,
        text=True,
        env={**dict(**{k: v for k, v in __import__("os").environ.items()}), "PATH": f"/tmp/node-v22.14.0-linux-x64/bin:{__import__('os').environ.get('PATH','')}"},
    )
    (SCRATCH / "node4-roe-test.log").write_text(r.stdout + "\n" + r.stderr, encoding="utf-8")
    assert_true(r.returncode == 0, f"node4 engagement-roe tests (exit {r.returncode})")

    # expert-cli list if possible
    r2 = subprocess.run(
        ["node", "--import", "tsx", "src/expert-cli.ts", "list"],
        cwd=node,
        capture_output=True,
        text=True,
        env={**dict(**{k: v for k, v in __import__("os").environ.items()}), "PATH": f"/tmp/node-v22.14.0-linux-x64/bin:{__import__('os').environ.get('PATH','')}"},
    )
    (SCRATCH / "expert-cli-list.log").write_text(r2.stdout + "\n" + r2.stderr, encoding="utf-8")
    # list may work without install
    log(f"expert-cli list exit={r2.returncode}")

    summary = SCRATCH / "phases-1-4-summary.log"
    summary.write_text("\n".join(log_lines) + "\nALL PASS\n", encoding="utf-8")
    log("ALL PASS")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"FAIL: {e}")
        (SCRATCH / "phases-1-4-summary.log").write_text("\n".join(log_lines) + f"\nFAIL: {e}\n", encoding="utf-8")
        sys.exit(1)
