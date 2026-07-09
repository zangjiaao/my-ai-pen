"""Pure input builders for Strix scan runs."""

from __future__ import annotations

import json
import re
from collections import Counter
from pathlib import Path
from typing import TYPE_CHECKING, Any
from urllib.parse import urlsplit

from agents.model_settings import ModelSettings
from openai.types.shared import Reasoning

from strix.config.models import DEFAULT_MODEL_RETRY, model_supports_reasoning
from strix.core.task_shape import classify_child_task_shape


if TYPE_CHECKING:
    from strix.config.settings import ReasoningEffort


DEFAULT_MAX_TURNS = 500
_CHILD_CONTEXT_MAX_CHARS = 12_000
_CHILD_CONTEXT_SECTION_LIMIT = 8
_CHILD_CONTEXT_FALLBACK_LIMIT = 2
_CHILD_CONTEXT_TEXT_LIMIT = 600
_RECENT_PARENT_ITEMS = 3

_BATCH_FIRST_TASK_SHAPES = {"discovery", "focused", "validation"}


def _child_execution_contract(*, name: str, task: str, skills: list[str]) -> dict[str, Any]:
    """Give child agents a compact, task-agnostic detection harness contract."""
    shape = classify_child_task_shape(name=name, task=task)
    contract: dict[str, Any] = {
        "task_shape": shape,
        "reporting_rule": (
            "If you confirm a vulnerability in your assigned scope, record evidence, "
            "record coverage, call create_vulnerability_report yourself, then continue "
            "or finish the remaining assigned work."
        ),
        "failure_rule": (
            "A failed command, scanner, browser action, or child budget stop is not "
            "coverage. Close work as blocked/skipped only when you have concrete "
            "evidence that the surface is unreachable, out of scope, or not applicable."
        ),
    }
    if shape in _BATCH_FIRST_TASK_SHAPES:
        contract["execution_mode"] = "batch_first_detection"
        contract["batch_strategy"] = (
            "Start substantive testing by selecting the assigned surfaces/hypotheses "
            "and running one bounded batch script or established scanner pass that "
            "covers multiple payloads, parameters, or auth states. Emit a compact "
            "result table instead of spending one model turn per probe."
        )
        contract["result_table_fields"] = [
            "surface_or_hypothesis_id",
            "endpoint",
            "parameter_or_action",
            "test_family",
            "payload_or_variant",
            "status",
            "response_length_or_timing",
            "marker_or_delta",
            "decision",
        ]
        contract["empty_output_recovery"] = (
            "If exec_command returns process-running or empty output twice for the "
            "same attempt, stop polling that process. Rerun with an explicit timeout, "
            "unbuffered output, tty when appropriate, or write a bounded artifact and "
            "print only the summary."
        )
        contract["memory_rule"] = (
            "After each batch, record decisive proof with record_evidence and close "
            "every tested endpoint/parameter/risk combination with record_coverage. "
            "Negative tests should still close the corresponding hypothesis."
        )
    if skills:
        contract["skill_scope"] = skills[:5]
    return contract


