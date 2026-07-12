"""Platform-agent orchestration for routing user messages to agent nodes."""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Awaitable, Callable

from app.config import settings
from app.models.node import PLATFORM_AGENT_NODE_ID
from app.services.agent_router import RoutingDecision, extract_targets


TARGET_RE = re.compile(r"https?://[^\s'\"<>\u4E00-\u9FFF\uFF0C\u3001,;\uFF1B)\]\}]+|\b(?:\d{1,3}\.){3}\d{1,3}(?:/\d{1,2})?\b")

ChatFn = Callable[[list[dict]], Awaitable[str]]
_chat_override: ChatFn | None = None


PLAN_ACTIONS = {
    "answer_user",
    "ask_clarification",
    "start_task",
    "continue_task",
    "summarize_results",
}

CAPABILITY_TO_AGENT = {
    "platform.chat": "platform",
    "snapshot.qa": "platform",
    "pentest.web": "pentest",
    "baseline.check": "baseline",
    "remediation.advice": "remediation",
    "report.generate": "report",
}


class OrchestrationError(RuntimeError):
    """Raised when the platform agent cannot produce a valid routing plan."""


@dataclass(frozen=True)
class AgentCapability:
    agent_type: str
    capability: str
    node_id: str | None = None
    name: str = ""
    online: bool = False


@dataclass(frozen=True)
class OrchestrationContext:
    conversation_status: str | None
    requested_agent: str | None = None
    requested_node_id: str | None = None
    has_resume_task: bool = False
    has_bound_node: bool = False
    bound_node_id: str | None = None
    capabilities: list[AgentCapability] = field(default_factory=list)


@dataclass(frozen=True)
class AgentPlan:
    action: str
    capability: str
    agent: str
    targets: list[str] = field(default_factory=list)
    agent_node_id: str | None = None
    mode: str = ""
    message: str = ""
    reason: str = ""


def set_orchestrator_chat_override(chat: ChatFn | None) -> None:
    global _chat_override
    _chat_override = chat


async def route_with_platform_agent(*, text: str, context: OrchestrationContext) -> RoutingDecision:
    plan = await _plan_with_platform_agent(text=text, context=context)
    return _policy_guard(plan, text=text, context=context)


async def _plan_with_platform_agent(*, text: str, context: OrchestrationContext) -> AgentPlan:
    raw = await _chat([
        {"role": "system", "content": ORCHESTRATOR_PROMPT},
        {"role": "user", "content": json.dumps(_planner_input(text, context), ensure_ascii=False, default=str)},
    ])
    data = _parse_json_object(raw)
    return _agent_plan_from_json(data)


