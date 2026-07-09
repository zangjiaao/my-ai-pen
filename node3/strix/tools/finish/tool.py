"""``finish_scan`` — root-agent termination + executive report persistence."""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from agents import RunContextWrapper, function_tool

from strix.core.agents import coordinator_from_context


logger = logging.getLogger(__name__)
_GATE_SAMPLE_LIMIT = 5


def _finish_quality_gate() -> dict[str, Any] | None:
    try:
        from strix.platform.node_runner import completion_gate_for_run
        from strix.report.state import get_global_report_state
    except ImportError:
        return None

    report_state = get_global_report_state()
    if report_state is None or not hasattr(report_state, "get_run_dir"):
        return None
    try:
        run_dir = report_state.get_run_dir()
    except Exception:
        logger.exception("finish_scan quality gate could not resolve run_dir")
        return None
    return completion_gate_for_run(run_dir)


def _do_finish(
    *,
    parent_id: str | None,
    executive_summary: str,
    methodology: str,
    technical_analysis: str,
    recommendations: str,
) -> dict[str, Any]:
    if parent_id is not None:
        return {
            "success": False,
            "error": (
                "This tool can only be used by the root/main agent. "
                "If you are a subagent, use agent_finish instead"
            ),
        }

    errors: list[str] = []
    if not executive_summary.strip():
        errors.append("Executive summary cannot be empty")
    if not methodology.strip():
        errors.append("Methodology cannot be empty")
    if not technical_analysis.strip():
        errors.append("Technical analysis cannot be empty")
    if not recommendations.strip():
        errors.append("Recommendations cannot be empty")
    if errors:
        return {"success": False, "error": "Validation failed", "errors": errors}

    try:
        from strix.report.state import get_global_report_state

        report_state = get_global_report_state()
        if report_state is None:
            logger.warning("No global report state; scan results not persisted")
            return {
                "success": True,
                "scan_completed": True,
                "message": "Scan completed (not persisted)",
                "warning": "Results could not be persisted - report state unavailable",
            }
        report_state.update_scan_final_fields(
            executive_summary=executive_summary.strip(),
            methodology=methodology.strip(),
            technical_analysis=technical_analysis.strip(),
            recommendations=recommendations.strip(),
        )
        vuln_count = len(report_state.vulnerability_reports)
    except (ImportError, AttributeError) as e:
        logger.exception("finish_scan persistence failed")
        return {"success": False, "error": f"Failed to complete scan: {e!s}"}
    else:
        logger.info(
            "finish_scan: completed scan with %d vulnerability report(s)",
            vuln_count,
        )
        return {
            "success": True,
            "scan_completed": True,
            "message": "Scan completed successfully",
            "vulnerabilities_found": vuln_count,
        }


def _summarize_completion_gate(gate: dict[str, Any]) -> dict[str, Any]:
    count_keys = [
        "unreported_confirmed_coverage_count",
        "uncovered_attack_surface_count",
        "external_discovery_gap_count",
        "hypothesis_gap_count",
        "surface_hypothesis_gap_count",
        "coverage_without_hypothesis_count",
        "narrow_workflow_cluster_count",
        "completion_warning_count",
        "hypothesis_count",
        "attack_surface_count",
        "unfinished_count",
    ]
    list_keys = [
        "incomplete_reasons",
        "unreported_confirmed_coverage",
        "uncovered_attack_surfaces",
        "external_discovery_gaps",
        "hypothesis_gaps",
        "surface_hypothesis_gaps",
        "coverage_without_hypothesis",
        "narrow_workflow_clusters",
        "unfinished_todos",
        "completion_warnings",
    ]
    summary: dict[str, Any] = {
        "ok": bool(gate.get("ok")),
        "counts": {key: gate.get(key) for key in count_keys if key in gate},
        "samples": {},
        "omitted_full_details": True,
    }
    warnings = gate.get("completion_warnings")
    if isinstance(warnings, list):
        summary["counts"]["completion_warning_count"] = len(warnings)
    workflow_clusters = gate.get("workflow_clusters")
    if isinstance(workflow_clusters, dict):
        clusters = workflow_clusters.get("clusters")
        summary["workflow_clusters"] = {
            "cluster_count": workflow_clusters.get("cluster_count"),
            "dominant_clusters": workflow_clusters.get("dominant_clusters"),
            "clusters_without_hypotheses": workflow_clusters.get("clusters_without_hypotheses"),
            "clusters_without_coverage": workflow_clusters.get("clusters_without_coverage"),
            "external_clusters_without_inventory": workflow_clusters.get("external_clusters_without_inventory"),
            "clusters_with_narrow_testing": (
                workflow_clusters.get("clusters_with_narrow_testing") or []
            )[:_GATE_SAMPLE_LIMIT],
            "suggested_next_testing_families": (
                workflow_clusters.get("suggested_next_testing_families") or []
            )[:_GATE_SAMPLE_LIMIT],
            "sample_clusters": clusters[:_GATE_SAMPLE_LIMIT] if isinstance(clusters, list) else [],
        }
    for key in list_keys:
        value = gate.get(key)
        if isinstance(value, list) and value:
            summary["samples"][key] = [_compact_gate_item(item) for item in value[:_GATE_SAMPLE_LIMIT]]
            if len(value) > _GATE_SAMPLE_LIMIT:
                summary["samples"][f"{key}_omitted_count"] = len(value) - _GATE_SAMPLE_LIMIT
        elif value:
            summary["samples"][key] = value
    return summary