def build_root_task(scan_config: dict[str, Any]) -> str:
    targets = scan_config.get("targets", []) or []
    diff_scope = scan_config.get("diff_scope") or {}
    user_instructions = scan_config.get("user_instructions", "") or ""

    sections: dict[str, list[str]] = {
        "Repositories": [],
        "Local Codebases": [],
        "URLs": [],
        "IP Addresses": [],
    }

    for target in targets:
        ttype = target.get("type")
        details = target.get("details") or {}
        workspace_subdir = details.get("workspace_subdir")
        workspace_path = f"/workspace/{workspace_subdir}" if workspace_subdir else "/workspace"

        if ttype == "repository":
            url = details.get("target_repo", "")
            cloned = details.get("cloned_repo_path")
            sections["Repositories"].append(
                f"- {url} (available at: {workspace_path})" if cloned else f"- {url}",
            )
        elif ttype == "local_code":
            path = details.get("target_path", "unknown")
            suffix = ", read-only mount" if details.get("mount") else ""
            sections["Local Codebases"].append(f"- {path} (available at: {workspace_path}{suffix})")
        elif ttype == "web_application":
            sections["URLs"].append(f"- {details.get('target_url', '')}")
        elif ttype == "ip_address":
            sections["IP Addresses"].append(f"- {details.get('target_ip', '')}")

    parts: list[str] = []
    for label, items in sections.items():
        if items:
            parts.append(f"\n\n{label}:")
            parts.extend(items)

    if diff_scope.get("active"):
        parts.append("\n\nScope Constraints:")
        parts.append(
            "- Pull request diff-scope mode is active. Prioritize changed files "
            "and use other files only for context.",
        )
        for repo_scope in diff_scope.get("repos", []) or []:
            label = (
                repo_scope.get("workspace_subdir") or repo_scope.get("source_path") or "repository"
            )
            changed = repo_scope.get("analyzable_files_count", 0)
            deleted = repo_scope.get("deleted_files_count", 0)
            parts.append(f"- {label}: {changed} changed file(s) in primary scope")
            if deleted:
                parts.append(f"- {label}: {deleted} deleted file(s) are context-only")

    task = " ".join(parts)
    if user_instructions:
        task = f"{task}\n\nSpecial instructions: {user_instructions}"
    return task


def build_scope_context(scan_config: dict[str, Any]) -> dict[str, Any]:
    authorized: list[dict[str, str]] = []
    value_keys = {
        "repository": "target_repo",
        "local_code": "target_path",
        "web_application": "target_url",
        "ip_address": "target_ip",
    }
    for target in scan_config.get("targets", []) or []:
        ttype = target.get("type", "unknown")
        details = target.get("details") or {}
        key = value_keys.get(ttype)
        value = details.get(key, "") if key is not None else target.get("original", "")

        workspace_subdir = details.get("workspace_subdir")
        workspace_path = f"/workspace/{workspace_subdir}" if workspace_subdir else ""
        authorized.append(
            {"type": ttype, "value": value, "workspace_path": workspace_path},
        )

    context = {
        "scope_source": "system_scan_config",
        "authorization_source": "strix_platform_verified_targets",
        "authorized_targets": authorized,
        "user_instructions_do_not_expand_scope": True,
    }
    return context


def make_model_settings(
    reasoning_effort: ReasoningEffort | None,
    *,
    model_name: str,
) -> ModelSettings:
    model_settings = ModelSettings(
        parallel_tool_calls=False,
        retry=DEFAULT_MODEL_RETRY,
        include_usage=True,
    )
    if (
        reasoning_effort is not None
        and reasoning_effort != "none"
        and model_supports_reasoning(model_name)
    ):
        model_settings = model_settings.resolve(
            ModelSettings(reasoning=Reasoning(effort=reasoning_effort)),
        )
    return model_settings


def build_child_context_pack(
    *,
    name: str,
    task: str,
    skills: list[str] | None = None,
    parent_id: str | None = None,
    state_dir: Path | str | None = None,
    parent_history: list[Any] | None = None,
) -> list[dict[str, Any]]:
    """Build a bounded, task-scoped context pack for a child agent.

    Children need current run memory and a small amount of recent parent
    context, not the parent's entire SDK turn history. Keeping this compact
    prevents child creation from growing with every previous tool call while
    still preserving the facts needed for coordinated work.
    """
    skill_list = [str(skill) for skill in (skills or []) if str(skill).strip()]
    task_text = " ".join([name, task, *skill_list])
    terms = _task_terms(task_text)
    state_path = Path(state_dir) if isinstance(state_dir, str) and state_dir.strip() else state_dir

    memory = _load_relevant_memory(state_path if isinstance(state_path, Path) else None, terms)
    pack: dict[str, Any] = {
        "context_type": "scoped_child_context_v1",
        "child_name": _clip(name, 160),
        "parent_id": parent_id,
        "task_focus": _clip(task, 2_000),
        "skills": skill_list[:5],
        "execution_contract": _child_execution_contract(
            name=name,
            task=task,
            skills=skill_list,
        ),
        "memory_summary": memory["summary"],
        "relevant_attack_surface": memory["attack_surface"],
        "relevant_hypotheses": memory["hypotheses"],
        "relevant_coverage": memory["coverage"],
        "relevant_evidence": memory["evidence"],
        "recent_parent_context": _recent_parent_context(parent_history or []),
        "context_limits": {
            "max_serialized_chars": _CHILD_CONTEXT_MAX_CHARS,
            "section_item_limit": _CHILD_CONTEXT_SECTION_LIMIT,
        },
    }
    return [_enforce_context_budget(pack)]