def _policy_guard(plan: AgentPlan, *, text: str, context: OrchestrationContext) -> RoutingDecision:
    # Merge planner targets with URLs/hosts present in the user text so a weak LLM plan
    # cannot drop an explicit target the user already provided.
    targets = _dedupe([*plan.targets, *extract_targets(text)])
    requested_agent = _normalize_agent(context.requested_agent)
    agent = _normalize_agent(plan.agent) or _agent_for_capability(plan.capability) or requested_agent or "platform"
    pentest_online = _online_capability_nodes(context, "pentest.web")

    if requested_agent == "pentest" and not targets and context.has_resume_task and plan.action in {"answer_user", "summarize_results", "ask_clarification"}:
        return RoutingDecision(
            action="platform_reply",
            capability="snapshot.qa",
            mode="snapshot_qa",
            agent="pentest",
            agent_node_id=plan.agent_node_id or context.requested_node_id or context.bound_node_id,
            reason=plan.reason or "user explicitly addressed the pentest agent for session context",
        )

    if requested_agent == "pentest" and context.requested_node_id and not targets and not context.has_resume_task and plan.action in {"answer_user", "summarize_results"}:
        return RoutingDecision(
            action="ask_clarification",
            capability="pentest.web",
            mode="missing_target",
            agent="pentest",
            agent_node_id=plan.agent_node_id or context.requested_node_id,
            requires_target=True,
            reason=plan.reason or "user explicitly addressed a pentest node without an execution target",
            message="Please provide the target URL/IP and confirm it is in authorized scope.",
        )

    # Hard override: online pentest node + explicit target in message must not be answered as
    # "no pentest capability" platform chat. This is the bug path behind false offline claims.
    if (
        pentest_online
        and targets
        and plan.action in {"answer_user", "ask_clarification", "summarize_results"}
        and _should_force_pentest_dispatch(plan=plan, text=text, targets=targets)
    ):
        return RoutingDecision(
            action="dispatch_node",
            capability="pentest.web",
            mode=plan.mode or ("completed_followup" if context.conversation_status == "completed" else "new_task"),
            agent="pentest",
            agent_node_id=plan.agent_node_id or context.requested_node_id or pentest_online[0],
            requires_target=False,
            reason=(
                plan.reason
                or "policy forced pentest dispatch: online pentest.web capability and explicit target present"
            ),
            targets=targets[:1],
        )

    # Honest offline path: target present but no connected pentest node.
    if (
        not pentest_online
        and targets
        and plan.action in {"answer_user", "ask_clarification", "start_task"}
        and _looks_like_execution_request(text, targets)
    ):
        return RoutingDecision(
            action="ask_clarification",
            capability="platform.chat",
            mode="no_online_executor",
            agent="platform",
            requires_target=False,
            reason="no online WebSocket-connected pentest node for dispatch",
            message=(
                "当前没有通过 WebSocket 在线连接的渗透节点（pentest.web）。"
                "节点管理若仍显示 online，可能是状态未同步；请确认 Node2 进程已连接平台后重试。"
            ),
        )

    if plan.action == "ask_clarification":
        return RoutingDecision(
            action="ask_clarification",
            capability=plan.capability or "platform.chat",
            mode=plan.mode or "clarification",
            agent="platform",
            requires_target=True,
            reason=plan.reason or "platform agent requested clarification",
            message=plan.message,
        )

    if plan.action in {"answer_user", "summarize_results"}:
        mode = plan.mode or ("snapshot_qa" if plan.action == "summarize_results" else "platform_chat")
        capability = plan.capability or ("snapshot.qa" if mode == "snapshot_qa" else "platform.chat")
        return RoutingDecision(
            action="platform_reply",
            capability=capability,
            mode=mode,
            agent=agent if agent != "pentest" or capability == "snapshot.qa" else "platform",
            agent_node_id=plan.agent_node_id or context.requested_node_id,
            reason=plan.reason or "platform agent chose to answer",
        )

    if plan.action == "continue_task":
        if context.has_resume_task or context.has_bound_node:
            return RoutingDecision(
                action="continue_task",
                capability=plan.capability or "pentest.web",
                mode=plan.mode or "continue_task",
                agent=agent if agent != "platform" else "pentest",
                agent_node_id=plan.agent_node_id or context.requested_node_id or context.bound_node_id,
                reason=plan.reason or "platform agent chose to continue task",
            )
        return RoutingDecision(
            action="ask_clarification",
            capability=plan.capability or "platform.chat",
            mode="missing_resume_context",
            agent="platform",
            requires_target=True,
            reason="policy rejected continue without resumable task",
            message="This conversation has no resumable task. Please provide a target URL/IP or start a new task.",
        )

    if plan.action == "start_task":
        if len(targets) > 1:
            return RoutingDecision(
                action="ask_clarification",
                capability="platform.chat",
                mode="multiple_targets",
                agent="platform",
                requires_target=True,
                reason="policy rejected multiple execution targets",
                message="Multiple targets were provided. Please create one session per target or send only one URL/IP.",
            )
        if not targets:
            return RoutingDecision(
                action="ask_clarification",
                capability=plan.capability or "platform.chat",
                mode="missing_target",
                agent="platform",
                requires_target=True,
                reason="policy rejected task without target",
                message="Please provide the target URL or IP and confirm it is in authorized scope.",
            )
        capability = plan.capability or "pentest.web"
        if capability == "pentest.web" and not pentest_online:
            return RoutingDecision(
                action="ask_clarification",
                capability="platform.chat",
                mode="no_online_executor",
                agent="platform",
                requires_target=False,
                reason="start_task requested but no online pentest node",
                message=(
                    "当前没有通过 WebSocket 在线连接的渗透节点（pentest.web）。"
                    "请确认 Node2 已连接平台后重试。"
                ),
            )
        return RoutingDecision(
            action="dispatch_node",
            capability=capability,
            mode=plan.mode or ("completed_followup" if context.conversation_status == "completed" else "new_task"),
            agent=agent if agent != "platform" else _agent_for_capability(capability) or "pentest",
            agent_node_id=plan.agent_node_id or context.requested_node_id or (pentest_online[0] if capability == "pentest.web" else None),
            requires_target=False,
            reason=plan.reason or "platform agent chose to start task",
            targets=targets,
        )

    raise OrchestrationError(f"Unsupported platform agent action: {plan.action}")