def _compact_gate_item(item: Any) -> Any:
    if not isinstance(item, dict):
        return item
    wanted = [
        "todo_id",
        "title",
        "status",
        "priority",
        "surface_id",
        "hypothesis_id",
        "coverage_id",
        "evidence_id",
        "endpoint",
        "url",
        "method",
        "parameter",
        "vuln_type",
        "auth_state",
        "reason",
        "notes",
    ]
    compacted = {key: item.get(key) for key in wanted if item.get(key) not in (None, "", [])}
    return compacted or {key: item.get(key) for key in list(item)[:5]}


@function_tool(timeout=60)
async def finish_scan(
    ctx: RunContextWrapper,
    executive_summary: str,
    methodology: str,
    technical_analysis: str,
    recommendations: str,
) -> str:
    """Finalize the scan — persist the customer-facing report.

    **Root-agent only.** Subagents must call ``agent_finish`` from the
    multi-agent graph tools instead. Calling this finalizes everything:

    1. Verifies you are the root agent.
    2. Writes the four narrative sections to the scan record.
    3. Marks the report completed. In one-shot runs this stops execution;
       in platform conversation mode the root agent stays waiting for
       follow-up instructions.

    **Pre-flight checklist (mandatory — do not skip):**

    1. **Call ``view_agent_graph`` first.** Inspect every entry in the
       summary. If ANY agent is in ``running`` / ``waiting`` state,
       you MUST NOT call ``finish_scan`` yet —
       wrap them up first via ``send_message_to_agent`` (ask them to
       finish), ``wait_for_message`` (block until their report
       arrives), or ``stop_agent`` (graceful cancel). Only ``completed``
       / ``crashed`` / ``stopped`` agents are safe to leave behind.
       Calling ``finish_scan`` while children are alive orphans their
       work and produces an incomplete report.
    2. All vulnerabilities you found are filed via
       ``create_vulnerability_report`` (un-reported findings are not
       tracked and not credited).
    3. Call ``list_memory(kind="summary")`` and make sure the run has
       attack-surface and coverage ledger entries. If a discovered endpoint,
       form, auth route, admin route, upload point, API route, or service is
       missing from memory, record it before finishing.
    4. Call ``list_memory(kind="hypotheses")`` and
       ``list_memory(kind="hypothesis_gaps")``. Every high-value attack
       surface should have concrete hypotheses, and every hypothesis must be
       tested, blocked, or skipped with linked coverage/evidence or concrete
       notes.
    5. Compare ``list_memory(kind="attack_surface")`` with
       ``list_memory(kind="coverage")``. Every discovered HTTP/API/form/auth/
       upload/service surface must have coverage, or an explicit
       ``blocked``/``skipped`` coverage entry with notes explaining why it
       could not be tested.
    6. Each meaningful positive or negative test has a ``record_coverage``
       entry. Prefer passing ``hypothesis_id`` so the test matrix closes.
       Confirmed vulnerability reports must cite real ``evidence_ids``
       returned by ``record_evidence``; do not invent evidence IDs.
    7. Don't double-report - one report per distinct vulnerability.

    **Calling this multiple times overwrites the previous report.**
    Make the single call comprehensive.

    **Customer-facing report rules** (this output is rendered into the
    final PDF the client sees):

    - Never mention internal infrastructure: no local/absolute paths
      (``/workspace/...``), no agent names, no sandbox/orchestrator/
      tooling references, no system prompts, no model-internal errors.
    - Tone: formal, third-person, objective, concise. This is a
      consultant deliverable, not an engineering log.
    - Each section has a specific role:

        - ``executive_summary`` — for non-technical leadership. Risk
          posture, business impact (data exposure / compliance /
          reputation), notable criticals, overarching remediation
          theme.
        - ``methodology`` — frameworks followed (OWASP WSTG, PTES,
          OSSTMM, NIST), engagement type (black/gray/white box), scope
          and constraints, categories of testing performed. **No**
          internal execution detail.
        - ``technical_analysis`` — consolidated findings overview with
          severity model and systemic root causes. Reference individual
          vuln reports for repro steps; don't duplicate raw evidence.
        - ``recommendations`` — prioritized actions grouped by urgency
          (Immediate / Short-term / Medium-term), each with concrete
          remediation steps. End with retest/validation guidance.

    Args:
        executive_summary: Business-level summary for leadership.
        methodology: Frameworks, scope, and approach.
        technical_analysis: Consolidated findings + systemic themes.
        recommendations: Prioritized, actionable remediation.
    """
    inner = ctx.context if isinstance(ctx.context, dict) else {}
    coordinator = coordinator_from_context(inner)
    me = inner.get("agent_id")
    parent_id = inner.get("parent_id")
    if coordinator is not None and parent_id is None and me is not None:
        unresolved_agents = await coordinator.unresolved_agents_except(me)
    else:
        unresolved_agents = []

    if unresolved_agents:
        return json.dumps(
            {
                "success": False,
                "scan_completed": False,
                "error": (
                    "Cannot finish scan while child agents are still active or have unread messages. "
                    "Wait for agent_finish reports, consume pending messages, or explicitly resolve them first"
                ),
                "unresolved_agents": unresolved_agents,
            },
            ensure_ascii=False,
            default=str,
        )

    quality_gate = await asyncio.to_thread(_finish_quality_gate)
    if quality_gate is not None and not quality_gate.get("ok"):
        confirmed_gap_count = int(quality_gate.get("unreported_confirmed_coverage_count") or 0)
        hypothesis_gap_count = int(quality_gate.get("hypothesis_gap_count") or 0)
        surface_hypothesis_gap_count = int(quality_gate.get("surface_hypothesis_gap_count") or 0)
        unlinked_coverage_count = int(quality_gate.get("coverage_without_hypothesis_count") or 0)
        hypothesis_count = int(quality_gate.get("hypothesis_count") or 0)
        attack_surface_count = int(quality_gate.get("attack_surface_count") or 0)
        unfinished_count = int(quality_gate.get("unfinished_count") or 0)
        if unfinished_count:
            next_action = (
                "Resolve the unfinished root todo(s) by doing the remaining work or recording a concrete "
                "blocked/skipped outcome, then finish once the hard evidence checks pass"
            )
        elif attack_surface_count and not hypothesis_count:
            next_action = (
                "Convert recorded attack surface into record_hypothesis test-matrix entries, then execute "
                "the planned tests and close them with evidence-backed record_coverage"
            )
        elif surface_hypothesis_gap_count:
            next_action = (
                "Create concrete record_hypothesis test-matrix entries for every surface_hypothesis_gaps "
                "entry before validating or reporting more findings"
            )
        elif hypothesis_gap_count:
            next_action = (
                "Resolve every hypothesis_gaps entry before trying finish_scan again; each hypothesis must be "
                "tested, blocked, or skipped with linked coverage/evidence or concrete notes"
            )
        elif unlinked_coverage_count:
            next_action = (
                "Link every coverage_without_hypothesis entry to a planned hypothesis by passing "
                "hypothesis_id to record_coverage or updating the hypothesis coverage_ids"
            )
        elif confirmed_gap_count:
            next_action = (
                "Create vulnerability reports for every unreported_confirmed_coverage entry before trying "
                "finish_scan again; each report needs independent validation evidence"
            )
        else:
            next_action = "Record attack surface, coverage, evidence, and cite real evidence_ids before finishing"
        return json.dumps(
            {
                "success": False,
                "scan_completed": False,
                "error": (
                    "Cannot finish scan because evidence and memory quality gates did not pass. "
                    + next_action
                ),
                "completion_gate_summary": _summarize_completion_gate(quality_gate),
                "recommended_next_action": next_action,
            },
            ensure_ascii=False,
            default=str,
        )

    result = await asyncio.to_thread(
        _do_finish,
        parent_id=parent_id,
        executive_summary=executive_summary,
        methodology=methodology,
        technical_analysis=technical_analysis,
        recommendations=recommendations,
    )
    if (
        result.get("success")
        and result.get("scan_completed")
        and coordinator is not None
        and isinstance(me, str)
    ):
        next_status = "waiting" if inner.get("keep_alive_after_finish") else "completed"
        await coordinator.set_status(me, next_status)
    if quality_gate is not None and result.get("success"):
        warnings = quality_gate.get("completion_warnings")
        if isinstance(warnings, list) and warnings:
            result["completion_warnings"] = warnings[:10]
            if len(warnings) > 10:
                result["completion_warnings_omitted_count"] = len(warnings) - 10
    return json.dumps(result, ensure_ascii=False, default=str)
