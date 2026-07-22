"""Shared engagement state — State Handoff carrier across Task Graph nodes.

Aligned with three-layer Graph model:
  Task Graph   — stages_done / stage edges (workflow)
  Agent Graph  — agent_packages / fan-out workers
  Feedback     — feedback[] loop outcomes + coverage_ledger (append-only)
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


class Surface(BaseModel):
    path: str
    method: str = "GET"
    note: str = ""
    status: Literal["open", "probed", "booked", "deadend", "skipped"] = "open"


class Actor(BaseModel):
    """Observed or planned identity for dual-actor / authz work (State Handoff)."""

    id: str = "anon"
    role_hint: str = "unknown"  # customer|staff|admin|anon|unknown
    how: str = "none"  # none|register|login|token|operator
    cookie_keys: list[str] = Field(default_factory=list)
    notes: str = ""


class Resource(BaseModel):
    """Business/API resource aggregated from paths (not just flat endpoints)."""

    name: str
    paths: list[str] = Field(default_factory=list)
    id_locations: list[str] = Field(default_factory=list)  # path|query|body hints
    sensitivity: str = "user"  # public|user|admin|secret
    actions_seen: list[str] = Field(default_factory=list)  # GET/POST/...
    status: Literal["open", "probed", "booked", "deadend", "skipped"] = "open"
    notes: str = ""


class Candidate(BaseModel):
    title: str
    location: str
    severity: str = "medium"
    proof_excerpt: str = ""
    causality: str = ""
    reproducibility: str = ""
    impact: str = ""
    stage: str = ""
    ready_to_book: bool = False
    worker_id: str = ""
    precondition: str = ""
    affected_actor: str = ""
    affected_resource: str = ""


class Finding(BaseModel):
    title: str
    location: str
    severity: str = "medium"
    proof: str = ""
    stage: str = ""
    precondition: str = ""
    affected_actor: str = ""
    affected_resource: str = ""


class FeedbackEvent(BaseModel):
    """One Feedback Graph loop outcome (not a Task edge)."""

    loop: str  # structure | tool_use | evidence | coverage | retry
    stage: str
    ok: bool
    detail: str = ""


class PenState(BaseModel):
    """Carrier state for the hard app_assessment graph (State Handoff)."""

    target: str
    graph_id: str = "app_assessment"
    roe: dict[str, Any] = Field(default_factory=lambda: {"allow_postex": False})
    stage: str = "init"
    stages_done: list[str] = Field(default_factory=list)
    surfaces: list[Surface] = Field(default_factory=list)
    actors: list[Actor] = Field(default_factory=list)
    resources: list[Resource] = Field(default_factory=list)
    candidates: list[Candidate] = Field(default_factory=list)
    findings: list[Finding] = Field(default_factory=list)
    notes: list[str] = Field(default_factory=list)
    errors: list[str] = Field(default_factory=list)
    dry_run: bool = False
    model: str = "deepseek-v4-flash"
    pack_root: str = ""
    work_dir: str = ""
    max_shell_chars: int = 12000
    operator_notes: str = ""
    only_stages: list[str] = Field(default_factory=list)

    # --- State Handoff: shared session across stages / workers ---
    cookies: dict[str, str] = Field(default_factory=dict)
    actor_cookies: dict[str, dict[str, str]] = Field(default_factory=dict)

    # --- Agent Graph controls ---
    agent_graph: bool = True
    max_workers: int = 4
    agent_packages: list[str] = Field(default_factory=list)
    forced_packages: list[str] = Field(default_factory=list)
    effective_max_workers: int = 0

    # --- Feedback Graph log ---
    feedback: list[FeedbackEvent] = Field(default_factory=list)
    last_stage_tool_calls: int = 0
    last_stage_structured: bool = False

    # --- Coverage ledger (append-only; Feedback coverage loop reads this) ---
    coverage_ledger: list[dict[str, Any]] = Field(default_factory=list)
    coverage_metrics: dict[str, Any] = Field(default_factory=dict)
    # alias kept for older readers
    hv_metrics: dict[str, Any] = Field(default_factory=dict)
    authz_matrix: list[dict[str, Any]] = Field(default_factory=list)

    def note(self, msg: str) -> None:
        self.notes.append(msg)

    def mark_stage(self, name: str) -> None:
        self.stage = name
        if name not in self.stages_done:
            self.stages_done.append(name)

    def feedback_log(self, loop: str, stage: str, ok: bool, detail: str = "") -> None:
        self.feedback.append(FeedbackEvent(loop=loop, stage=stage, ok=ok, detail=detail))
        self.note(f"feedback[{loop}] {stage}: {'ok' if ok else 'fail'} {detail}".strip())

    def to_public_dict(self) -> dict[str, Any]:
        return self.model_dump()


def _content_to_text(node_input: Any) -> str | None:
    parts = getattr(node_input, "parts", None)
    if not parts:
        return None
    chunks: list[str] = []
    for p in parts:
        t = getattr(p, "text", None)
        if t:
            chunks.append(t)
    return "".join(chunks).strip() if chunks else None


def _strip_legacy_campaign_fields(data: dict[str, Any]) -> dict[str, Any]:
    """Ignore removed Campaign state machine fields from old state.json."""
    data = dict(data)
    data.pop("campaigns", None)
    return data


def as_state(node_input: Any) -> PenState:
    """Coerce workflow node input into PenState."""
    if isinstance(node_input, PenState):
        return node_input
    if isinstance(node_input, dict):
        return PenState.model_validate(_strip_legacy_campaign_fields(node_input))
    if isinstance(node_input, str):
        text = node_input.strip()
        if text.startswith("{"):
            import json

            return PenState.model_validate(_strip_legacy_campaign_fields(json.loads(text)))
        return PenState(target=text)
    content_text = _content_to_text(node_input)
    if content_text is not None:
        if content_text.startswith("{"):
            import json

            return PenState.model_validate(
                _strip_legacy_campaign_fields(json.loads(content_text))
            )
        return PenState(target=content_text)
    raise TypeError(f"unsupported node input type: {type(node_input)!r}")
