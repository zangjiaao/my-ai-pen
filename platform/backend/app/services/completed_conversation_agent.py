"""Conversation Q&A for completed pentest sessions."""
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


PLATFORM_SYSTEM_PROMPT = """你是安全测试平台里的平台 Agent。
用户正在询问一个平台会话，可能是任务完成后的追问，也可能是任务执行过程中的结果解释。

回答规则：
- 只基于提供的会话消息、资产、漏洞、证据和 checkpoint 回答。
- 你不调用渗透工具，不声称重新测试了目标，不编造数据库里没有的漏洞或证据。
- 可以解释判断依据、利用价值、风险排序、下一步人工验证建议。
- 如果信息不足，直接说明缺少哪些证据。
- 用中文回答，保持简洁但要能帮助安全人员决策。"""


PENTEST_SYSTEM_PROMPT = """你是本次会话里的渗透 Agent。
用户正在询问你已经执行过的测试过程、发现、证据或下一步建议。

回答规则：
- 只基于提供的会话消息、资产、漏洞、证据和 checkpoint 回答。
- 当前这次回复不能调用工具；如果用户要求继续测试，说明需要在会话中发起继续测试或新任务。
- 不要声称重新测试了目标，不要编造数据库里没有的漏洞或证据。
- 可以用第一人称解释你此前的判断依据、利用价值、风险排序和建议。
- 用中文回答，保持简洁但要能帮助安全人员决策。"""


def set_completed_conversation_chat_override(chat: ChatFn | None) -> None:
    """Test hook for deterministic completed-session Q&A."""
    global _chat_override
    _chat_override = chat


async def answer_completed_conversation(conv_id: str, user_id: str, question: str, agent_source: str = "platform") -> dict:
    async with db_base.async_session() as db:
        result = await db.execute(select(Conversation).where(Conversation.id == uuid.UUID(conv_id), Conversation.user_id == uuid.UUID(user_id)))
        conversation = result.scalar_one_or_none()
        if not conversation:
            return {"type": "task_error", "conversation_id": conv_id, "message": "会话不存在或无权访问。"}
        snapshot = await build_conversation_snapshot(db, conversation, uuid.UUID(user_id))
        recent_messages = (await db.execute(
            select(Message)
            .where(Message.conversation_id == conversation.id)
            .order_by(Message.created_at.desc(), Message.id.desc())
            .limit(80)
        )).scalars().all()

    normalized_agent = "pentest" if agent_source == "pentest" else "platform"
    messages = _build_prompt_messages(question, snapshot, list(reversed(recent_messages)), normalized_agent)
    try:
        content = await (_chat_override(messages) if _chat_override else _chat_with_openai(messages))
    except Exception as exc:
        content = f"LLM 调用失败，无法继续对话：{str(exc)[:300]}"
    return {
        "type": "text",
        "conversation_id": conv_id,
        "agent_source": normalized_agent,
        "agent_mode": "snapshot_qa",
        "content": {"text": content.strip() or "我没有生成有效回答。", "agent_source": normalized_agent, "agent_mode": "snapshot_qa"},
    }


def _build_prompt_messages(question: str, snapshot: dict, recent_messages: list[Message], agent_source: str) -> list[dict]:
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
    return [
        {"role": "system", "content": _system_prompt(agent_source)},
        {"role": "user", "content": "以下是当前已完成会话的持久化上下文：\n" + json.dumps(context, ensure_ascii=False, default=str)[:24000]},
        {"role": "user", "content": str(question or "请总结本次会话结果。")},
    ]


def _system_prompt(agent_source: str) -> str:
    return PENTEST_SYSTEM_PROMPT if agent_source == "pentest" else PLATFORM_SYSTEM_PROMPT

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


async def _chat_with_openai(messages: list[dict]) -> str:
    if not settings.LLM_API_KEY:
        raise RuntimeError("平台后端未配置 LLM_API_KEY，无法进行完成会话后的 Agent 对话。")
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