def _online_capability_nodes(context: OrchestrationContext, capability: str) -> list[str]:
    out: list[str] = []
    for item in context.capabilities or []:
        if item.online and str(item.capability or "") == capability and item.node_id:
            out.append(str(item.node_id))
    return out


def _claims_missing_executor(plan: AgentPlan) -> bool:
    blob = f"{plan.message or ''} {plan.reason or ''}".lower()
    needles = (
        "缺少",
        "没有",
        "unavailable",
        "not available",
        "no online",
        "无在线",
        "pentest.web",
        "等待",
        "上线",
        "platform.chat",
        "snapshot.qa",
    )
    # Message that lists only platform caps or claims pentest missing.
    if "platform.chat" in blob and ("pentest" in blob or "渗透" in f"{plan.message or ''}{plan.reason or ''}"):
        return True
    if any(n in blob for n in ("缺少", "unavailable", "not available", "无在线", "等待", "上线")) and (
        "pentest" in blob or "渗透" in f"{plan.message or ''}{plan.reason or ''}" or "agent" in blob
    ):
        return True
    return False


def _looks_like_execution_request(text: str, targets: list[str]) -> bool:
    if not targets:
        return False
    raw = str(text or "")
    # Long structured task briefs with a target are execution requests, not chat Q&A.
    if len(raw) >= 160:
        return True
    # Explicit authorization / task framing (product language, not engagement NLP routing).
    if re.search(r"授权|authorized|in[- ]scope|渗透|安全测试|闯关|扫描|复测|验证", raw, re.I):
        return True
    return False


def _should_force_pentest_dispatch(*, plan: AgentPlan, text: str, targets: list[str]) -> bool:
    if not targets:
        return False
    if _claims_missing_executor(plan):
        return True
    if plan.action == "summarize_results":
        return False
    # Planner chose platform-only path despite a clear execution brief + target.
    if plan.capability in {"", "platform.chat", "snapshot.qa"} and _looks_like_execution_request(text, targets):
        return True
    if plan.agent in {"", "platform"} and _looks_like_execution_request(text, targets) and plan.action == "answer_user":
        return True
    return False


def _planner_input(text: str, context: OrchestrationContext) -> dict:
    return {
        "user_message": text,
        "facts": {
            "conversation_status": context.conversation_status,
            "requested_agent": context.requested_agent,
            "requested_node_id": context.requested_node_id,
            "has_resume_task": context.has_resume_task,
            "has_bound_node": context.has_bound_node,
            "bound_node_id": context.bound_node_id,
        },
        "available_capabilities": [
            {
                "agent_type": item.agent_type,
                "capability": item.capability,
                "node_id": item.node_id,
                "name": item.name,
                "online": item.online,
            }
            for item in context.capabilities
        ],
        "output_schema": {
            "action": sorted(PLAN_ACTIONS),
            "capability": sorted(CAPABILITY_TO_AGENT.keys()),
            "agent": sorted(set(CAPABILITY_TO_AGENT.values())),
            "targets": ["zero or more URL/IP strings explicitly present or intended by the user"],
            "agent_node_id": "optional concrete node id",
            "mode": "optional UI/execution mode",
            "message": "optional clarification text",
            "reason": "short reason for the decision",
        },
    }


def _agent_plan_from_json(data: dict) -> AgentPlan:
    action = str(data.get("action") or "").strip()
    if action not in PLAN_ACTIONS:
        raise OrchestrationError(f"Platform agent returned invalid action: {action or '<empty>'}")
    targets = data.get("targets") or []
    if isinstance(targets, str):
        targets = [targets]
    if not isinstance(targets, list):
        raise OrchestrationError("Platform agent returned invalid targets; expected a list")
    return AgentPlan(
        action=action,
        capability=str(data.get("capability") or "").strip(),
        agent=str(data.get("agent") or "").strip(),
        targets=[target for target in (_clean_plan_target(item) for item in targets) if target],
        agent_node_id=str(data.get("agent_node_id") or "").strip() or None,
        mode=str(data.get("mode") or "").strip(),
        message=str(data.get("message") or "").strip(),
        reason=str(data.get("reason") or "").strip(),
    )



