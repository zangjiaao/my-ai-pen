"""Platform agent responses for orchestration, chat, and session Q&A."""
from __future__ import annotations

import json
import uuid
from typing import Awaitable, Callable

from sqlalchemy import select

from app.config import settings
import app.db.base as db_base
from app.models.conversation import Conversation
from app.models.message import Message
from app.services.conversation_snapshot import build_conversation_snapshot

ChatFn = Callable[[list[dict]], Awaitable[str]]
_chat_override: ChatFn | None = None


PLATFORM_CHAT_PROMPT = """你是安全测试平台的小助理，负责理解用户意图、编排任务、解释平台状态并把工作分配给合适的节点。
规则：
- 如果用户只是打招呼或询问平台能力，直接简洁回答。
- 如果用户想发起测试但缺少目标，提示用户提供 URL/IP 和授权范围。
- 不要声称已经执行了测试；真实测试由具体节点完成。
- 用中文回答，语气专业、直接。"""

SNAPSHOT_QA_PROMPT = """你是安全测试平台的小助理，正在基于当前会话已保存的消息、资产、漏洞、证据和 checkpoint 回答用户问题。
规则：
- 只基于提供的会话上下文回答。
- 不要声称重新测试了目标。
- 如果证据不足，直接说明缺少哪些证据。
- 可以总结风险、解释判断依据、给出整改建议或下一步验证建议。
- 用中文回答，保持简洁但足够可执行。"""

PENTEST_SNAPSHOT_PROMPT = """你是本次会话里的渗透 Agent。用户正在询问你已经执行过的测试过程、发现、证据或下一步建议。
规则：
- 只基于提供的会话上下文回答。
- 当前回复不能调用工具；不要声称重新测试了目标。
- 可以用第一人称解释此前判断依据、利用价值、风险排序和建议。
- 用中文回答。"""


def set_platform_agent_chat_override(chat: ChatFn | None) -> None:
    global _chat_override
    _chat_override = chat


async def answer_platform_chat(conv_id: str, user_id: str, question: str) -> dict:
    content = await _chat([
        {"role": "system", "content": PLATFORM_CHAT_PROMPT},
        {"role": "user", "content": str(question or "你好")},
    ])
    return _agent_text(conv_id, "platform", "platform_chat", content or "你好，我可以帮你分配测试任务、解释结果或整理整改建议。")


async def answer_snapshot_qa(conv_id: str, user_id: str, question: str, agent_source: str = "platform") -> dict:
    snapshot, recent_messages, missing = await _load_snapshot(conv_id, user_id)
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
        "findings": snapshot.get("findings"),
        "assets": snapshot.get("assets"),
        "evidence": snapshot.get("evidence"),
        "checkpoint": _compact_checkpoint(snapshot.get("checkpoint") or {}),
        "recent_messages": [_message_context(item) for item in recent_messages[-40:]],
    }
    content = await _chat([
        {"role": "system", "content": prompt},
        {"role": "user", "content": "当前会话持久化上下文：\n" + json.dumps(context, ensure_ascii=False, default=str)[:24000]},
        {"role": "user", "content": str(question or "请总结本次会话结果。")},
    ])
    return _agent_text(conv_id, normalized_agent, "snapshot_qa", content or "当前会话没有足够信息生成回答。")


async def answer_clarification(conv_id: str, message: str, *, mode: str = "clarification") -> dict:
    return _agent_text(conv_id, "platform", mode, message)


async def _load_snapshot(conv_id: str, user_id: str) -> tuple[dict, list[Message], bool]:
    async with db_base.async_session() as db:
        result = await db.execute(select(Conversation).where(Conversation.id == uuid.UUID(conv_id), Conversation.user_id == uuid.UUID(user_id)))
        conversation = result.scalar_one_or_none()
        if not conversation:
            return {}, [], True
        snapshot = await build_conversation_snapshot(db, conversation, uuid.UUID(user_id))
        recent_messages = (await db.execute(
            select(Message)
            .where(Message.conversation_id == conversation.id)
            .order_by(Message.created_at.desc(), Message.id.desc())
            .limit(80)
        )).scalars().all()
    return snapshot, list(reversed(recent_messages)), False


async def _chat(messages: list[dict]) -> str:
    try:
        return await (_chat_override(messages) if _chat_override else _chat_with_openai(messages))
    except Exception as exc:
        return f"LLM 调用失败，无法继续对话：{str(exc)[:300]}"


async def _chat_with_openai(messages: list[dict]) -> str:
    if not settings.LLM_API_KEY:
        raise RuntimeError("平台后端未配置 LLM_API_KEY。")
    try:
        from openai import AsyncOpenAI
    except ImportError as exc:
        raise RuntimeError("平台后端缺少 openai 依赖，请安装 backend requirements。") from exc

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


def _message_context(message: Message) -> dict:
    content = message.content or {}
    compact_content = content
    if isinstance(content, dict):
        compact_content = dict(content)
        stdout = compact_content.get("stdout")
        if isinstance(stdout, str) and len(stdout) > 1200:
            compact_content["stdout"] = stdout[:1200] + "...<truncated>"
    return {
        "role": message.role,
        "type": message.msg_type,
        "content": compact_content,
        "created_at": message.created_at.isoformat() if message.created_at else None,
    }


def _compact_checkpoint(checkpoint: dict) -> dict:
    if not isinstance(checkpoint, dict):
        return {}
    return {
        "phase": checkpoint.get("phase"),
        "phases_completed": checkpoint.get("phases_completed"),
        "candidate_findings": checkpoint.get("candidate_findings"),
        "confirmed_findings": checkpoint.get("confirmed_findings"),
        "discovered_assets": checkpoint.get("discovered_assets"),
    }
