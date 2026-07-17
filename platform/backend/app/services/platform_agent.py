"""Platform agent responses for orchestration, chat, and session Q&A."""
from __future__ import annotations

import json
import uuid
from typing import Awaitable, Callable

from sqlalchemy import select

from app.config import settings
import app.db.base as db_base
from app.models.conversation import Conversation
from app.services.conversation_snapshot import build_conversation_snapshot

ChatFn = Callable[[list[dict]], Awaitable[str]]
_chat_override: ChatFn | None = None


PLATFORM_CHAT_PROMPT = """\u4f60\u662f\u5b89\u5168\u6d4b\u8bd5\u5e73\u53f0\u7684\u5c0f\u52a9\u7406\uff0c\u8d1f\u8d23\u7406\u89e3\u7528\u6237\u610f\u56fe\u3001\u7f16\u6392\u4efb\u52a1\u3001\u89e3\u91ca\u5e73\u53f0\u72b6\u6001\u5e76\u628a\u5de5\u4f5c\u5206\u914d\u7ed9\u5408\u9002\u7684\u8282\u70b9\u3002
\u89c4\u5219\uff1a
- \u5982\u679c\u7528\u6237\u53ea\u662f\u6253\u62db\u547c\u6216\u8be2\u95ee\u5e73\u53f0\u80fd\u529b\uff0c\u76f4\u63a5\u7b80\u6d01\u56de\u7b54\u3002
- \u5982\u679c\u7528\u6237\u60f3\u53d1\u8d77\u6d4b\u8bd5\u4f46\u7f3a\u5c11\u76ee\u6807\uff0c\u63d0\u793a\u7528\u6237\u63d0\u4f9b URL/IP \u548c\u6388\u6743\u8303\u56f4\u3002
- \u4e0d\u8981\u58f0\u79f0\u5df2\u7ecf\u6267\u884c\u4e86\u6d4b\u8bd5\uff1b\u771f\u5b9e\u6d4b\u8bd5\u7531\u5177\u4f53\u8282\u70b9\u5b8c\u6210\u3002
- \u7528\u4e2d\u6587\u56de\u7b54\uff0c\u8bed\u6c14\u4e13\u4e1a\u3001\u76f4\u63a5\u3002"""

SNAPSHOT_QA_PROMPT = """\u4f60\u662f\u5b89\u5168\u6d4b\u8bd5\u5e73\u53f0\u7684\u5c0f\u52a9\u7406\uff0c\u6b63\u5728\u57fa\u4e8e\u5f53\u524d\u4f1a\u8bdd Session Snapshot \u56de\u7b54\u7528\u6237\u95ee\u9898\u3002
\u89c4\u5219\uff1a
- \u53ea\u57fa\u4e8e\u63d0\u4f9b\u7684 Session Snapshot \u56de\u7b54\u3002
- \u4e0d\u8981\u58f0\u79f0\u91cd\u65b0\u6d4b\u8bd5\u4e86\u76ee\u6807\u3002
- \u5982\u679c\u8bc1\u636e\u4e0d\u8db3\uff0c\u76f4\u63a5\u8bf4\u660e\u7f3a\u5c11\u54ea\u4e9b\u8bc1\u636e\u3002
- \u53ef\u4ee5\u603b\u7ed3\u98ce\u9669\u3001\u89e3\u91ca\u5224\u65ad\u4f9d\u636e\u3001\u7ed9\u51fa\u6574\u6539\u5efa\u8bae\u6216\u4e0b\u4e00\u6b65\u9a8c\u8bc1\u5efa\u8bae\u3002
- \u7528\u4e2d\u6587\u56de\u7b54\uff0c\u4fdd\u6301\u7b80\u6d01\u4f46\u8db3\u591f\u53ef\u6267\u884c\u3002"""

PENTEST_SNAPSHOT_PROMPT = """\u4f60\u662f\u672c\u6b21\u4f1a\u8bdd\u91cc\u7684\u6e17\u900f Agent\u3002\u7528\u6237\u6b63\u5728\u8be2\u95ee\u4f60\u5df2\u7ecf\u6267\u884c\u8fc7\u7684\u6d4b\u8bd5\u8fc7\u7a0b\u3001\u53d1\u73b0\u3001\u8bc1\u636e\u6216\u4e0b\u4e00\u6b65\u5efa\u8bae\u3002
\u89c4\u5219\uff1a
- \u53ea\u57fa\u4e8e\u63d0\u4f9b\u7684 Session Snapshot \u56de\u7b54\u3002
- \u5f53\u524d\u56de\u590d\u4e0d\u80fd\u8c03\u7528\u5de5\u5177\uff1b\u4e0d\u8981\u58f0\u79f0\u91cd\u65b0\u6d4b\u8bd5\u4e86\u76ee\u6807\u3002
- \u53ef\u4ee5\u7528\u7b2c\u4e00\u4eba\u79f0\u89e3\u91ca\u6b64\u524d\u5224\u65ad\u4f9d\u636e\u3001\u5229\u7528\u4ef7\u503c\u3001\u98ce\u9669\u6392\u5e8f\u548c\u5efa\u8bae\u3002
- \u7528\u4e2d\u6587\u56de\u7b54\u3002"""