def _clean_plan_target(value: object) -> str:
    raw = str(value or "").strip().rstrip(".,;)")
    if not raw:
        return ""
    match = TARGET_RE.search(raw)
    if match and (raw.lower().startswith(("http://", "https://")) or match.start() == 0):
        return match.group(0).strip().rstrip(".,;)")
    return raw
def _parse_json_object(raw: str) -> dict:
    text = str(raw or "").strip()
    if not text:
        raise OrchestrationError("Platform agent returned an empty routing plan")
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", text, flags=re.S)
        if not match:
            raise OrchestrationError(f"Platform agent returned non-JSON routing plan: {text[:200]}")
        try:
            data = json.loads(match.group(0))
        except json.JSONDecodeError as exc:
            raise OrchestrationError(f"Platform agent returned invalid JSON routing plan: {exc}") from exc
    if not isinstance(data, dict):
        raise OrchestrationError("Platform agent routing plan must be a JSON object")
    return data


async def _chat(messages: list[dict]) -> str:
    try:
        if _chat_override:
            return await _chat_override(messages)
        return await _chat_with_openai(messages)
    except OrchestrationError:
        raise
    except Exception as exc:
        raise OrchestrationError(f"Platform agent LLM call failed: {str(exc)[:300]}") from exc


async def _chat_with_openai(messages: list[dict]) -> str:
    if not settings.LLM_API_KEY:
        raise OrchestrationError("LLM_API_KEY is not configured for platform agent orchestration")
    try:
        from openai import AsyncOpenAI
    except ImportError as exc:
        raise OrchestrationError("openai package is not installed in platform backend") from exc

    client = AsyncOpenAI(api_key=settings.LLM_API_KEY, base_url=settings.LLM_BASE_URL or None)
    response = await client.chat.completions.create(
        model=settings.LLM_MODEL,
        messages=messages,
        temperature=0,
        response_format={"type": "json_object"},
    )
    return response.choices[0].message.content or ""


def _agent_for_capability(capability: str) -> str:
    return CAPABILITY_TO_AGENT.get(str(capability or "").strip(), "")


def _normalize_agent(value: str | None) -> str | None:
    raw = str(value or "").strip().lower().replace("@", "")
    if raw in {"platform", "platform_agent", "platform agent"}:
        return "platform"
    if raw in {"pentest", "pentest_agent", "pentest agent", "security", "security_agent", "security agent"}:
        return "pentest"
    return raw or None


def _dedupe(values: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        item = str(value or "").strip()
        key = item.rstrip("/").lower()
        if not key or key in seen:
            continue
        seen.add(key)
        result.append(item)
    return result


ORCHESTRATOR_PROMPT = """You are the platform agent for a security testing platform.
Your job is to understand the user's intent and produce one JSON routing plan.

Do not execute security tests yourself. Choose whether to answer, ask for clarification,
start a task on a worker node, continue an existing task, or summarize saved results.

Rules:
- Return JSON only. No markdown, no prose outside JSON.
- Use action=start_task only when the user wants an agent node to perform work.
- Use action=answer_user when the user is asking the platform a general question.
- Use action=summarize_results when the user asks about saved findings/results/evidence.
- Use action=continue_task when the user wants to continue an unfinished/failed/incomplete task
  (e.g. short messages like 继续 / continue / resume) and facts.has_resume_task or facts.has_bound_node is true.
- Use action=ask_clarification when intent, target, or authorization is unclear.
- Do not invent targets. Only include targets present in facts or clearly supplied by the user.
- If multiple different targets are present, include all of them in targets; policy will decide.
- Select a capability from the provided available_capabilities list. Trust online=true entries.
- CRITICAL: If available_capabilities contains capability "pentest.web" with online=true, you MUST NOT
  claim that pentest is missing/unavailable. For authorized web testing / CTF / scan tasks with a
  target URL or IP, choose action=start_task, capability=pentest.web, agent=pentest, and put the
  target in targets.
- Only say no executor is available when pentest.web is absent or online=false in available_capabilities.

Return this JSON shape:
{
  "action": "answer_user | ask_clarification | start_task | continue_task | summarize_results",
  "capability": "platform.chat | snapshot.qa | pentest.web | baseline.check | remediation.advice | report.generate",
  "agent": "platform | pentest | baseline | remediation | report",
  "targets": [],
  "agent_node_id": null,
  "mode": "",
  "message": "",
  "reason": ""
}
"""
