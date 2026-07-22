"""Task Graph assembly: hard sequential app_assessment (ADK Workflow edges).

Agent Graph and Feedback Graph run *inside* stage nodes — not as alternate runtimes.
See README three-layer model.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from google.adk import Workflow

from node5.pack_loader import default_pack_root, default_plan, load_graph
from node5.stages import finalize_node, init_node, make_stage_node, validate_book_node

WORKER_STAGES = (
    "surface",
    "prior_reverify",
    "auth_session",
    "class_probe",
    "coverage_probe",
    "authz_logic",
    "component",
)


def build_app_assessment_workflow(
    graph_id: str = "app_assessment",
    pack_root: str | None = None,
) -> Workflow:
    root = default_pack_root() if not pack_root else Path(pack_root)
    graph = load_graph(root, graph_id)
    plan = default_plan(graph)

    stage_nodes: list[Any] = [init_node]
    for name in plan:
        if name == "validate_book":
            stage_nodes.append(validate_book_node)
        else:
            stage_nodes.append(make_stage_node(name))
    stage_nodes.append(finalize_node)

    return Workflow(
        name=f"node5_{graph_id}",
        description=(
            f"Node5 Task Graph hard-order for {graph_id}; "
            f"Agent Graph inside class_probe; Feedback after stages; pack={root}"
        ),
        edges=[("START", *stage_nodes)],
    )


def describe_graph(graph_id: str = "app_assessment", pack_root: str | None = None) -> dict[str, Any]:
    root = default_pack_root() if not pack_root else Path(pack_root)
    graph = load_graph(root, graph_id)
    plan = default_plan(graph)
    return {
        "graph_id": graph_id,
        "label": graph.get("label"),
        "roe": graph.get("roe"),
        "layers": {
            "task_graph": {
                "role": "organize how tasks execute",
                "edges": ["START", "init", *plan, "finalize"],
                "force_order": True,
            },
            "agent_graph": {
                "role": "organize multi-agent collaboration",
                "where": "class_probe fan-out workers (skill packages) → Join",
                "relations": ["Delegation", "Aggregation", "State Handoff (cookies)"],
                "not": "no Node4 subagent tool API; CLI-only workers",
            },
            "feedback_graph": {
                "role": "organize continuous quality loops (not task edges)",
                "loops": [
                    "structure",
                    "tool_use",
                    "evidence",
                    "coverage",
                    "discovery_yield",
                    "retry",
                ],
                "process_contracts": (
                    "structure fail / empty ready / low class_probe yield → bounded retry; "
                    "not vuln answer keys"
                ),
                "book_gate": "validate_book proof bar + fresh-ish proof",
            },
            "state_handoff": {
                "carrier": "PenState",
                "shared": [
                    "cookies",
                    "actor_cookies",
                    "surfaces",
                    "actors",
                    "resources",
                    "candidates",
                    "coverage_ledger",
                    "hv_metrics",
                    "notes",
                    "feedback",
                ],
            },
            "evolution": {
                "capability_P0": "surface model + dual-actor authz + finding precondition",
                "capability_P1": "injection depth + egress/upload + identity flows",
                "capability_P2": "high-value probe + force packages + coverage hints",
                "coverage_feedback": "required_coverage + coverage_ledger + Feedback coverage loop",
                "coverage_probe_stage": "Task stage deterministic probes, Feedback owns attempt",
                "discovery_P2": "schedule harden effective_max_workers",
                "discovery_P3": "SQLi schema → sensitive columns next hop",
                "discovery_P4": "HV metrics in summary + EVAL",
            },
            "discovery_rate": (
                "hv ≈ recon × schedule × attempt × punch × book; "
                "see summary.hv_metrics"
            ),
        },
        "default_plan": plan,
        "policy_contrast": {
            "node4_soft": "soft Task Graph + Agent Graph(subagent) + harness Feedback hooks",
            "node5": "hard Task Graph + class_probe Agent Graph + explicit Feedback log",
        },
    }