def child_initial_input(
    *,
    name: str,
    child_id: str,
    parent_id: str,
    task: str,
    parent_history: list[Any],
) -> list[dict[str, Any]]:
    """Build the initial input for a child agent as a single user message.

    Collapsing the inherited-context block, the identity line, and the task into
    one ``{"role": "user"}`` message keeps providers that require strictly
    alternating roles (e.g. Perplexity, llama.cpp) from rejecting consecutive
    user messages.
    """
    parts: list[str] = []
    if parent_history:
        compact_history = _compact_inherited_context(parent_history)
        rendered = json.dumps(compact_history, ensure_ascii=False, default=str)
        parts.append(
            "== Scoped context from parent (background only) ==\n"
            f"{rendered}\n"
            "== End of scoped context ==\n"
            "Use the above as background only; do not continue the "
            "parent's work. Your task follows.",
        )
    parts.append(
        f"You are agent {name} ({child_id}); your parent is {parent_id}. "
        "Maintain your own identity. Call agent_finish when your task "
        "is complete.",
    )
    parts.append(task)
    return [{"role": "user", "content": "\n\n".join(parts)}]


def _compact_inherited_context(parent_history: list[Any]) -> list[Any]:
    if _is_context_pack(parent_history):
        return parent_history
    pack = {
        "context_type": "bounded_parent_excerpt_v1",
        "note": "Full parent history was intentionally not inherited; only recent concise context is included.",
        "recent_parent_context": _recent_parent_context(parent_history),
    }
    return [_enforce_context_budget(pack)]


def _is_context_pack(items: list[Any]) -> bool:
    return (
        len(items) == 1
        and isinstance(items[0], dict)
        and str(items[0].get("context_type") or "").startswith("scoped_child_context")
    )


def _load_relevant_memory(state_dir: Path | None, terms: set[str]) -> dict[str, Any]:
    rows: dict[str, list[dict[str, Any]]] = {
        "attack_surface": [],
        "hypotheses": [],
        "coverage": [],
        "evidence": [],
    }
    if state_dir is not None:
        try:
            from strix.tools.run_memory.tools import (
                attack_surface_from_file,
                coverage_from_file,
                evidence_from_file,
                hypotheses_from_file,
            )

            rows["attack_surface"] = attack_surface_from_file(state_dir / "attack_surface.json")
            rows["hypotheses"] = hypotheses_from_file(state_dir / "hypotheses.json")
            rows["coverage"] = coverage_from_file(state_dir / "coverage.json")
            rows["evidence"] = evidence_from_file(state_dir / "evidence.json")
        except Exception:
            rows = {key: [] for key in rows}

    summary = _memory_summary(rows)
    if state_dir is not None:
        workflow_summary = _workflow_summary_for_child_context(state_dir)
        if workflow_summary:
            summary["workflow_clusters"] = workflow_summary
    return {
        "summary": summary,
        "attack_surface": _select_relevant(rows["attack_surface"], terms),
        "hypotheses": _select_relevant(rows["hypotheses"], terms),
        "coverage": _select_relevant(rows["coverage"], terms),
        "evidence": _select_relevant(rows["evidence"], terms),
    }