# Harness steering only — the model must author the actual user-visible wording.
# Never paste a canned greeting; each reply is generated for the current turn.
EXPERT_ROOM_CHAT_PROMPT = """You are the selected product expert in a shared security-testing room.
Speak in first person as that expert persona (use the given display name when natural).

Runtime facts for this turn (not user-visible script):
- The user has selected you, but has not yet provided an authorized target URL/IP or scope for execution.
- This turn is conversation only: no scan, recon, tools, or task lifecycle has started.
- Do not claim you already started testing, opened a work burst, or produced findings.
- If the user greets or chats without a target, respond naturally and invite them to share authorized target/scope when ready.
- Match the user's language. Be concise and professional. Vary wording across turns; do not repeat identical boilerplate.
- Do not invent hosts, vulnerabilities, or progress.

Output only the reply the user should see — no JSON, no system notes."""


def set_platform_agent_chat_override(chat: ChatFn | None) -> None:
    global _chat_override
    _chat_override = chat


async def answer_platform_chat(conv_id: str, user_id: str, question: str) -> dict:
    content = await _chat([
        {"role": "system", "content": PLATFORM_CHAT_PROMPT},
        {"role": "user", "content": str(question or "\u4f60\u597d")},
    ])
    return _agent_text(conv_id, "platform", "platform_chat", content or "\u4f60\u597d\uff0c\u6211\u53ef\u4ee5\u5e2e\u4f60\u5206\u914d\u6d4b\u8bd5\u4efb\u52a1\u3001\u89e3\u91ca\u7ed3\u679c\u6216\u6574\u7406\u6574\u6539\u5efa\u8bae\u3002")


async def answer_snapshot_qa(conv_id: str, user_id: str, question: str, agent_source: str = "platform") -> dict:
    snapshot, missing = await _load_snapshot(conv_id, user_id)
    if missing:
        return {"type": "task_error", "conversation_id": conv_id, "message": "Conversation not found or access denied."}

    normalized_agent = "pentest" if agent_source == "pentest" else "platform"
    prompt = PENTEST_SNAPSHOT_PROMPT if normalized_agent == "pentest" else SNAPSHOT_QA_PROMPT
    context = {
        "conversation": snapshot.get("conversation"),
        "counts": snapshot.get("counts"),
        "agent_state": snapshot.get("agent_state"),
        "progress": snapshot.get("progress"),
        "todos": snapshot.get("todos"),
        "task_context": snapshot.get("task_context"),
        "plan_tree": snapshot.get("plan_tree"),
        "attack_surface": snapshot.get("attack_surface"),
        "coverage": snapshot.get("coverage"),
        "captured_traffic": snapshot.get("captured_traffic"),
        "findings": snapshot.get("findings"),
        "assets": snapshot.get("assets"),
        "evidence": snapshot.get("evidence"),
        "checkpoint": _compact_checkpoint(snapshot.get("checkpoint") or {}),
        "messages": (snapshot.get("messages") or [])[-40:],
        "agents": snapshot.get("agents"),
        "omitted": snapshot.get("omitted"),
    }
    content = await _chat([
        {"role": "system", "content": prompt},
        {"role": "user", "content": "\u5f53\u524d\u4f1a\u8bdd Session Snapshot:\n" + json.dumps(context, ensure_ascii=False, default=str)[:24000]},
        {"role": "user", "content": str(question or "\u8bf7\u603b\u7ed3\u672c\u6b21\u4f1a\u8bdd\u7ed3\u679c\u3002")},
    ])
    return _agent_text(conv_id, normalized_agent, "snapshot_qa", content or "\u5f53\u524d\u4f1a\u8bdd\u6ca1\u6709\u8db3\u591f\u4fe1\u606f\u751f\u6210\u56de\u7b54\u3002")