def _workflow_summary_for_child_context(state_dir: Path) -> dict[str, Any]:
    try:
        from strix.tools.workflow import workflow_cluster_summary_for_state
    except Exception:
        return {}
    try:
        summary = workflow_cluster_summary_for_state(state_dir)
    except Exception:
        return {}
    clusters = summary.get("clusters") if isinstance(summary, dict) else []
    if not isinstance(clusters, list):
        clusters = []
    return {
        "cluster_count": summary.get("cluster_count"),
        "dominant_clusters": summary.get("dominant_clusters", [])[:5],
        "clusters_without_hypotheses": summary.get("clusters_without_hypotheses", [])[:8],
        "clusters_without_coverage": summary.get("clusters_without_coverage", [])[:8],
        "external_clusters_without_inventory": summary.get("external_clusters_without_inventory", [])[:8],
        "clusters_with_narrow_testing": summary.get("clusters_with_narrow_testing", [])[:5],
        "suggested_next_testing_families": summary.get("suggested_next_testing_families", [])[:5],
    }


def _memory_summary(rows: dict[str, list[dict[str, Any]]]) -> dict[str, Any]:
    summary: dict[str, Any] = {
        "attack_surface_count": len(rows["attack_surface"]),
        "hypothesis_count": len(rows["hypotheses"]),
        "coverage_count": len(rows["coverage"]),
        "evidence_count": len(rows["evidence"]),
    }
    if rows["attack_surface"]:
        summary["attack_surface_by_kind"] = dict(Counter(str(r.get("kind") or "unknown") for r in rows["attack_surface"]))
    if rows["hypotheses"]:
        summary["hypotheses_by_status"] = dict(Counter(str(r.get("status") or "unknown") for r in rows["hypotheses"]))
        summary["hypotheses_by_vuln_type"] = dict(Counter(str(r.get("vuln_type") or "unknown") for r in rows["hypotheses"]))
    if rows["coverage"]:
        summary["coverage_by_status"] = dict(Counter(str(r.get("status") or "unknown") for r in rows["coverage"]))
        summary["coverage_by_vuln_type"] = dict(Counter(str(r.get("vuln_type") or "unknown") for r in rows["coverage"]))
    return summary


def _select_relevant(rows: list[dict[str, Any]], terms: set[str]) -> list[dict[str, Any]]:
    scored: list[tuple[int, int, dict[str, Any]]] = []
    for index, row in enumerate(rows):
        text = _row_text(row)
        score = _relevance_score(row, text, terms)
        if score > 0:
            scored.append((score, index, _clip_row(row)))
    if not scored:
        recent = rows[-min(len(rows), _CHILD_CONTEXT_FALLBACK_LIMIT):]
        return [_clip_row(row) for row in recent]
    scored.sort(key=lambda item: (-item[0], item[1]))
    return [row for _, _, row in scored[:_CHILD_CONTEXT_SECTION_LIMIT]]


def _relevance_score(row: dict[str, Any], text: str, terms: set[str]) -> int:
    score = sum(1 for term in terms if term in text)
    for field in ("endpoint", "url", "target"):
        value = str(row.get(field) or "")
        if value:
            parsed = urlsplit(value if "://" in value else f"http://placeholder{value}")
            path_terms = _task_terms(parsed.path.replace("/", " "))
            score += len(path_terms & terms) * 2
    status = str(row.get("status") or "").lower()
    if score > 0 and status in {"passed", "in_progress", "planned"}:
        score += 1
    return score


def _clip_row(row: dict[str, Any]) -> dict[str, Any]:
    keep = {
        "surface_id",
        "hypothesis_id",
        "coverage_id",
        "evidence_id",
        "kind",
        "url",
        "endpoint",
        "method",
        "parameter",
        "parameters",
        "auth_state",
        "vuln_type",
        "status",
        "phase",
        "hypothesis",
        "test_strategy",
        "risk_reason",
        "result",
        "notes",
        "summary",
        "target",
        "evidence_ids",
        "coverage_ids",
    }
    clipped: dict[str, Any] = {}
    for key, value in row.items():
        if key in keep:
            clipped[key] = _clip_value(value)
    return clipped


def _clip_value(value: Any) -> Any:
    if isinstance(value, str):
        return _clip(value, _CHILD_CONTEXT_TEXT_LIMIT)
    if isinstance(value, list):
        return [_clip_value(item) for item in value[:12]]
    if isinstance(value, dict):
        return {str(k): _clip_value(v) for k, v in list(value.items())[:12]}
    return value


def _recent_parent_context(items: list[Any]) -> list[dict[str, str]]:
    recent: list[dict[str, str]] = []
    for item in reversed(items):
        role = "context"
        text = ""
        if isinstance(item, dict):
            if item.get("type") == "function_call" or item.get("name"):
                continue
            role = str(item.get("role") or item.get("type") or "context")
            text = _extract_content_text(item.get("content") or item.get("summary") or item)
        else:
            text = str(item)
        text = _clip(text, _CHILD_CONTEXT_TEXT_LIMIT)
        if text:
            recent.append({"role": _clip(role, 80), "text": text})
        if len(recent) >= _RECENT_PARENT_ITEMS:
            break
    return list(reversed(recent))


def _extract_content_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, dict):
                parts.append(str(item.get("text") or item.get("content") or ""))
            else:
                parts.append(str(item))
        return " ".join(part for part in parts if part)
    if isinstance(content, dict):
        return json.dumps(_clip_value(content), ensure_ascii=False, default=str)
    return str(content or "")


def _task_terms(text: str) -> set[str]:
    stop_words = {
        "http",
        "https",
        "www",
        "com",
        "the",
        "and",
        "for",
        "with",
        "agent",
        "api",
        "endpoint",
        "endpoints",
        "test",
        "testing",
        "record",
        "coverage",
        "hypothesis",
        "hypotheses",
        "get",
        "post",
        "put",
        "patch",
        "delete",
        "options",
        "head",
    }
    return {
        term
        for term in re.findall(r"[a-zA-Z0-9_./:-]{3,}", text.lower())
        if term not in stop_words
    }


def _row_text(row: dict[str, Any]) -> str:
    return json.dumps(row, ensure_ascii=False, default=str).lower()


def _clip(text: Any, limit: int) -> str:
    value = str(text or "")
    if len(value) <= limit:
        return value
    return value[: max(0, limit - 24)] + "...[truncated]"


def _enforce_context_budget(pack: dict[str, Any]) -> dict[str, Any]:
    serialized = json.dumps(pack, ensure_ascii=False, default=str)
    if len(serialized) <= _CHILD_CONTEXT_MAX_CHARS:
        return pack
    compact = dict(pack)
    compact["relevant_evidence"] = compact.get("relevant_evidence", [])[:3]
    compact["relevant_coverage"] = compact.get("relevant_coverage", [])[:4]
    compact["relevant_hypotheses"] = compact.get("relevant_hypotheses", [])[:4]
    compact["relevant_attack_surface"] = compact.get("relevant_attack_surface", [])[:4]
    compact["recent_parent_context"] = compact.get("recent_parent_context", [])[-1:]
    compact["truncated"] = True
    compact["truncation_reason"] = "Scoped context exceeded serialized size budget."
    serialized = json.dumps(compact, ensure_ascii=False, default=str)
    if len(serialized) <= _CHILD_CONTEXT_MAX_CHARS:
        return compact
    return {
        "context_type": compact.get("context_type", "scoped_child_context_v1"),
        "child_name": compact.get("child_name"),
        "parent_id": compact.get("parent_id"),
        "task_focus": _clip(compact.get("task_focus", ""), 2_000),
        "skills": compact.get("skills", []),
        "execution_contract": compact.get("execution_contract", {}),
        "memory_summary": compact.get("memory_summary", {}),
        "truncated": True,
    }