async def answer_clarification(
    conv_id: str,
    message: str,
    *,
    mode: str = "clarification",
    agent_source: str = "platform",
) -> dict:
    normalized_agent = "pentest" if agent_source == "pentest" else "platform"
    return _agent_text(conv_id, normalized_agent, mode, message)


async def answer_expert_room_chat(
    conv_id: str,
    text: str,
    *,
    expert_name: str,
    expert_id: str | None = None,
    engagement: str | None = None,
    recent_turns: list[dict] | None = None,
) -> dict:
    """LLM-authored expert room reply when no authorized target is present yet.

    The model writes the user-visible text. Platform only supplies persona +
    harness constraints (no task, no forged scan claims).
    """
    who = str(expert_name or "").strip().lstrip("@") or "专家"
    eng = str(engagement or "").strip() or None
    facts = {
        "expert_display_name": who,
        "expert_id": expert_id,
        "engagement": eng,
        "authorized_target_present": False,
        "user_message": str(text or "").strip(),
    }
    messages: list[dict] = [
        {"role": "system", "content": EXPERT_ROOM_CHAT_PROMPT},
        {
            "role": "user",
            "content": "Turn context (JSON):\n" + json.dumps(facts, ensure_ascii=False, default=str),
        },
    ]
    for turn in recent_turns or []:
        role = str(turn.get("role") or "").strip()
        content = str(turn.get("content") or "").strip()
        if role in {"user", "assistant"} and content:
            messages.append({"role": role, "content": content})
    messages.append({"role": "user", "content": str(text or "").strip() or "你好"})

    content = await _chat(messages)
    # Honest failure only — never substitute a canned expert monologue.
    if not str(content or "").strip() or str(content).startswith("LLM call failed"):
        body = str(content or "").strip() or "模型暂时无法生成回复，请稍后重试。"
        return _agent_text(conv_id, "pentest", "expert_room_chat", body)

    answer = _agent_text(conv_id, "pentest", "expert_room_chat", content)
    if isinstance(answer.get("content"), dict):
        answer["content"]["expert_name"] = who
        if expert_id:
            answer["content"]["expert_id"] = str(expert_id)
    return answer


async def _load_snapshot(conv_id: str, user_id: str) -> tuple[dict, bool]:
    async with db_base.async_session() as db:
        result = await db.execute(select(Conversation).where(Conversation.id == uuid.UUID(conv_id), Conversation.user_id == uuid.UUID(user_id)))
        conversation = result.scalar_one_or_none()
        if not conversation:
            return {}, True
        snapshot = await build_conversation_snapshot(db, conversation, uuid.UUID(user_id))
    return snapshot, False


async def _chat(messages: list[dict]) -> str:
    try:
        return await (_chat_override(messages) if _chat_override else _chat_with_openai(messages))
    except Exception as exc:
        return f"LLM call failed, unable to continue conversation: {str(exc)[:300]}"


async def _chat_with_openai(messages: list[dict]) -> str:
    if not settings.LLM_API_KEY:
        raise RuntimeError("Platform backend is missing LLM_API_KEY.")
    try:
        from openai import AsyncOpenAI
    except ImportError as exc:
        raise RuntimeError("Platform backend is missing openai dependency. Install backend requirements.") from exc

    client = AsyncOpenAI(api_key=settings.LLM_API_KEY, base_url=settings.LLM_BASE_URL or None)
    response = await client.chat.completions.create(
        model=settings.LLM_MODEL,
        messages=messages,
        temperature=0.2,
    )
    return response.choices[0].message.content or ""


def _agent_text(conv_id: str, agent_source: str, agent_mode: str, content: str) -> dict:
    text = str(content or "").strip()
    return {
        "type": "text",
        "conversation_id": conv_id,
        "agent_source": agent_source,
        "agent_mode": agent_mode,
        "content": {"text": text, "agent_source": agent_source, "agent_mode": agent_mode},
    }


def _compact_checkpoint(checkpoint: dict) -> dict:
    if not isinstance(checkpoint, dict):
        return {}
    kanban = checkpoint.get("kanban") if isinstance(checkpoint.get("kanban"), dict) else {}
    return {
        "workflow_kind": checkpoint.get("workflow_kind") or kanban.get("workflow_kind"),
        "workflow_stage": checkpoint.get("workflow_stage") or kanban.get("current_stage"),
        "kanban": kanban,
        "candidate_findings": checkpoint.get("candidate_findings"),
        "confirmed_findings": checkpoint.get("confirmed_findings"),
        "discovered_assets": checkpoint.get("discovered_assets"),
    }
