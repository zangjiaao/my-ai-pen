import json
import hashlib
import re
import uuid
from datetime import datetime, timezone
from urllib.parse import urlparse

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect
from sqlalchemy import select

from app.services.conversation_state import ConversationStatusError, transition_conversation
from app.services.agent_router import extract_target, extract_targets
from app.services.agent_orchestrator import AgentCapability, OrchestrationContext, OrchestrationError, route_with_platform_agent
from app.services.platform_agent import (
    answer_clarification,
    answer_expert_room_chat,
    answer_platform_chat,
    answer_snapshot_qa,
)
from app.services.conversation_snapshot import build_conversation_snapshot
from app.services.expert_offers import (
    ACTION_USAGE,
    dispatch_gate_error,
    engagement_from_task_message,
    normalize_pack_id,
    usage_billing_detail,
)
from app.services.expert_instances import match_expert_by_mention_token
from app.models.node import PLATFORM_AGENT_NODE_ID

router = APIRouter()

node_connections: dict[str, WebSocket] = {}
conversation_subscribers: dict[str, set[WebSocket]] = {}
conversation_node: dict[str, str] = {}
pending_approvals: dict[str, dict] = {}
_round_robin_counter: int = 0

FOLLOW_UP_ACTION_RE = re.compile(
    "\u786e\u8ba4|\u68c0\u67e5|\u67e5\u770b|\u8bbf\u95ee|\u6253\u5f00|\u590d\u6d4b|\u91cd\u6d4b|\u91cd\u65b0\u6d4b|"
    "\u7ee7\u7eed\u6d4b|\u7ee7\u7eed|\u63a5\u7740|\u91cd\u8bd5|\u518d\u8bd5|"
    "\u9a8c\u8bc1|\u8bf7\u6c42|\u6293\u53d6|\u767b\u5f55|\u770b\u4e00\u4e0b|"
    r"\b(check|confirm|verify|retest|rerun|resume|continue|retry|visit|open|fetch|request|scan|test|login)\b",
    re.IGNORECASE,
)

# Short user messages that mean "resume the previous task" after failed/incomplete.
CONTINUE_REQUEST_RE = re.compile(
    r"^\s*(继续|接着|接着做|接着测|继续测|继续扫描|重试|再试|resume|continue|retry)\s*[。.!！？?]*\s*$",
    re.IGNORECASE,
)
# Unicode-aware mention tokens (Chinese expert names, Latin node names, _ . : -).
NODE_MENTION_RE = re.compile(r"@([\w.:-]{1,128})", re.UNICODE)


def _uuid(value: str | uuid.UUID | None) -> uuid.UUID | None:
    if not value:
        return None
    if isinstance(value, uuid.UUID):
        return value
    try:
        return uuid.UUID(str(value))
    except ValueError:
        return None


def _clean_evidence_ids(value) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item).strip() for item in value if str(item).strip()]


def _asset_address(value: object) -> str:
    raw = str(value or "").strip().strip("'\"")
    if not raw:
        return "unknown"

    url_match = re.search(r"https?://[^\s,;)\]}>'\"]+", raw, flags=re.IGNORECASE)
    if url_match:
        raw = url_match.group(0).rstrip("/.")
    else:
        host_match = re.search(
            r"(?:\b(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}|\blocalhost\b|\bhost\.docker\.internal\b|\b(?:\d{1,3}\.){3}\d{1,3}\b)(?::\d{1,5})?",
            raw,
            flags=re.IGNORECASE,
        )
        if host_match:
            raw = host_match.group(0).rstrip("/.")

    parsed = urlparse(raw if "://" in raw else f"//{raw}")
    if parsed.hostname:
        scheme = parsed.scheme if "://" in raw and parsed.scheme in {"http", "https"} else ""
        host = parsed.hostname
        try:
            port_value = parsed.port
        except ValueError:
            port_value = None
        port = f":{port_value}" if port_value else ""
        return f"{scheme + '://' if scheme else ''}{host}{port}"
    return raw.rstrip("/")


def _finding_audit_action(
    *,
    created: bool,
    rediscovered: bool = False,
    raw_status: str,
    stored_status: str,
) -> str:
    raw = str(raw_status or "").lower()
    if rediscovered:
        return "finding.rediscover"
    if raw == "confirmed" or stored_status in {"confirmed", "to_fix"}:
        return "finding.confirm" if created else "finding.update"
    if raw in {"rejected", "false_positive"}:
        return "finding.reject"
    return "finding.create" if created else "finding.update"


def _target_address_from_context(context: object) -> str:
    if not isinstance(context, dict):
        return "unknown"
    task = context.get("task") if isinstance(context.get("task"), dict) else {}
    checkpoint = context.get("checkpoint") if isinstance(context.get("checkpoint"), dict) else {}
    for source in (task, checkpoint):
        target = source.get("target") if isinstance(source.get("target"), dict) else {}
        value = target.get("value") or source.get("target_url") or source.get("target")
        address = _asset_address(value)
        if address != "unknown":
            return address
    return "unknown"


def _merge_status(current: str | None, incoming: str | None) -> str:
    rank = {
        "false_positive": 0,
        "pending": 1,
        "accepted": 2,
        "confirmed": 3,
        "reported": 4,
        "fixed": 5,
    }
    current_value = current or "pending"
    incoming_value = incoming or "pending"
    return incoming_value if rank.get(incoming_value, 1) >= rank.get(current_value, 1) else current_value


def _normalize_severity(value: object) -> str:
    severity = str(value or "medium").strip().lower()
    return severity if severity in {"critical", "high", "medium", "low", "info"} else "medium"


# Agent/runtime events belong in the conversation timeline, not the platform audit ledger.
# Keep node.online / node.offline for connectivity sparklines.
_AUDIT_SKIP_ACTIONS = frozenset({
    "tool.execute",
    "evidence.create",
    "asset.discover",
    "task.assign",
    "user_steer",
    "approval.request",
})


def _should_skip_runtime_audit(action: str) -> bool:
    a = str(action or "")
    if a in _AUDIT_SKIP_ACTIONS:
        return True
    if a.startswith("finding."):
        return True
    if a.startswith("approval."):
        return True
    # Unknown free-form message types from the WS path (not platform CRUD).
    if a in {"user_interrupt", "user_input"}:
        return True
    return False


async def _audit(
    *,
    actor_type: str,
    actor_id: uuid.UUID,
    action: str,
    status: str = "success",
    resource_type: str | None = None,
    resource_id: uuid.UUID | None = None,
    conversation_id: uuid.UUID | None = None,
    detail: dict | None = None,
):
    if _should_skip_runtime_audit(action):
        return
    try:
        from app.db.base import async_session
        from app.models.audit import AuditLog

        async with async_session() as db:
            db.add(AuditLog(
                actor_type=actor_type,
                actor_id=actor_id,
                action=action,
                resource_type=resource_type,
                resource_id=resource_id,
                conversation_id=conversation_id,
                detail=detail or {},
                status=status,
            ))
            await db.commit()
    except Exception as e:
        print(f"[WS] audit error: {e}")


async def _conversation_owner(conv_id: str) -> tuple[uuid.UUID | None, uuid.UUID | None]:
    try:
        from app.db.base import async_session
        from app.models.conversation import Conversation

        async with async_session() as db:
            r = await db.execute(select(Conversation).where(Conversation.id == uuid.UUID(conv_id)))
            c = r.scalar_one_or_none()
            if not c:
                return None, None
            return c.user_id, c.node_id
    except Exception:
        return None, None


async def _conversation_context(conv_id: str) -> dict:
    try:
        from app.db.base import async_session
        from app.models.conversation import Conversation

        async with async_session() as db:
            r = await db.execute(select(Conversation).where(Conversation.id == uuid.UUID(conv_id)))
            c = r.scalar_one_or_none()
            if not c or not isinstance(c.context, dict):
                return {}
            return dict(c.context or {})
    except Exception:
        return {}


async def _update_node_status(node_id: str, status: str, ip: str | None = None):
    """Update node online/offline. Only audit real transitions (for connectivity bars).

    Never mark offline while a live websocket is still registered for this node —
    reconnect races used to log false offline events and paint the 24h strip red.
    """
    try:
        from app.db.base import async_session
        from app.models.node import Node

        # Guard: another (newer) socket may already own this node.
        if status == "offline" and node_id in node_connections:
            return

        async with async_session() as db:
            result = await db.execute(select(Node).where(Node.id == uuid.UUID(node_id)))
            node = result.scalar_one_or_none()
            if not node:
                return
            prev = str(node.status or "").strip().lower()
            next_status = str(status or "").strip().lower()
            changed = prev != next_status

            node.status = status
            if next_status == "offline":
                node.current_sessions = 0
            node.last_heartbeat = datetime.now(timezone.utc)
            if ip:
                node.ip = ip
            await db.commit()

            # Connectivity sparkline is driven by these audit events — only emit on change.
            if changed and next_status in {"online", "offline"}:
                await _audit(
                    actor_type="node",
                    actor_id=uuid.UUID(node_id),
                    action=f"node.{next_status}",
                    resource_type="node",
                    resource_id=uuid.UUID(node_id),
                )
    except Exception as e:
        print(f"[WS] _update_node_status error: {e}")


async def revoke_node_connection(node_id: str, reason: str = "node revoked"):
    ws = node_connections.pop(node_id, None)
    for conv_id, bound_node_id in list(conversation_node.items()):
        if bound_node_id == node_id:
            del conversation_node[conv_id]
    if ws:
        try:
            await ws.close(code=4001, reason=reason[:120])
        except Exception:
            pass
    await _update_node_status(node_id, "offline")

async def _bind_conversation_to_node(conv_id: str, node_id: str, *, active_task_id: str | None = None):
    try:
        from app.db.base import async_session
        from app.models.conversation import Conversation
        from app.models.node import Node

        async with async_session() as db:
            r = await db.execute(select(Conversation).where(Conversation.id == uuid.UUID(conv_id)))
            c = r.scalar_one_or_none()
            if c:
                c.node_id = uuid.UUID(node_id)
                transition_conversation(c, "running")
                # Track active worker task so late task_complete from a prior burst
                # cannot flip a new run back to incomplete.
                if active_task_id:
                    context = dict(c.context or {})
                    context["active_task_id"] = str(active_task_id)
                    c.context = context
                node_result = await db.execute(select(Node).where(Node.id == uuid.UUID(node_id)))
                node = node_result.scalar_one_or_none()
                if node:
                    node.config = {**(node.config or {}), "last_failure_reason": None}
                await db.commit()
                conversation_node[conv_id] = node_id
                await _audit(
                    actor_type="system",
                    actor_id=uuid.UUID(node_id),
                    action="task.assign",
                    resource_type="conversation",
                    resource_id=uuid.UUID(conv_id),
                    conversation_id=uuid.UUID(conv_id),
                    detail={"node_id": node_id, "task_id": active_task_id},
                )
    except Exception as e:
        print(f"[WS] bind conversation error: {e}")


async def _set_conversation_status(conv_id: str, status: str) -> bool:
    try:
        from app.db.base import async_session
        from app.models.conversation import Conversation

        async with async_session() as db:
            r = await db.execute(select(Conversation).where(Conversation.id == uuid.UUID(conv_id)))
            c = r.scalar_one_or_none()
            if not c:
                return False
            try:
                transition_conversation(c, status)
            except ConversationStatusError as e:
                print(f"[WS] conversation status transition ignored: {e}")
                return False
            await db.commit()
            return True
    except Exception as e:
        print(f"[WS] set conversation status error: {e}")
        return False


def _workers_from_context(context: dict | None) -> dict[str, dict]:
    raw = (context or {}).get("workers") if isinstance(context, dict) else None
    if not isinstance(raw, dict):
        return {}
    out: dict[str, dict] = {}
    for key, value in raw.items():
        node_id = str(key or "").strip()
        if not node_id:
            continue
        if isinstance(value, dict):
            out[node_id] = dict(value)
        else:
            out[node_id] = {"task_id": str(value or "")}
    return out


async def _apply_worker_state(
    conv_id: str,
    *,
    node_id: str | None = None,
    working: bool = False,
    task_id: object = None,
    expert_id: object = None,
    expert_name: object = None,
    reason: object = None,
    interrupt_pending: bool | None = None,
    clear_all_workers: bool = False,
) -> dict:
    """
    Track per-node work-bursts for a conversation.

    Source of truth for "is an expert working on this session" — driven by Node4
    busy set via work_status, and by bind/task_complete as backup.
    Returns a conversation_working payload for UI subscribers.
    """
    empty = {
        "type": "conversation_working",
        "conversation_id": conv_id,
        "working": False,
        "status": "created",
        "workers": [],
        "interrupting": False,
    }
    if not conv_id:
        return empty
    try:
        from app.db.base import async_session
        from app.models.conversation import Conversation

        async with async_session() as db:
            r = await db.execute(select(Conversation).where(Conversation.id == uuid.UUID(conv_id)))
            c = r.scalar_one_or_none()
            if not c:
                return empty
            context = dict(c.context or {})
            workers = _workers_from_context(context)
            nid = str(node_id or "").strip()
            tid = str(task_id or "").strip()
            if clear_all_workers:
                workers = {}
            elif nid:
                if working:
                    entry = dict(workers.get(nid) or {})
                    if tid:
                        entry["task_id"] = tid
                    if expert_id is not None and str(expert_id).strip():
                        entry["expert_id"] = str(expert_id).strip()
                    if expert_name is not None and str(expert_name).strip():
                        entry["expert_name"] = str(expert_name).strip()
                    entry["since"] = entry.get("since") or datetime.now(timezone.utc).isoformat()
                    workers[nid] = entry
                    if tid:
                        context["active_task_id"] = tid
                else:
                    existing = workers.get(nid)
                    existing_tid = str((existing or {}).get("task_id") or "").strip()
                    # Only drop when task matches or task id unknown (stale clear OK).
                    if not tid or not existing_tid or existing_tid == tid:
                        workers.pop(nid, None)
            context["workers"] = workers
            if interrupt_pending is True:
                context["interrupt_pending"] = True
            elif interrupt_pending is False or (not workers and context.get("interrupt_pending")):
                context.pop("interrupt_pending", None)

            active = bool(workers)
            interrupting = bool(context.get("interrupt_pending")) and active
            current = str(c.status or "created").strip().lower()
            reason_text = str(reason or "").strip().lower()

            if active:
                try:
                    transition_conversation(c, "running")
                except ConversationStatusError:
                    pass
            elif current == "running" and reason_text in {
                "interrupted", "not_busy", "canceled", "cancel", "interrupt"
            }:
                # All experts idle after interrupt — settle session.
                try:
                    transition_conversation(c, "canceled")
                except ConversationStatusError:
                    try:
                        transition_conversation(c, "incomplete")
                    except ConversationStatusError:
                        pass

            c.context = context
            await db.commit()
            await db.refresh(c)

            status = str(c.status or "created")
            worker_list = [
                {
                    "node_id": wid,
                    "task_id": (meta or {}).get("task_id"),
                    "expert_id": (meta or {}).get("expert_id"),
                    "expert_name": (meta or {}).get("expert_name"),
                }
                for wid, meta in workers.items()
            ]
            return {
                "type": "conversation_working",
                "conversation_id": conv_id,
                "working": active,
                "status": status,
                "workers": worker_list,
                "interrupting": interrupting,
                "node_id": nid or None,
                "task_id": tid or None,
                "reason": str(reason or "") or None,
            }
    except Exception as e:
        print(f"[WS] apply worker state error: {e}")
        return empty


async def _broadcast_conversation_working(payload: dict) -> None:
    conv_id = str(payload.get("conversation_id") or "").strip()
    if not conv_id or not payload:
        return
    await _broadcast_to_conversation(conv_id, json.dumps(payload, ensure_ascii=False))


async def _interrupt_all_session_workers(conv_id: str, raw_msg: dict) -> dict:
    """
    Fan-out user_interrupt to every node that is (or may be) working this session.

    Includes tracked workers, bound node, and in-memory conversation_node map.
    """
    targets: set[str] = set()
    bound = conversation_node.get(conv_id)
    if bound:
        targets.add(str(bound))
    try:
        from app.db.base import async_session
        from app.models.conversation import Conversation

        async with async_session() as db:
            r = await db.execute(select(Conversation).where(Conversation.id == uuid.UUID(conv_id)))
            c = r.scalar_one_or_none()
            if c:
                if c.node_id:
                    targets.add(str(c.node_id))
                for wid in _workers_from_context(c.context if isinstance(c.context, dict) else {}):
                    targets.add(wid)
    except Exception as e:
        print(f"[WS] interrupt target resolve error: {e}")

    payload = {
        **raw_msg,
        "type": "user_interrupt",
        "conversation_id": conv_id,
    }
    raw = json.dumps(payload, ensure_ascii=False)
    sent_to: list[str] = []
    for node_id in targets:
        if node_id in node_connections:
            try:
                await node_connections[node_id].send_text(raw)
                sent_to.append(node_id)
            except Exception as e:
                print(f"[WS] interrupt send to {node_id[:8]} failed: {e}")
    return {"sent_to": sent_to, "targets": sorted(targets)}


def _terminal_status_from_task_message(msg: dict) -> str:
    """Map node task_complete/task_error payload to conversation status."""
    if msg.get("type") == "task_error":
        return "failed"
    status = str(msg.get("status") or "").strip().lower()
    if status in {"incomplete", "blocked"}:
        return "incomplete"
    return "completed"


async def _settle_running_conversations_for_node(node_id: str, reason: str = "node_offline") -> int:
    """When a node disconnects, stop timers on conversations still marked running."""
    if not node_id:
        return 0
    settled = 0
    try:
        from app.db.base import async_session
        from app.models.conversation import Conversation

        async with async_session() as db:
            result = await db.execute(
                select(Conversation).where(
                    Conversation.node_id == uuid.UUID(str(node_id)),
                    Conversation.status == "running",
                )
            )
            rows = list(result.scalars().all())
            for conv in rows:
                try:
                    transition_conversation(conv, "incomplete")
                    settled += 1
                except ConversationStatusError:
                    continue
            if settled:
                await db.commit()
        if settled:
            print(f"[WS] settled {settled} running conversation(s) for node {node_id[:8]} ({reason})")
    except Exception as e:
        print(f"[WS] settle running conversations error: {e}")
    return settled


async def _handle_node_message(ws: WebSocket, client_id: str | None, msg: dict, conv_id: str | None) -> None:
    """Process one agent-node websocket message. Must not raise into the receive loop."""
    if conv_id:
        msg["agent_source"] = "pentest"
        msg["agent_node_id"] = client_id
        # Attach sticky product expert so UI shows persona, not physical node name.
        sticky_id, sticky_name = await _conversation_expert_label(conv_id)
        if sticky_id and not str(msg.get("expert_id") or "").strip():
            msg["expert_id"] = sticky_id
        if sticky_name and not str(msg.get("expert_name") or "").strip():
            msg["expert_name"] = sticky_name

    # Pi work-burst lifecycle (not a chat message). Updates session workers SOT
    # and pushes conversation_working so the UI send/interrupt button stays honest.
    if msg.get("type") == "work_status" and conv_id:
        working_raw = msg.get("working")
        if working_raw is None:
            working_raw = msg.get("busy")
        working = working_raw is True or str(working_raw).strip().lower() in {"1", "true", "yes"}
        payload = await _apply_worker_state(
            conv_id,
            node_id=client_id,
            working=working,
            task_id=msg.get("task_id"),
            expert_id=msg.get("expert_id"),
            expert_name=msg.get("expert_name"),
            reason=msg.get("reason"),
        )
        await _broadcast_conversation_working(payload)
        return

    # Settle conversation status before heavy persistence so a large checkpoint
    # or plan_tree failure cannot leave the session running forever.
    # Terminal channel is task_complete (status=completed|incomplete|blocked).
    # task_incomplete is legacy-only: settle status but do not touch session counts
    # (old dual-send pairs already decrement once on the following task_complete).
    if msg.get("type") in ("task_complete", "task_error"):
        # Drop stale terminal events from a previous work burst after a re-dispatch.
        if conv_id and not await _is_active_task_event(conv_id, msg.get("task_id")):
            print(
                f"[WS] ignore stale {msg.get('type')} task_id={msg.get('task_id')} "
                f"for conv={str(conv_id)[:8]}"
            )
        else:
            if msg.get("type") == "task_error":
                await _record_node_failure(client_id, msg.get("message") or msg.get("error"))
            if client_id:
                await _incr_sessions(client_id, -1)
            if conv_id:
                await _set_conversation_status(conv_id, _terminal_status_from_task_message(msg))
                await _clear_active_task_id(conv_id, msg.get("task_id"))
                # Mirror Node idle: clear this node from workers even if work_status was missed.
                payload = await _apply_worker_state(
                    conv_id,
                    node_id=client_id,
                    working=False,
                    task_id=msg.get("task_id"),
                    reason="settled" if msg.get("type") == "task_complete" else "error",
                    interrupt_pending=False,
                )
                await _broadcast_conversation_working(payload)
            # Usage billing hook (no payment): record expert pack used on settlement.
            if msg.get("type") == "task_complete":
                await _record_expert_usage_billing(msg, node_id=client_id, conv_id=conv_id)
    elif msg.get("type") == "task_incomplete" and conv_id:
        if await _is_active_task_event(conv_id, msg.get("task_id")):
            await _set_conversation_status(
                conv_id,
                _terminal_status_from_task_message(
                    {**msg, "type": "task_complete", "status": msg.get("status") or "incomplete"}
                ),
            )

    if msg.get("type") == "request_decision" and not msg.get("request_id"):
        msg["request_id"] = str(uuid.uuid4())
    if msg.get("type") == "asset_discovered":
        persisted = await _persist_asset(msg, client_id)
        if persisted:
            msg.update({k: v for k, v in persisted.items() if v is not None})
    elif msg.get("type") == "vuln_found":
        persisted = await _persist_vulnerability(msg, client_id)
        if persisted:
            msg.update({k: v for k, v in persisted.items() if v is not None})
    elif msg.get("type") == "evidence_created":
        # Real proofs from Node4 emitEvidence (structured properties).
        await _persist_evidence(msg, client_id)
    elif msg.get("type") == "tool_output":
        # Tool cards already stream stdout; do NOT re-book every tool result as
        # Evidence (that produced messy JSON dumps next to real evidence_created rows).
        await _audit_tool_output(msg, client_id)
    msg_type = str(msg.get("type") or "")
    stream_fast = msg_type in {"text", "tool_output", "thinking", "agent_thinking", "reasoning"}
    should_save = (
        msg_type not in {"intake_update", "work_status", "checkpoint_update"}
        and not _is_pentest_runtime_status(msg)
    )

    if msg_type == "checkpoint_update":
        await _remember_conversation_checkpoint(conv_id, msg.get("checkpoint") or {})

    if stream_fast and conv_id:
        # Progressive UI: broadcast immediately. Never await DB on the hot path —
        # serial await save was delaying the receive loop so frames burst at end.
        _stamp_stream_message_ids(msg, conv_id)
        await _broadcast_to_conversation(conv_id, json.dumps(msg, ensure_ascii=False))
        if should_save:
            import asyncio

            async def _persist_stream_frame(payload: dict = dict(msg)) -> None:
                try:
                    await _save_message(payload, "agent")
                except Exception as exc:
                    print(f"[WS] async stream persist error type={payload.get('type')}: {exc}")

            asyncio.create_task(_persist_stream_frame())
    else:
        if should_save:
            await _save_message(msg, "agent")
        if conv_id and msg_type not in {"intake_update", "work_status"}:
            await _broadcast_to_conversation(conv_id, json.dumps(msg, ensure_ascii=False))

    if msg.get("type") == "request_decision":
        request_id = msg.get("request_id") or str(uuid.uuid4())
        msg["request_id"] = request_id
        pending_approvals[request_id] = {"conversation_id": conv_id, "node_id": client_id}
        actor_uuid = _uuid(client_id)
        if actor_uuid:
            await _audit(
                actor_type="agent",
                actor_id=actor_uuid,
                action="approval.request",
                resource_type="conversation",
                resource_id=_uuid(conv_id),
                conversation_id=_uuid(conv_id),
                detail={"request_id": request_id, "risk_level": msg.get("risk_level")},
            )


async def _incr_sessions(node_id: str, delta: int):
    try:
        from app.db.base import async_session
        from app.models.node import Node

        async with async_session() as db:
            r = await db.execute(select(Node).where(Node.id == uuid.UUID(node_id)))
            n = r.scalar_one_or_none()
            if n:
                n.current_sessions = max(0, (n.current_sessions or 0) + delta)
                await db.commit()
    except Exception as e:
        print(f"[WS] incr sessions error: {e}")


async def _record_node_failure(node_id: str | None, reason: object) -> None:
    if not node_id:
        return
    try:
        from app.db.base import async_session
        from app.models.node import Node

        message = str(reason or "Task failed").strip()[:500]
        async with async_session() as db:
            result = await db.execute(select(Node).where(Node.id == uuid.UUID(node_id)))
            node = result.scalar_one_or_none()
            if node:
                node.config = {**(node.config or {}), "last_failure_reason": message}
                node.last_heartbeat = datetime.now(timezone.utc)
                await db.commit()
    except Exception as e:
        print(f"[WS] record node failure error: {e}")

async def _available_agent_capabilities() -> list[AgentCapability]:
    """List platform + worker capabilities.

    online=true only when a live WebSocket is registered in node_connections.
    DB status=online without a socket is treated as offline so the planner cannot
    invent "waiting for agent" while also being told capabilities incorrectly.
    """
    capabilities = [
        AgentCapability(agent_type="platform", capability="platform.chat", node_id=str(PLATFORM_AGENT_NODE_ID), name="Platform Agent", online=True),
        AgentCapability(agent_type="platform", capability="snapshot.qa", node_id=str(PLATFORM_AGENT_NODE_ID), name="Platform Agent", online=True),
    ]

    try:
        from app.db.base import async_session
        from app.models.node import Node

        async with async_session() as db:
            result = await db.execute(select(Node).where(Node.type != "platform"))
            nodes = list(result.scalars().all())
    except Exception as e:
        raise OrchestrationError(f"Failed to load agent capabilities: {str(e)[:300]}") from e

    connected = set(node_connections.keys())
    for node in sorted(nodes, key=lambda item: str(item.id)):
        node_id = str(node.id)
        node_type = str(node.type or "").strip().lower()
        if not node_type or node_type == "platform":
            continue
        is_connected = node_id in connected
        # Heal stale DB online flag when socket is gone (best-effort, non-blocking for routing).
        if not is_connected and str(node.status or "").lower() == "online":
            try:
                await _update_node_status(node_id, "offline")
            except Exception:
                pass
        capabilities.append(AgentCapability(
            agent_type=node_type,
            capability=_capability_for_node_type(node_type),
            node_id=node_id,
            name=str(getattr(node, "name", None) or node_type),
            online=is_connected,
        ))

    # Connected sockets must always appear even if DB row is briefly missing.
    for node_id in sorted(connected):
        if any(item.node_id == node_id for item in capabilities):
            continue
        raise OrchestrationError(f"Connected node {node_id} is missing from the node registry")
    return capabilities


async def _eligible_node_ids_for_capability(capability: str) -> list[str]:
    capability = str(capability or "").strip()
    if not capability or capability in {"platform.chat", "snapshot.qa"}:
        return []
    if not node_connections:
        return []

    try:
        from app.db.base import async_session
        from app.models.node import Node

        node_ids = [_uuid(item) for item in node_connections.keys()]
        node_ids = [item for item in node_ids if item]
        async with async_session() as db:
            result = await db.execute(select(Node).where(Node.id.in_(node_ids)))
            nodes = result.scalars().all()
    except Exception as e:
        raise OrchestrationError(f"Failed to load eligible nodes: {str(e)[:300]}") from e

    eligible = []
    for node in nodes:
        node_id = str(node.id)
        if node_id in node_connections and _capability_for_node_type(str(node.type)) == capability:
            eligible.append(node_id)
    return sorted(eligible)

def _capability_for_node_type(node_type: str) -> str:
    return {
        "platform": "platform.chat",
        "pentest": "pentest.web",
        "baseline": "baseline.check",
        "remediation": "remediation.advice",
        "report": "report.generate",
    }.get(str(node_type or "").strip().lower(), f"{node_type}.task")

def _normalize_agent_identity(value, default: str | None = None) -> str | None:
    raw = str(value or "").strip().lower().replace("@", "")
    if raw in {"platform", "platform_agent", "platform agent"}:
        return "platform"
    if raw in {"pentest", "pentest_agent", "pentest agent", "security", "security_agent", "security agent"}:
        return "pentest"
    return default


def _agent_source(msg: dict, default: str = "pentest") -> str:
    content = msg.get("content") if isinstance(msg.get("content"), dict) else {}
    return _normalize_agent_identity(msg.get("agent_source") or content.get("agent_source"), default) or default


def _agent_target(msg: dict) -> str | None:
    content = msg.get("content") if isinstance(msg.get("content"), dict) else {}
    return _normalize_agent_identity(msg.get("agent_target") or content.get("agent_target"))


def _agent_node_id(msg: dict) -> str | None:
    content = msg.get("content") if isinstance(msg.get("content"), dict) else {}
    value = msg.get("agent_node_id") or content.get("agent_node_id")
    if not value:
        return None
    try:
        return str(uuid.UUID(str(value)))
    except ValueError:
        return None

def _node_mention_key(value: object) -> str:
    return str(value or "").strip().lower().lstrip("@")

def _node_mention_tokens(msg: dict) -> list[str]:
    content = msg.get("content") if isinstance(msg.get("content"), dict) else {}
    texts = [
        msg.get("text"),
        msg.get("display_text"),
        msg.get("initial_instruction"),
        content.get("text"),
    ]
    tokens: list[str] = []
    for text in texts:
        for match in NODE_MENTION_RE.findall(str(text or "")):
            token = _node_mention_key(match)
            if token and token not in tokens:
                tokens.append(token)
    return tokens


async def _load_enabled_experts() -> list:
    """Load product expert instances for @mention routing."""
    try:
        from app.db.base import async_session
        from app.models.expert import Expert

        async with async_session() as db:
            result = await db.execute(select(Expert).where(Expert.enabled.is_(True)))
            return list(result.scalars().all())
    except Exception as e:
        print(f"[WS] _load_enabled_experts error: {e}")
        return []


def _apply_expert_route_to_message(msg: dict, expert) -> dict:
    """Inject structured node + engagement from an expert instance (no NLP).

    Expert is the user-facing participant; node_id is only the execution seat.
    Always prefer expert pack for engagement/role when the expert is selected.
    """
    out = dict(msg)
    node_id = str(getattr(expert, "node_id", "") or "")
    pack = str(getattr(expert, "pack_id", "") or "").strip()
    expert_id = str(getattr(expert, "id", "") or "")
    expert_name = str(getattr(expert, "name", "") or "")
    display = str(getattr(expert, "display_name", "") or "").strip() or expert_name
    content = out.get("content") if isinstance(out.get("content"), dict) else {}
    content = dict(content)
    if node_id:
        out["agent_node_id"] = node_id
        content["agent_node_id"] = node_id
    if pack:
        # Expert pack is the source of truth for structured engagement (not free-text NLP).
        out["engagement"] = pack
        out["role"] = pack
        content["engagement"] = pack
        content["role"] = pack
    if expert_id:
        out["expert_id"] = expert_id
        out["expert_name"] = expert_name
        content["expert_id"] = expert_id
        content["expert_name"] = expert_name
        if display:
            content["expert_display_name"] = display
    out["content"] = content
    return out


def _find_expert_in_list(experts: list, *, expert_id: str | None = None, expert_name: str | None = None):
    """Look up an enabled expert by id, then by mention name."""
    eid = str(expert_id or "").strip()
    ename = str(expert_name or "").strip()
    if eid:
        for e in experts:
            if str(getattr(e, "id", "") or "") == eid:
                return e
    if ename:
        return match_expert_by_mention_token(ename, experts)
    return None


async def _resolve_mention_route(
    msg: dict,
    capabilities: list[AgentCapability],
) -> tuple[str | None, dict]:
    """Resolve @mention / explicit expert fields to a worker node.

    Shared-session model: mention designates the expert participant; the bound
    Node is only where that expert runs.

    Preference order:
      1. expert_id on the message → Expert instance (node + pack)
      2. @Expert name token → Expert instance
      3. Explicit agent_node_id without expert (legacy node route)
      4. @Node name (legacy / platform agent)

    Returns (node_id, possibly enriched msg).
    """
    experts = await _load_enabled_experts()
    content = msg.get("content") if isinstance(msg.get("content"), dict) else {}
    expert_id_raw = str(msg.get("expert_id") or content.get("expert_id") or "").strip()
    expert_name_raw = str(msg.get("expert_name") or content.get("expert_name") or "").strip()

    # Expert fields win: multi-agent room points at a persona, not a bare node.
    if expert_id_raw or expert_name_raw:
        expert = _find_expert_in_list(experts, expert_id=expert_id_raw, expert_name=expert_name_raw)
        if expert is not None:
            enriched = _apply_expert_route_to_message(msg, expert)
            return str(getattr(expert, "node_id", "") or "") or _agent_node_id(enriched), enriched

    tokens = _node_mention_tokens(msg)
    if tokens:
        for token in tokens:
            expert = match_expert_by_mention_token(token, experts)
            if expert is not None:
                enriched = _apply_expert_route_to_message(msg, expert)
                return str(expert.node_id), enriched

    explicit_node_id = _agent_node_id(msg)
    if explicit_node_id:
        return explicit_node_id, msg

    if not tokens:
        return None, msg

    # Fallback: node name mention (platform agent, or raw node routing).
    node_caps = [item for item in capabilities if item.node_id and item.agent_type != "platform"]
    all_caps = [item for item in capabilities if item.node_id]
    for token in tokens:
        matches = [
            str(item.node_id)
            for item in all_caps
            if token == _node_mention_key(item.name) or str(item.node_id).lower().startswith(token)
        ]
        if len(matches) == 1:
            return matches[0], msg
        worker_matches = [
            str(item.node_id)
            for item in node_caps
            if token == _node_mention_key(item.name) or str(item.node_id).lower().startswith(token)
        ]
        if len(worker_matches) == 1:
            return worker_matches[0], msg
    return None, msg


def _pack_for_capability(capability: str | None) -> str | None:
    """Map orchestrator capability → catalog pack id (structured, no NLP)."""
    cap = str(capability or "").strip().lower()
    if not cap:
        return None
    if cap.startswith("pentest") or cap in {"baseline.check", "remediation.advice"}:
        return "pentest"
    if "ctf" in cap:
        return "ctf"
    if "consult" in cap or cap.startswith("report"):
        return "consult"
    head = cap.split(".", 1)[0]
    return normalize_pack_id(head)


async def _select_expert_for_dispatch(
    *,
    capability: str | None,
    preferred_node_id: str | None,
    eligible_node_ids: list[str] | None,
) -> object | None:
    """Pick an enabled Expert for platform-initiated dispatch (shared-room handoff).

    Preference: matching pack + preferred node → matching pack + eligible node →
    any matching pack. Returns None if no product expert exists for the pack.
    """
    pack = _pack_for_capability(capability) or "pentest"
    experts = await _load_enabled_experts()
    eligible = {str(n) for n in (eligible_node_ids or []) if n}
    preferred = str(preferred_node_id or "").strip()
    pack_matches: list = []
    for e in experts:
        if normalize_pack_id(getattr(e, "pack_id", None)) != pack:
            continue
        nid = str(getattr(e, "node_id", "") or "")
        if preferred and nid == preferred:
            return e
        pack_matches.append(e)
    if not pack_matches:
        return None
    if eligible:
        for e in pack_matches:
            if str(getattr(e, "node_id", "") or "") in eligible:
                return e
    return pack_matches[0]


async def _hydrate_sticky_expert_on_message(conv_id: str | None, msg: dict) -> dict:
    """Fill expert_id/name/engagement from conversation sticky when dispatch needs them.

    Does not force routing to the expert for platform-only chat — callers use this
    when starting/continuing worker work so pack engagement is never dropped.
    """
    if not conv_id:
        return msg
    if str(msg.get("engagement") or msg.get("role") or "").strip() and str(msg.get("expert_id") or "").strip():
        return msg
    sticky_id, sticky_name = await _conversation_expert_label(conv_id)
    sticky_eng = await _conversation_task_engagement(conv_id)
    if not sticky_id and not sticky_name and not sticky_eng:
        return msg
    experts = await _load_enabled_experts()
    expert = _find_expert_in_list(experts, expert_id=sticky_id, expert_name=sticky_name)
    if expert is not None:
        return _apply_expert_route_to_message(msg, expert)
    out = dict(msg)
    if sticky_id and not str(out.get("expert_id") or "").strip():
        out["expert_id"] = sticky_id
    if sticky_name and not str(out.get("expert_name") or "").strip():
        out["expert_name"] = sticky_name
    if sticky_eng and not str(out.get("engagement") or "").strip():
        out["engagement"] = sticky_eng
        pack = normalize_pack_id(sticky_eng)
        if pack and not str(out.get("role") or "").strip():
            out["role"] = pack
    return out


async def _ensure_expert_on_dispatch(
    conv_id: str | None,
    msg: dict,
    *,
    capability: str | None,
    preferred_node_id: str | None,
    eligible_node_ids: list[str] | None,
) -> dict:
    """Ensure worker dispatch carries Expert persona + pack engagement.

    Order: sticky expert → auto-select product expert for capability → pack-only fallback.
    """
    out = await _hydrate_sticky_expert_on_message(conv_id, msg)
    if str(out.get("expert_id") or "").strip() and engagement_from_task_message(out):
        return out
    expert = await _select_expert_for_dispatch(
        capability=capability,
        preferred_node_id=preferred_node_id or _agent_node_id(out),
        eligible_node_ids=eligible_node_ids,
    )
    if expert is not None:
        out = _apply_expert_route_to_message(out, expert)
        return out
    # No product expert instance: still set structured pack so Node4 is not bare runtime.
    if not engagement_from_task_message(out):
        pack = _pack_for_capability(capability) or "pentest"
        out = dict(out)
        out["engagement"] = pack
        out["role"] = pack
    return out


async def _conversation_task_engagement(conv_id: str | None) -> str | None:
    """Return sticky engagement/role on conversation.task, if any."""
    if not conv_id:
        return None
    try:
        from app.db.base import async_session
        from app.models.conversation import Conversation

        async with async_session() as db:
            r = await db.execute(select(Conversation).where(Conversation.id == uuid.UUID(str(conv_id))))
            c = r.scalar_one_or_none()
            if not c:
                return None
            task = (c.context or {}).get("task") if isinstance(c.context, dict) else None
            if not isinstance(task, dict):
                return None
            eng = str(task.get("engagement") or task.get("role") or "").strip()
            return eng or None
    except Exception:
        return None


def _mentioned_node_id(msg: dict, capabilities: list[AgentCapability]) -> str | None:
    """Sync helper kept for call sites that only need node id (no expert inject).

    Prefer await _resolve_mention_route in async handlers.
    """
    explicit_node_id = _agent_node_id(msg)
    if explicit_node_id:
        return explicit_node_id

    tokens = _node_mention_tokens(msg)
    if not tokens:
        return None

    node_caps = [item for item in capabilities if item.node_id and item.agent_type != "platform"]
    for token in tokens:
        matches = [
            str(item.node_id)
            for item in node_caps
            if token == _node_mention_key(item.name) or str(item.node_id).lower().startswith(token)
        ]
        if len(matches) == 1:
            return matches[0]
    return None

def _agent_target_for_request(
    msg: dict,
    requested_node_id: str | None,
    capabilities: list[AgentCapability],
) -> str | None:
    target = _agent_target(msg)
    if target:
        return target
    if not requested_node_id:
        return None
    for item in capabilities:
        if item.node_id == requested_node_id:
            return _normalize_agent_identity(item.agent_type, str(item.agent_type or "").strip().lower())
    return None

def _is_active_runtime_status(conversation_status: str | None) -> bool:
    return str(conversation_status or "").strip().lower() == "running"


def _has_bound_living_agent_status(conversation_status: str | None) -> bool:
    """Statuses where a pentest node may still hold conversation-scoped session memory.

    Platform chat is a group room: after a work burst completes/fails, the agent
    participant should stay addressable — not only while status==running.
    """
    return str(conversation_status or "").strip().lower() in {
        "running",
        "failed",
        "incomplete",
        "paused",
        "completed",
        "blocked",
    }


def _should_use_sticky_node_binding(
    *,
    conversation_status: str | None,
    requested_node_id: str | None,
    bound_node_id: str | None,
) -> bool:
    """Mid-task only: forward follow-ups to the active worker without re-orchestrating.

    After a burst settles (failed/incomplete/completed), fall through so the
    platform Agent can explain results or re-dispatch with expert pack sticky.
    Explicit @expert/@node bypasses sticky so the user can switch participants.
    """
    return bool(
        _is_active_runtime_status(conversation_status)
        and not requested_node_id
        and bound_node_id
    )

def _decision_agent_attribution(decision) -> tuple[str, str]:
    source = _normalize_agent_identity(getattr(decision, "agent", None), "platform") or "platform"
    node_id = str(getattr(decision, "agent_node_id", "") or "")
    if source != "platform" and node_id:
        return source, node_id
    return "platform", str(PLATFORM_AGENT_NODE_ID)

def _apply_agent_attribution(answer: dict, *, agent_source: str, agent_node_id: str) -> dict:
    answer["agent_source"] = agent_source
    answer["agent_node_id"] = agent_node_id
    content = answer.get("content")
    if isinstance(content, dict):
        content["agent_source"] = agent_source
        content["agent_node_id"] = agent_node_id
    return answer

def _message_dedupe_key(*, role: str, original_type: str, stored_type: str, content: dict) -> str | None:
    if role == "user":
        client_message_id = content.get("client_message_id")
        return f"user:{client_message_id}" if client_message_id else None
    if original_type == "tool_output":
        tool_run_id = content.get("tool_run_id")
        return f"tool:{tool_run_id}" if tool_run_id else None
    if role == "agent" and original_type in {"text", "thinking", "agent_thinking", "reasoning"}:
        stream_id = content.get("stream_id")
        prefix = "thinking" if original_type in {"thinking", "agent_thinking", "reasoning"} else "text"
        return f"{prefix}:{stream_id}" if stream_id else None
    if original_type == "plan_tree_updated":
        return _plan_tree_dedupe_key(content)
    if original_type in {"status_update", "phase_changed"}:
        return "status:{stage}:{iteration}:{active_tool}:{status}".format(
            stage=content.get("workflow_stage") or content.get("phase") or "",
            iteration=content.get("iteration") or "",
            active_tool=content.get("active_tool") or "",
            status=content.get("status") or "",
        )
    if original_type == "request_decision":
        request_id = content.get("request_id")
        return f"approval:{request_id}" if request_id else None
    if original_type == "task_error":
        return f"task_error:{hashlib.sha256(str(content.get('text') or '').encode()).hexdigest()[:16]}"
    # Unified terminal status channel: incomplete and completed share one dedupe key so
    # a legacy task_incomplete + task_complete pair cannot create two UI rows.
    if original_type in {"task_complete", "task_incomplete"}:
        return "task_complete"
    if original_type == "vuln_found":
        # Dedupe by finding identity (title / vulnerability id), NOT evidence_id.
        # Multiple distinct findings often share one evidence artifact; using
        # evidence_id as the key silently dropped later cards from Discoveries.
        title = str(content.get("title") or "").strip().lower()
        stable_id = (
            content.get("id")
            or content.get("vulnerability_id")
            or content.get("finding_id")
            or (f"title:{title}" if title else None)
        )
        return f"vuln_found:{stable_id}" if stable_id else None
    if original_type in {"evidence_created", "asset_discovered"}:
        stable_id = content.get("evidence_id") or content.get("id") or content.get("vulnerability_id") or content.get("asset_id")
        return f"{original_type}:{stable_id}" if stable_id else None
    return None


def _plan_tree_dedupe_key(content: dict) -> str:
    plan_items = content.get("plan_tree") if isinstance(content.get("plan_tree"), list) else []
    kanban = content.get("kanban") if isinstance(content.get("kanban"), dict) else {}
    payload = {
        "task_id": content.get("task_id") or "",
        "workflow_stage": content.get("workflow_stage") or content.get("phase") or "",
        "kanban": {
            "workflow_kind": kanban.get("workflow_kind"),
            "current_stage": kanban.get("current_stage"),
            "totals": kanban.get("totals"),
            "buckets": kanban.get("buckets"),
        },
        "plan_tree": [
            {
                "id": item.get("node_id") or item.get("id") or item.get("title"),
                "title": item.get("title"),
                "kind": item.get("kind"),
                "level": item.get("level"),
                "status": item.get("status"),
                "result": item.get("result"),
                "source": item.get("source"),
                "parent_id": item.get("parent_id"),
                "endpoint": item.get("endpoint"),
                "parameter": item.get("parameter"),
                "vuln_type": item.get("vuln_type"),
            }
            for item in plan_items
            if isinstance(item, dict)
        ],
    }
    digest = hashlib.sha256(json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str).encode("utf-8")).hexdigest()[:16]
    return f"plan_tree:{digest}"


def _is_pentest_runtime_status(msg: dict) -> bool:
    if msg.get("type") not in {"status_update", "phase_changed"}:
        return False
    kanban = msg.get("kanban") if isinstance(msg.get("kanban"), dict) else {}
    return msg.get("workflow_kind") == "pentest" or kanban.get("workflow_kind") == "pentest"


def _append_tool_stdout(current: object, incoming: object) -> str:
    current_stdout = str(current or "")
    incoming_stdout = str(incoming or "")
    if incoming_stdout and incoming_stdout not in current_stdout:
        separator = "" if current_stdout.endswith("\n") or not current_stdout else "\n"
        return f"{current_stdout}{separator}{incoming_stdout}"
    return current_stdout or incoming_stdout


def _proof_properties_from_summary(summary: object) -> dict:
    if not isinstance(summary, str) or not summary.strip().startswith(("{", "[")):
        return {}
    try:
        parsed = json.loads(summary)
    except Exception:
        return {}
    if not isinstance(parsed, dict):
        return {}
    proof = {}
    for key in ("url", "status", "statusText", "scanner", "exitCode", "traffic_id", "trafficId"):
        if parsed.get(key) is not None:
            proof[key] = parsed.get(key)
    body = parsed.get("body") or parsed.get("responseBody")
    if isinstance(body, str) and body:
        proof["body_excerpt"] = body[:6000]
    stdout = parsed.get("stdout")
    if isinstance(stdout, str) and stdout:
        proof["stdout_excerpt"] = stdout[:6000]
    stderr = parsed.get("stderr")
    if isinstance(stderr, str) and stderr:
        proof["stderr_excerpt"] = stderr[:2000]
    return {"proof": proof} if proof else {}


def _evidence_properties_are_hollow(properties: object) -> bool:
    """True when Case evidence lacks collab-usable proof payload."""
    if not isinstance(properties, dict) or not properties:
        return True
    for key in (
        "stdout",
        "excerpt",
        "body_preview",
        "response_body",
        "preview",
        "path",
        "path_or_url",
        "url",
        "command",
    ):
        val = properties.get(key)
        if isinstance(val, str) and val.strip():
            return False
    proof = properties.get("proof")
    if isinstance(proof, dict):
        for key in ("stdout_excerpt", "body_excerpt"):
            val = proof.get(key)
            if isinstance(val, str) and val.strip():
                return False
    # Ignore pure noise shells like {status: null, stderr: ""}
    meaningful = {
        k: v
        for k, v in properties.items()
        if v not in (None, "", {}, []) and k not in {"placeholder", "status", "stderr", "timedOut", "aborted"}
    }
    return len(meaningful) == 0


def _backfill_evidence_from_proof_excerpts(evidence_rows: list, proof_excerpts: object) -> None:
    """Merge booking excerpts into hollow Evidence.properties (in-session, before commit)."""
    if not isinstance(proof_excerpts, list) or not proof_excerpts:
        return
    by_id: dict[str, str] = {}
    for item in proof_excerpts:
        if not isinstance(item, dict):
            continue
        eid = str(item.get("evidence_id") or "").strip()
        excerpt = str(item.get("excerpt") or "").strip()
        if eid and excerpt:
            by_id[eid] = excerpt[:4000]
    for row in evidence_rows:
        eid = str(getattr(row, "evidence_id", "") or "")
        excerpt = by_id.get(eid)
        if not excerpt:
            continue
        props = dict(row.properties or {}) if isinstance(getattr(row, "properties", None), dict) else {}
        if not _evidence_properties_are_hollow(props) and props.get("excerpt"):
            continue
        props.setdefault("role", "proof")
        props["excerpt"] = excerpt
        # Best-effort field fill for UI parsers
        if "stdout" not in props and not props.get("response_body"):
            props["stdout"] = excerpt[:6000]
        if "path_or_url" not in props:
            for token in excerpt.replace("\n", " ").split():
                if token.startswith("/") or token.startswith("http://") or token.startswith("https://"):
                    props["path_or_url"] = token[:400]
                    break
        props["backfilled_from_proof_excerpts"] = True
        row.properties = props


def _tool_item_from_content(content: dict) -> dict:
    item = {
        "tool_name": content.get("tool_name", ""),
        "tool_run_id": content.get("tool_run_id"),
        "command": content.get("command", ""),
        "status": content.get("status", "running"),
        "stdout": content.get("stdout", ""),
        "evidence_id": content.get("evidence_id"),
    }
    for key in ("summary", "display_title", "category", "target", "args", "result", "result_text"):
        if content.get(key) is not None:
            item[key] = content.get(key)
    return item


def _merge_tool_items(existing: dict, incoming: dict) -> list[dict]:
    current = existing.get("tool_items") if isinstance(existing.get("tool_items"), list) else [_tool_item_from_content(existing)]
    incoming_item = _tool_item_from_content(incoming)
    incoming_run_id = str(incoming_item.get("tool_run_id") or "")
    merged: list[dict] = []
    updated = False

    for item in current:
        if not isinstance(item, dict):
            continue
        item_run_id = str(item.get("tool_run_id") or "")
        if incoming_run_id and item_run_id == incoming_run_id:
            merged_item = {
                **item,
                **incoming_item,
                "command": incoming_item.get("command") or item.get("command") or "",
                "stdout": _append_tool_stdout(item.get("stdout"), incoming_item.get("stdout")),
                "status": incoming_item.get("status") or item.get("status") or "running",
                "evidence_id": incoming_item.get("evidence_id") or item.get("evidence_id"),
            }
            for key in ("summary", "display_title", "category", "target", "args", "result", "result_text"):
                merged_item[key] = incoming_item.get(key) if incoming_item.get(key) is not None else item.get(key)
            merged.append(merged_item)
            updated = True
        else:
            merged.append(item)

    if not updated:
        merged.append(incoming_item)
    return merged


def _merge_saved_message_content(existing: dict, incoming: dict, msg_type: str) -> dict:
    if msg_type != "tool_call":
        # Streaming text/thinking: always keep the longer body so partial frames
        # cannot regress a fuller snapshot that arrived out of order.
        merged = {**existing, **incoming}
        if msg_type in {"text", "thinking"}:
            prev = str(existing.get("text") or existing.get("reasoning") or "")
            nxt = str(incoming.get("text") or incoming.get("reasoning") or "")
            if len(prev) > len(nxt):
                merged["text"] = prev
                if msg_type == "thinking":
                    merged["reasoning"] = prev
            elif nxt:
                merged["text"] = nxt
                if msg_type == "thinking":
                    merged["reasoning"] = nxt
        return merged
    stdout = _append_tool_stdout(existing.get("stdout"), incoming.get("stdout"))
    return {
        **existing,
        **incoming,
        "command": incoming.get("command") or existing.get("command") or "",
        "evidence_id": incoming.get("evidence_id") or existing.get("evidence_id"),
        "stdout": stdout,
        "status": incoming.get("status") or existing.get("status") or "running",
        "tool_items": _merge_tool_items(existing, incoming),
    }


def _stamp_stream_message_ids(msg: dict, conv_id: str) -> None:
    """
    Attach a stable message_id before broadcast so the UI can upsert stream frames
    without waiting for the DB write to finish.
    """
    content = msg.get("content") if isinstance(msg.get("content"), dict) else {}
    stream_id = str(
        content.get("stream_id")
        or msg.get("stream_id")
        or ""
    ).strip()
    tool_run_id = str(
        msg.get("tool_run_id")
        or content.get("tool_run_id")
        or ""
    ).strip()
    existing = str(msg.get("message_id") or content.get("message_id") or "").strip()
    if existing:
        # Keep content.message_id in sync for frontend makeMessage().
        if isinstance(msg.get("content"), dict) and not content.get("message_id"):
            msg["content"]["message_id"] = existing
        return
    if msg.get("type") == "text" and stream_id:
        mid = str(uuid.uuid5(uuid.NAMESPACE_URL, f"text:{conv_id}:{stream_id}"))
    elif msg.get("type") in {"thinking", "agent_thinking", "reasoning"} and stream_id:
        mid = str(uuid.uuid5(uuid.NAMESPACE_URL, f"thinking:{conv_id}:{stream_id}"))
    elif msg.get("type") == "tool_output" and tool_run_id:
        mid = str(uuid.uuid5(uuid.NAMESPACE_URL, f"tool:{conv_id}:{tool_run_id}"))
    else:
        mid = str(uuid.uuid4())
    msg["message_id"] = mid
    if isinstance(msg.get("content"), dict):
        msg["content"]["message_id"] = mid
        if stream_id and not msg["content"].get("stream_id"):
            msg["content"]["stream_id"] = stream_id
    elif msg.get("type") == "text":
        msg["content"] = {"text": str(msg.get("text") or ""), "stream_id": stream_id, "message_id": mid}
    if stream_id and not msg.get("stream_id"):
        msg["stream_id"] = stream_id

async def _save_message(msg: dict, role: str) -> uuid.UUID | None:
    try:
        from app.db.base import async_session
        from app.models.message import Message

        conv_id = msg.get("conversation_id")
        if not conv_id:
            return None

        original_type = msg.get("type", "text")
        msg_type = original_type
        if role == "user":
            target_agent = _agent_target(msg)
            target_node_id = _agent_node_id(msg)
            if msg_type == "user_decision":
                content = {
                    "request_id": msg.get("request_id"),
                    "decision": msg.get("decision"),
                    "text": f"Authorization decision: {msg.get('decision')}",
                }
                msg_type = "decision"
            else:
                content = {"text": msg.get("display_text") or msg.get("text", "")}
                if msg.get("client_message_id"):
                    content["client_message_id"] = msg.get("client_message_id")
                msg_type = "text"
            if target_agent:
                content["agent_target"] = target_agent
            if target_node_id:
                content["agent_node_id"] = target_node_id
            expert_id = str(msg.get("expert_id") or content.get("expert_id") or "").strip()
            expert_name = str(msg.get("expert_name") or content.get("expert_name") or "").strip()
            if expert_id:
                content["expert_id"] = expert_id
            if expert_name:
                content["expert_name"] = expert_name
        elif msg_type == "text":
            inner = msg.get("content", {})
            if isinstance(inner, dict):
                content = dict(inner)
                content["text"] = inner.get("text", str(msg))
            else:
                content = {"text": str(inner)}
            if msg.get("stream_id") and not content.get("stream_id"):
                content["stream_id"] = msg.get("stream_id")
        elif msg_type in ("thinking", "agent_thinking", "reasoning"):
            msg_type = "thinking"
            inner = msg.get("content", {})
            if isinstance(inner, dict):
                content = dict(inner)
                body = str(inner.get("reasoning") or inner.get("text") or "")
                content["text"] = body
                content["reasoning"] = body
            else:
                content = {"text": str(inner), "reasoning": str(inner)}
            if msg.get("stream_id") and not content.get("stream_id"):
                content["stream_id"] = msg.get("stream_id")
        elif msg_type == "tool_output":
            msg_type = "tool_call"
            content = {
                "tool_name": msg.get("tool_name", ""),
                "tool_run_id": msg.get("tool_run_id"),
                "command": msg.get("command", ""),
                "status": msg.get("status", "running"),
                "stdout": msg.get("stdout") or msg.get("line", ""),
                "evidence_id": msg.get("evidence_id"),
                "summary": msg.get("summary") or msg.get("line", ""),
                "display_title": msg.get("display_title"),
                "category": msg.get("category"),
                "target": msg.get("target"),
                "args": msg.get("args"),
                "result": msg.get("result"),
                "result_text": msg.get("result_text"),
            }
            content["tool_items"] = [_tool_item_from_content(content)]
        elif msg_type in ("status_update", "phase_changed"):
            msg_type = "status"
            # Prefer Node4 message / agent_phase over legacy phase+iteration template.
            human = str(msg.get("message") or msg.get("text") or "").strip()
            phase = msg.get("agent_phase") or msg.get("phase")
            active_tool = msg.get("active_tool")
            if human and human.lower() not in {"model turn", "llm_waiting", "tool_running"}:
                text = human
            elif active_tool:
                text = f"{active_tool}"
            elif phase:
                text = str(phase)
            else:
                text = f"Phase: {msg.get('phase', '')} (iter {msg.get('iteration', '')})"
            # Skip persisting pure harness ticks that flood the transcript.
            if human.lower() in {"model turn"} or (
                human.lower().endswith(" running") and human.lower() not in {"still running"}
            ):
                return None
            content = {
                "text": text,
                "phase": phase,
                "iteration": msg.get("iteration"),
                "active_tool": active_tool,
                "status": msg.get("status"),
                "intake_result": msg.get("intake_result"),
            }
        elif msg_type == "request_decision":
            msg_type = "confirm_card"
            content = {
                "request_id": msg.get("request_id"),
                "risk_level": msg.get("risk_level", "intrusive"),
                "question": msg.get("question", "Authorize this action?"),
                "proposed_action": msg.get("proposed_action", ""),
                "target": msg.get("target", ""),
                "expires_at": msg.get("expires_at", ""),
                "options": ["authorize", "cancel"],
            }
        elif msg_type == "completion_blocked":
            msg_type = "status"
            content = {
                "text": msg.get("message") or "Runtime completion gate found unresolved runtime safety checks.",
                "status": "blocked",
                "audit": msg.get("audit"),
                "round": msg.get("round"),
            }
        elif msg_type == "task_incomplete":
            # Legacy alias: older nodes may still emit task_incomplete. Prefer a single
            # task_complete(status=incomplete) channel going forward.
            msg_type = "status"
            content = {
                "text": "Task incomplete",
                "status": "incomplete",
                "summary": msg.get("summary", {}),
                "audit": msg.get("audit"),
            }
        elif msg_type == "task_complete":
            msg_type = "status"
            terminal = str(msg.get("status") or "completed").strip().lower()
            if terminal in {"incomplete", "blocked"}:
                content = {
                    "text": "Task incomplete" if terminal == "incomplete" else "Task blocked",
                    "status": terminal,
                    "summary": msg.get("summary", {}),
                    "audit": msg.get("audit"),
                }
            else:
                content = {"text": "Task complete", "status": "completed", "summary": msg.get("summary", {})}
        elif msg_type == "task_error":
            msg_type = "status"
            content = {"text": f"Task failed: {msg.get('message', msg.get('error', ''))}"}
        else:
            content = dict(msg)

        if role == "agent":
            content["agent_source"] = _agent_source(msg)
            agent_node_id = _agent_node_id(msg)
            if agent_node_id:
                content["agent_node_id"] = agent_node_id
            # Prefer explicit expert on message; else sticky conversation expert persona.
            expert_id = str(msg.get("expert_id") or content.get("expert_id") or "").strip()
            expert_name = str(msg.get("expert_name") or content.get("expert_name") or "").strip()
            if not expert_id or not expert_name:
                sticky_id, sticky_name = await _conversation_expert_label(str(conv_id))
                if not expert_id and sticky_id:
                    expert_id = sticky_id
                if not expert_name and sticky_name:
                    expert_name = sticky_name
            if expert_id:
                content["expert_id"] = expert_id
                msg["expert_id"] = expert_id
            if expert_name:
                content["expert_name"] = expert_name
                msg["expert_name"] = expert_name

        dedupe_key = _message_dedupe_key(role=role, original_type=str(original_type), stored_type=str(msg_type), content=content)
        if dedupe_key:
            content["dedupe_key"] = dedupe_key

        # Honor pre-stamped stream ids so broadcast→save keep the same row key.
        pre_id = str(msg.get("message_id") or content.get("message_id") or "").strip()
        try:
            message_id = uuid.UUID(pre_id) if pre_id else uuid.uuid4()
        except ValueError:
            message_id = uuid.uuid4()
        msg["message_id"] = str(message_id)
        content["message_id"] = str(message_id)
        if isinstance(msg.get("content"), dict):
            msg["content"]["message_id"] = str(message_id)
        async with async_session() as db:
            if dedupe_key:
                existing_result = await db.execute(
                    select(Message).where(
                        Message.conversation_id == uuid.UUID(conv_id),
                        Message.role == role,
                        Message.msg_type == msg_type,
                        Message.content["dedupe_key"].astext == dedupe_key,
                    )
                )
                existing = existing_result.scalar_one_or_none()
                if existing:
                    message_id = existing.id
                    content["message_id"] = str(message_id)
                    existing.content = _merge_saved_message_content(existing.content or {}, content, msg_type)
                    msg["message_id"] = str(message_id)
                    if isinstance(msg.get("content"), dict):
                        msg["content"]["message_id"] = str(message_id)
                    await db.commit()
                    return message_id

            # Also match by primary key when stream stamped the id first.
            by_pk = await db.execute(
                select(Message).where(
                    Message.id == message_id,
                    Message.conversation_id == uuid.UUID(conv_id),
                )
            )
            existing_pk = by_pk.scalar_one_or_none()
            if existing_pk:
                existing_pk.content = _merge_saved_message_content(existing_pk.content or {}, content, msg_type)
                existing_pk.msg_type = msg_type
                await db.commit()
                return message_id

            content["message_id"] = str(message_id)
            db.add(Message(
                id=message_id,
                conversation_id=uuid.UUID(conv_id),
                role=role,
                msg_type=msg_type,
                content=content,
            ))
            await db.commit()
        return message_id
    except Exception as e:
        print(f"[WS] _save_message error: {e}")
        return None


async def _persist_asset(msg: dict, node_id: str | None):
    """
    Enrich an existing user-owned host asset (ports/services/urls/api endpoints).

    Agents never create ledger hosts — only users add assets. Unknown hosts are
    ignored for the global ledger (conversation cards may still show surface).
    """
    conv_id = msg.get("conversation_id")
    if not conv_id:
        return None
    user_id, bound_node = await _conversation_owner(conv_id)
    if not user_id:
        return None
    node_uuid = _uuid(node_id) or bound_node
    try:
        from app.db.base import async_session
        from app.api.assets import upsert_discovered_asset
        from app.services.asset_ledger import is_valid_ledger_address, split_host_port

        raw_address = msg.get("address") or msg.get("affected_asset") or msg.get("target") or ""
        # Drop path/file noise (e.g. reflected.php) — not enterprise ledger hosts.
        if not is_valid_ledger_address(raw_address):
            return None
        host, addr_port = split_host_port(raw_address)
        if not host:
            return None
        # Pass None when agent omits identity fields so merge keeps ledger name/type.
        hostname = msg.get("hostname")
        name = str(hostname).strip() if hostname is not None and str(hostname).strip() else None
        raw_type = msg.get("asset_type")
        asset_type = str(raw_type).strip() if raw_type is not None and str(raw_type).strip() else None
        port = msg.get("port") or addr_port
        urls = msg.get("urls") or msg.get("web_urls")
        api_endpoints = msg.get("api_endpoints") or msg.get("endpoints") or msg.get("apis")
        async with async_session() as db:
            asset = await upsert_discovered_asset(
                db,
                user_id=user_id,
                address=host,
                name=name,
                asset_type=asset_type,
                open_ports=msg.get("open_ports"),
                services=msg.get("services"),
                urls=urls,
                api_endpoints=api_endpoints,
                port=port,
                conversation_id=uuid.UUID(conv_id),
                node_id=node_uuid,
                allow_create=False,
            )
            if not asset:
                # Host not in user ledger — do not invent an asset row.
                return None
            await db.commit()
            props = asset.properties or {}
            return {
                "id": str(asset.id),
                "asset_id": str(asset.id),
                "conversation_id": str(asset.conversation_id) if asset.conversation_id else conv_id,
                "node_id": str(asset.node_id) if asset.node_id else None,
                "name": asset.name,
                "address": asset.address,
                "asset_type": asset.type,
                "type": asset.type,
                "tags": asset.tags or [],
                "properties": props,
                "open_ports": props.get("open_ports") or [],
                "services": props.get("services") or [],
                "urls": props.get("urls") or [],
                "api_endpoints": props.get("api_endpoints") or [],
            }
    except Exception as e:
        print(f"[WS] persist asset error: {e}")
        return None


async def _persist_evidence(msg: dict, node_id: str | None):
    conv_id = msg.get("conversation_id")
    if not conv_id:
        return None
    user_id, bound_node = await _conversation_owner(conv_id)
    if not user_id:
        return None
    node_uuid = _uuid(node_id) or bound_node
    try:
        from app.db.base import async_session
        from app.models.evidence import Evidence

        tool_run_id = msg.get("tool_run_id") or msg.get("related_tool_run_id")
        summary = msg.get("summary") or msg.get("line") or msg.get("stdout") or ""
        # Prefer human summary lines; never store multi-KB JSON tool dumps as the title/summary.
        if isinstance(summary, (dict, list)):
            summary = json.dumps(summary, ensure_ascii=False)[:200]
        summary = str(summary)
        if summary.lstrip().startswith("{") and len(summary) > 280:
            summary = summary[:200] + "…"
        raw_hash = msg.get("hash") or hashlib.sha256(str(summary).encode()).hexdigest()
        evidence_id = msg.get("evidence_id") or f"ev-{raw_hash[:12]}"
        incoming_properties = msg.get("properties") if isinstance(msg.get("properties"), dict) else {}
        # Also accept nested data payloads from Node4 emitEvidence.
        data_blob = msg.get("data") if isinstance(msg.get("data"), dict) else {}
        properties = {
            **data_blob,
            **incoming_properties,
            **_proof_properties_from_summary(summary),
        }
        # Normalize collab-facing fields so Case rows are never silent shells.
        if not properties.get("excerpt"):
            for key in ("stdout", "body_preview", "response_body", "preview", "text", "content"):
                val = properties.get(key)
                if isinstance(val, str) and val.strip():
                    properties["excerpt"] = val[:4000]
                    break
            if not properties.get("excerpt"):
                proof = properties.get("proof") if isinstance(properties.get("proof"), dict) else {}
                for key in ("stdout_excerpt", "body_excerpt"):
                    val = proof.get(key)
                    if isinstance(val, str) and val.strip():
                        properties["excerpt"] = val[:4000]
                        break
        if not properties.get("path_or_url"):
            for key in ("path", "url", "file"):
                val = properties.get(key)
                if isinstance(val, str) and val.strip():
                    properties["path_or_url"] = val[:500]
                    break
            if not properties.get("path_or_url") and properties.get("command"):
                properties["path_or_url"] = f"$ {str(properties.get('command'))[:200]}"
        if not properties.get("role"):
            has_body = bool(str(properties.get("excerpt") or "").strip())
            properties["role"] = "proof" if has_body or properties.get("path_or_url") else "trace"
        # Drop null noise keys that clutter the detail dialog.
        properties = {k: v for k, v in properties.items() if v is not None and v != ""}

        async with async_session() as db:
            existing = await db.execute(select(Evidence).where(Evidence.evidence_id == evidence_id))
            evidence = existing.scalar_one_or_none()
            if not evidence:
                evidence = Evidence(
                    id=uuid.uuid4(),
                    evidence_id=evidence_id,
                    user_id=user_id,
                    conversation_id=uuid.UUID(conv_id),
                    node_id=node_uuid,
                    type=msg.get("evidence_type") or "tool_output",
                    source_tool=msg.get("source_tool") or msg.get("tool_name"),
                    tool_run_id=tool_run_id,
                    raw_ref=msg.get("raw_ref"),
                    summary=summary[:500],
                    hash=raw_hash,
                    properties=properties,
                )
                db.add(evidence)
            else:
                evidence.user_id = evidence.user_id or user_id
                evidence.conversation_id = evidence.conversation_id or uuid.UUID(conv_id)
                evidence.node_id = evidence.node_id or node_uuid
                evidence.type = msg.get("evidence_type") or evidence.type
                evidence.source_tool = msg.get("source_tool") or msg.get("tool_name") or evidence.source_tool
                evidence.tool_run_id = tool_run_id or evidence.tool_run_id
                evidence.raw_ref = msg.get("raw_ref") or evidence.raw_ref
                if summary and not summary.lstrip().startswith("{"):
                    evidence.summary = summary[:500]
                evidence.hash = raw_hash or evidence.hash
                evidence.properties = {
                    **(evidence.properties or {}),
                    **properties,
                    "placeholder": False,
                }
            await db.commit()
            await _audit(
                actor_type="agent",
                actor_id=node_uuid or uuid.UUID(int=0),
                action="evidence.create",
                resource_type="evidence",
                resource_id=evidence.id,
                conversation_id=uuid.UUID(conv_id),
                detail={"evidence_id": evidence_id, "source_tool": evidence.source_tool},
            )
            return evidence_id
    except Exception as e:
        print(f"[WS] persist evidence error: {e}")
        return None

async def _audit_tool_output(msg: dict, node_id: str | None):
    conv_id = msg.get("conversation_id")
    if not conv_id:
        return
    node_uuid = _uuid(node_id)
    if not node_uuid:
        _, bound_node = await _conversation_owner(conv_id)
        node_uuid = bound_node
    status_value = str(msg.get("status") or "done").lower()
    if status_value in {"blocked", "denied", "canceled", "cancelled"}:
        audit_status = "blocked"
    elif status_value in {"fail", "failed", "error"}:
        audit_status = "failed"
    else:
        audit_status = "success"
    await _audit(
        actor_type="agent",
        actor_id=node_uuid or uuid.UUID(int=0),
        action="tool.execute",
        status=audit_status,
        resource_type="conversation",
        resource_id=_uuid(conv_id),
        conversation_id=_uuid(conv_id),
        detail={
            "tool_name": msg.get("tool_name"),
            "tool_run_id": msg.get("tool_run_id"),
            "command": msg.get("command"),
            "line": str(msg.get("line") or "")[:500],
            "risk_level": msg.get("risk_level"),
            "raw_status": msg.get("status"),
        },
    )


async def _persist_vulnerability(msg: dict, node_id: str | None):
    conv_id = msg.get("conversation_id")
    if not conv_id:
        return None
    raw_status = str(msg.get("status") or "").lower()
    if raw_status != "confirmed":
        return None
    evidence_ids = _clean_evidence_ids(msg.get("evidence_ids", []))
    if not evidence_ids:
        return None

    user_id, bound_node = await _conversation_owner(conv_id)
    if not user_id:
        return None
    node_uuid = _uuid(node_id) or bound_node
    try:
        from app.db.base import async_session
        from app.models.evidence import Evidence
        from app.models.vulnerability import Vulnerability

        from app.api.assets import upsert_discovered_asset
        from app.services.asset_ledger import is_valid_ledger_address, normalize_port, split_host_port

        context = await _conversation_context(conv_id)
        raw_target = msg.get("affected_asset") or msg.get("target") or ""
        host, port_from_target = split_host_port(raw_target)
        if not host or not is_valid_ledger_address(host):
            fallback = _target_address_from_context(context)
            host, port_from_fallback = split_host_port(fallback)
            if not port_from_target:
                port_from_target = port_from_fallback
        port = normalize_port(msg.get("port")) or port_from_target
        # Also try location/URL for port when agent put full URL in location.
        if not port:
            _, port_from_loc = split_host_port(msg.get("location") or msg.get("poc") or "")
            port = port_from_loc

        from datetime import datetime, timezone

        from app.services.finding_dedupe import (
            append_discovery_event,
            is_same_finding,
            normalize_finding_title,
            pick_canonical_vuln,
            ports_equal,
        )
        from sqlalchemy import func

        title = str(msg.get("title") or "Untitled finding").strip() or "Untitled finding"
        location = msg.get("location") or msg.get("url") or msg.get("poc") or ""
        # Prefer explicit PoC (reproduction + observed result); fall back carefully.
        poc_value = msg.get("poc") or msg.get("evidence_summary") or msg.get("location") or ""
        severity = _normalize_severity(msg.get("severity"))
        cvss_value = msg.get("cvss")
        description = (
            msg.get("description")
            or msg.get("impact")
            or ""
        )
        # Always surface proof material so reports can show *why* this is believed real.
        proof_excerpts = msg.get("proof_excerpts")
        evidence_summary = str(msg.get("evidence_summary") or "").strip()
        proof_block = ""
        if isinstance(proof_excerpts, list) and proof_excerpts:
            bits = []
            for item in proof_excerpts[:4]:
                if isinstance(item, dict) and item.get("excerpt"):
                    bits.append(str(item.get("excerpt"))[:700])
            if bits:
                proof_block = "\n---\n".join(bits)
        if not proof_block and evidence_summary:
            proof_block = evidence_summary[:2800]
        if proof_block:
            desc_text = str(description or "").strip()
            if not desc_text:
                description = proof_block
            elif proof_block[:120] not in desc_text:
                description = f"{desc_text}\n\n[Proof]\n{proof_block}"
            # If agent omitted a real PoC, store proof excerpts instead of bare location.
            if not str(msg.get("poc") or "").strip():
                existing_poc = str(poc_value or "").strip()
                if (
                    not existing_poc
                    or existing_poc == str(location or "").strip()
                    or len(existing_poc) < 40
                ):
                    poc_value = proof_block[:4000]
        service_name = msg.get("service") or msg.get("service_name") or ""
        cve_id = msg.get("cve_id") or msg.get("cve") or None
        if cve_id is not None:
            cve_id = str(cve_id).strip() or None
        now = datetime.now(timezone.utc)

        async with async_session() as db:
            existing_evidence = await db.execute(
                select(Evidence).where(
                    Evidence.conversation_id == uuid.UUID(conv_id),
                    Evidence.evidence_id.in_(evidence_ids),
                )
            )
            evidence_rows = list(existing_evidence.scalars().all())
            known_evidence_ids = {item.evidence_id for item in evidence_rows}
            if set(evidence_ids) - known_evidence_ids:
                return None

            # Backfill hollow Case evidence from booking proof_excerpts so next expert
            # can read paths/stdout without the original taskDir.
            _backfill_evidence_from_proof_excerpts(evidence_rows, proof_excerpts)

            # Link to user-owned host only; agents never create ledger assets.
            # Findings may book with asset_id=None when host is unknown / not on ledger.
            asset_id = None
            if host and is_valid_ledger_address(host):
                services = None
                if port:
                    svc: dict = {"port": port, "name": str(service_name).strip() if service_name else ""}
                    loc = str(msg.get("location") or msg.get("url") or "").strip()
                    if loc and "://" in loc:
                        svc["url"] = loc
                    services = [svc]
                location_url = str(msg.get("location") or msg.get("url") or "").strip()
                urls_in = [location_url] if location_url and "://" in location_url else None
                asset = await upsert_discovered_asset(
                    db,
                    user_id=user_id,
                    address=host,
                    open_ports=[port] if port else None,
                    services=services,
                    urls=urls_in,
                    port=port,
                    conversation_id=uuid.UUID(conv_id),
                    node_id=node_uuid,
                    allow_create=False,
                )
                if asset:
                    asset_id = asset.id

            # Cross-session dedupe: same user + asset + title (+ port) → one ledger row.
            title_key = normalize_finding_title(title)
            candidates: list = []
            if asset_id and title_key:
                result = await db.execute(
                    select(Vulnerability).where(
                        Vulnerability.user_id == user_id,
                        Vulnerability.asset_id == asset_id,
                        func.lower(func.trim(Vulnerability.title)) == title_key,
                    )
                )
                for row in result.scalars().all():
                    if is_same_finding(
                        {
                            "title": row.title,
                            "asset_id": row.asset_id,
                            "port": row.port,
                            "cve_id": row.cve_id,
                        },
                        title=title,
                        asset_id=asset_id,
                        port=port,
                        cve_id=cve_id,
                    ) and ports_equal(row.port, port):
                        candidates.append(row)
            # Also catch same-conversation exact title rows (legacy duplicates).
            conv_rows = (
                await db.execute(
                    select(Vulnerability).where(
                        Vulnerability.user_id == user_id,
                        Vulnerability.conversation_id == uuid.UUID(conv_id),
                        func.lower(func.trim(Vulnerability.title)) == title_key,
                    )
                )
            ).scalars().all()
            seen_ids = {getattr(c, "id", None) for c in candidates}
            for row in conv_rows:
                if row.id not in seen_ids:
                    candidates.append(row)
                    seen_ids.add(row.id)

            vuln = pick_canonical_vuln(candidates)
            created = vuln is None
            rediscovered = False
            lifecycle_status = "to_fix"

            if not vuln:
                vuln = Vulnerability(
                    id=uuid.uuid4(),
                    user_id=user_id,
                    node_id=node_uuid,
                    title=title,
                    severity=severity,
                    cvss=cvss_value,
                    cve_id=cve_id,
                    asset_id=asset_id,
                    port=port,
                    conversation_id=uuid.UUID(conv_id),
                    description=description,
                    poc=poc_value,
                    remediation=msg.get("remediation") or "",
                    confidence=str(msg.get("confidence", "high")),
                    status=lifecycle_status,
                    evidence_ids=evidence_ids,
                    first_seen_at=now,
                    discovered_at=now,
                    history=append_discovery_event(
                        [],
                        event="discovered",
                        conversation_id=conv_id,
                        evidence_ids=evidence_ids,
                        at=now,
                    ),
                )
                db.add(vuln)
            else:
                rediscovered = True
                # Preserve first_seen; refresh last-seen discovered_at for list sorting / UI.
                if not getattr(vuln, "first_seen_at", None):
                    vuln.first_seen_at = vuln.discovered_at or now
                vuln.discovered_at = now
                vuln.user_id = vuln.user_id or user_id
                vuln.node_id = vuln.node_id or node_uuid
                vuln.asset_id = vuln.asset_id or asset_id
                if port:
                    vuln.port = port
                if cve_id and not vuln.cve_id:
                    vuln.cve_id = cve_id
                vuln.severity = severity or vuln.severity
                _apply_vulnerability_cvss(vuln, cvss_value)
                # Prefer fresher non-empty agent narrative on rediscover.
                if description:
                    vuln.description = description
                if poc_value:
                    vuln.poc = poc_value
                if msg.get("remediation"):
                    vuln.remediation = msg.get("remediation")
                vuln.confidence = str(msg.get("confidence", vuln.confidence or "high"))
                vuln.evidence_ids = sorted(set(vuln.evidence_ids or []) | set(evidence_ids))
                # Timeline: record rediscovery event.
                try:
                    prev_history = list(vuln.history or [])
                except Exception:
                    prev_history = []
                vuln.history = append_discovery_event(
                    prev_history,
                    event="rediscovered",
                    conversation_id=conv_id,
                    evidence_ids=evidence_ids,
                    at=now,
                )
                # Status: reopen fixed findings (regression); keep fixing in progress;
                # otherwise ensure open as to_fix.
                cur = str(vuln.status or "").strip().lower()
                if cur in {"fixed", "closed"}:
                    vuln.status = "to_fix"  # regression: still reproducible
                elif cur in {"fixing", "reported", "in_progress"}:
                    pass
                else:
                    vuln.status = lifecycle_status
                # Keep original conversation_id (first session); latest is in history.

            # Merge any extra duplicate rows into the canonical one, then delete them.
            extras = [r for r in candidates if r is not None and r.id != vuln.id]
            for duplicate in extras:
                vuln.evidence_ids = sorted(
                    set(vuln.evidence_ids or []) | set(duplicate.evidence_ids or [])
                )
                vuln.description = vuln.description or duplicate.description
                vuln.poc = vuln.poc or duplicate.poc
                vuln.remediation = vuln.remediation or duplicate.remediation
                vuln.asset_id = vuln.asset_id or duplicate.asset_id
                if not vuln.port and getattr(duplicate, "port", None):
                    vuln.port = duplicate.port
                # Prefer earliest first_seen
                dup_first = getattr(duplicate, "first_seen_at", None) or duplicate.discovered_at
                if dup_first and (
                    not getattr(vuln, "first_seen_at", None) or dup_first < vuln.first_seen_at
                ):
                    vuln.first_seen_at = dup_first
                try:
                    dup_hist = list(duplicate.history or [])
                except Exception:
                    dup_hist = []
                merged_hist = list(getattr(vuln, "history", None) or [])
                for item in dup_hist:
                    if item not in merged_hist:
                        merged_hist.append(item)
                vuln.history = merged_hist[-50:]
                await db.delete(duplicate)

            await db.commit()
            await _audit(
                actor_type="agent",
                actor_id=node_uuid or uuid.UUID(int=0),
                action=_finding_audit_action(
                    created=created,
                    rediscovered=rediscovered and not created,
                    raw_status=raw_status,
                    stored_status=vuln.status,
                ),
                resource_type="vulnerability",
                resource_id=vuln.id,
                conversation_id=uuid.UUID(conv_id),
                detail={
                    "title": vuln.title,
                    "severity": vuln.severity,
                    "status": vuln.status,
                    "host": host or None,
                    "port": vuln.port,
                    "evidence_gate": "passed",
                    "evidence_ids": vuln.evidence_ids or [],
                    "created": created,
                    "rediscovered": rediscovered and not created,
                    "merged_duplicates": len(extras),
                    "fingerprint_title": title_key,
                },
            )
            return {
                "id": str(vuln.id),
                "vulnerability_id": str(vuln.id),
                "strix_vulnerability_id": msg.get("strix_vulnerability_id") or msg.get("id"),
                "asset_id": str(vuln.asset_id) if vuln.asset_id else None,
                "port": vuln.port,
                "conversation_id": str(vuln.conversation_id),
                "node_id": str(vuln.node_id) if vuln.node_id else None,
                "title": vuln.title,
                "severity": vuln.severity,
                "location": vuln.poc or location,
                "confidence": vuln.confidence,
                "status": vuln.status,
                "affected_asset": host or msg.get("affected_asset"),
                "description": msg.get("description") or vuln.description,
                "impact": msg.get("impact"),
                "technical_analysis": msg.get("technical_analysis"),
                "poc": msg.get("poc") or vuln.poc,
                "poc_description": msg.get("poc_description"),
                "poc_script_code": msg.get("poc_script_code"),
                "remediation": msg.get("remediation") or vuln.remediation,
                "remediation_steps": msg.get("remediation_steps"),
                "cvss": msg.get("cvss"),
                "cvss_breakdown": msg.get("cvss_breakdown"),
                "cve_id": msg.get("cve_id") or msg.get("cve"),
                "cwe": msg.get("cwe"),
                "endpoint": msg.get("endpoint"),
                "method": msg.get("method"),
                "agent_id": msg.get("agent_id"),
                "agent_name": msg.get("agent_name"),
                "timestamp": msg.get("timestamp"),
                "evidence_ids": vuln.evidence_ids or [],
            }
    except Exception as e:
        print(f"[WS] persist vuln error: {e}")
        return None

async def _find_node_by_token(token: str) -> str | None:
    try:
        from app.db.base import async_session
        from app.models.node import Node

        token_hash = hashlib.sha256(token.encode()).hexdigest()
        async with async_session() as db:
            result = await db.execute(select(Node).where(Node.token_hash == token_hash))
            node = result.scalar_one_or_none()
            return str(node.id) if node else None
    except Exception:
        return None


def _apply_vulnerability_cvss(vuln, cvss_value):
    if cvss_value is not None:
        vuln.cvss = cvss_value




async def _conversation_status(conv_id: str) -> str | None:
    try:
        from app.db.base import async_session
        from app.models.conversation import Conversation

        async with async_session() as db:
            r = await db.execute(select(Conversation).where(Conversation.id == uuid.UUID(conv_id)))
            c = r.scalar_one_or_none()
            return c.status if c else None
    except Exception:
        return None


async def _conversation_snapshot(conv_id: str, user_id: str) -> dict:
    try:
        from app.db.base import async_session
        from app.models.conversation import Conversation

        async with async_session() as db:
            r = await db.execute(select(Conversation).where(Conversation.id == uuid.UUID(conv_id)))
            c = r.scalar_one_or_none()
            if not c:
                return {}
            return await build_conversation_snapshot(db, c, uuid.UUID(user_id))
    except Exception as e:
        print(f"[WS] conversation snapshot error: {e}")
        return {}



async def _remember_conversation_task(
    conv_id: str,
    *,
    target: dict,
    scope: dict,
    instruction: str,
    goal_objective: str | None = None,
    engagement: str | None = None,
    expert_id: str | None = None,
    expert_name: str | None = None,
    engagement_template: str | None = None,
    allow_postex: bool | None = None,
    accounts: object = None,
):
    try:
        from app.db.base import async_session
        from app.models.conversation import Conversation
        from app.services.case_engagement import merge_case_into_context, resolve_allow_postex

        async with async_session() as db:
            r = await db.execute(select(Conversation).where(Conversation.id == uuid.UUID(conv_id)))
            c = r.scalar_one_or_none()
            if not c:
                return
            context = dict(c.context or {})
            prev_task = context.get("task") if isinstance(context.get("task"), dict) else {}
            task_blob: dict = {
                "target": target or {},
                "scope": scope or {},
                "instruction": instruction or "",
            }
            go = str(goal_objective or "").strip() or str(prev_task.get("goal_objective") or "").strip()
            if go:
                task_blob["goal_objective"] = go
            # Sticky engagement/pack must survive follow-ups that omit the field.
            eng = str(engagement or prev_task.get("engagement") or prev_task.get("role") or "").strip()
            if eng:
                task_blob["engagement"] = eng
                pack = normalize_pack_id(eng)
                if pack:
                    task_blob["role"] = pack
            # Sticky product expert persona for UI labels (virtual image, not node name).
            eid = str(expert_id or prev_task.get("expert_id") or "").strip()
            ename = str(expert_name or prev_task.get("expert_name") or "").strip()
            if eid:
                task_blob["expert_id"] = eid
            if ename:
                task_blob["expert_name"] = ename
            et = str(
                engagement_template
                or prev_task.get("engagement_template")
                or ""
            ).strip()
            if et:
                task_blob["engagement_template"] = et
            ap = allow_postex
            if ap is None and "allow_postex" in prev_task:
                ap = prev_task.get("allow_postex")
            if ap is not None or et:
                task_blob["allow_postex"] = resolve_allow_postex(
                    engagement_template=et or eng,
                    engagement=eng,
                    allow_postex=ap,
                )
            if accounts is not None:
                task_blob["accounts"] = accounts
            elif prev_task.get("accounts") is not None:
                task_blob["accounts"] = prev_task.get("accounts")
            context["task"] = task_blob
            # Keep case block in sync (1 conversation = 1 case)
            context = merge_case_into_context(
                context,
                engagement_template=task_blob.get("engagement_template"),
                allow_postex=task_blob.get("allow_postex"),
                accounts=task_blob.get("accounts"),
            )
            c.context = context
            await db.commit()
    except Exception as e:
        print(f"[WS] remember conversation task error: {e}")


async def _conversation_expert_label(conv_id: str | None) -> tuple[str | None, str | None]:
    """Return (expert_id, expert_name) sticky on conversation.task, if any."""
    if not conv_id:
        return None, None
    try:
        from app.db.base import async_session
        from app.models.conversation import Conversation

        async with async_session() as db:
            r = await db.execute(select(Conversation).where(Conversation.id == uuid.UUID(str(conv_id))))
            c = r.scalar_one_or_none()
            if not c:
                return None, None
            task = (c.context or {}).get("task") if isinstance(c.context, dict) else None
            if not isinstance(task, dict):
                return None, None
            eid = str(task.get("expert_id") or "").strip() or None
            ename = str(task.get("expert_name") or "").strip() or None
            return eid, ename
    except Exception:
        return None, None


async def _remember_conversation_expert(
    conv_id: str | None,
    *,
    expert_id: str | None = None,
    expert_name: str | None = None,
    engagement: str | None = None,
) -> None:
    """Persist sticky expert persona on conversation.context.task without clobbering target."""
    if not conv_id:
        return
    eid = str(expert_id or "").strip()
    ename = str(expert_name or "").strip()
    eng = str(engagement or "").strip()
    if not eid and not ename and not eng:
        return
    try:
        from app.db.base import async_session
        from app.models.conversation import Conversation

        async with async_session() as db:
            r = await db.execute(select(Conversation).where(Conversation.id == uuid.UUID(str(conv_id))))
            c = r.scalar_one_or_none()
            if not c:
                return
            context = dict(c.context or {})
            task = dict(context.get("task") or {}) if isinstance(context.get("task"), dict) else {}
            if eid:
                task["expert_id"] = eid
            if ename:
                task["expert_name"] = ename
            if eng:
                task["engagement"] = eng
                pack = normalize_pack_id(eng)
                if pack:
                    task["role"] = pack
            context["task"] = task
            c.context = context
            await db.commit()
    except Exception as e:
        print(f"[WS] remember conversation expert error: {e}")


async def _node_config(node_id: str | None) -> dict:
    """Load node.config for offers / gate checks. Empty dict if unavailable."""
    if not node_id:
        return {}
    try:
        from app.db.base import async_session
        from app.models.node import Node

        async with async_session() as db:
            result = await db.execute(select(Node).where(Node.id == uuid.UUID(str(node_id))))
            node = result.scalar_one_or_none()
            if not node:
                return {}
            return dict(node.config) if isinstance(node.config, dict) else {}
    except Exception as e:
        print(f"[WS] _node_config error: {e}")
        return {}


async def _gate_engagement_for_node(node_id: str | None, engagement: object) -> str | None:
    """Return error text if engagement is not offered on the node; else None."""
    cfg = await _node_config(node_id)
    return dispatch_gate_error(cfg, engagement)


async def _record_expert_usage_billing(
    msg: dict,
    *,
    node_id: str | None,
    conv_id: str | None,
) -> None:
    """Append expert.usage billing hook on task_complete (no payment side effects)."""
    try:
        eng = engagement_from_task_message(msg)
        if not eng and conv_id:
            # Fall back to structured engagement stored on conversation.task.
            try:
                from app.db.base import async_session
                from app.models.conversation import Conversation

                async with async_session() as db:
                    r = await db.execute(
                        select(Conversation).where(Conversation.id == uuid.UUID(str(conv_id)))
                    )
                    c = r.scalar_one_or_none()
                    if c and isinstance(c.context, dict):
                        task = c.context.get("task") if isinstance(c.context.get("task"), dict) else {}
                        eng = str(task.get("engagement") or task.get("role") or "").strip()
            except Exception:
                pass
        detail = usage_billing_detail(
            engagement=eng or None,
            expert_id=msg.get("expert_id") or msg.get("role") or msg.get("engagement") or eng or None,
            task_id=msg.get("task_id"),
            conversation_id=conv_id,
            node_id=node_id,
            status=msg.get("status") or "completed",
        )
        actor = _uuid(node_id) or uuid.UUID(int=0)
        await _audit(
            actor_type="node" if node_id else "system",
            actor_id=actor,
            action=ACTION_USAGE,
            resource_type="conversation" if conv_id else "node",
            resource_id=_uuid(conv_id) or _uuid(node_id),
            conversation_id=_uuid(conv_id),
            detail=detail,
        )
    except Exception as e:
        print(f"[WS] expert usage billing error: {e}")


async def _remember_conversation_checkpoint(conv_id: str, checkpoint: dict):
    if not conv_id or not isinstance(checkpoint, dict):
        return
    try:
        from app.db.base import async_session
        from app.models.conversation import Conversation

        async with async_session() as db:
            r = await db.execute(select(Conversation).where(Conversation.id == uuid.UUID(conv_id)))
            c = r.scalar_one_or_none()
            if not c:
                return
            context = dict(c.context or {})
            # Ignore checkpoint from a superseded work burst.
            active = str(context.get("active_task_id") or "").strip()
            cp_task = str(checkpoint.get("task_id") or "").strip()
            if active and cp_task and active != cp_task:
                return
            context["checkpoint"] = checkpoint
            task = context.get("task") or {}
            if checkpoint.get("target") and not task.get("target"):
                task["target"] = checkpoint.get("target") or {}
            if checkpoint.get("scope") and not task.get("scope"):
                task["scope"] = checkpoint.get("scope") or {}
            if task:
                context["task"] = task
            c.context = context
            # Terminal checkpoint should settle the conversation row even if
            # task_complete status transition was missed earlier.
            from app.services.conversation_state import reconcile_conversation_status_from_checkpoint

            reconcile_conversation_status_from_checkpoint(c)
            await db.commit()
    except Exception as e:
        print(f"[WS] remember conversation checkpoint error: {e}")


async def _is_active_task_event(conv_id: str | None, task_id: object) -> bool:
    """True if task_id is empty/unknown or matches conversation.active_task_id."""
    if not conv_id:
        return True
    tid = str(task_id or "").strip()
    if not tid:
        return True
    try:
        from app.db.base import async_session
        from app.models.conversation import Conversation

        async with async_session() as db:
            r = await db.execute(select(Conversation).where(Conversation.id == uuid.UUID(str(conv_id))))
            c = r.scalar_one_or_none()
            if not c:
                return True
            active = str((c.context or {}).get("active_task_id") or "").strip()
            if not active:
                return True
            return active == tid
    except Exception:
        return True


async def _clear_active_task_id(conv_id: str | None, task_id: object) -> None:
    if not conv_id:
        return
    tid = str(task_id or "").strip()
    try:
        from app.db.base import async_session
        from app.models.conversation import Conversation

        async with async_session() as db:
            r = await db.execute(select(Conversation).where(Conversation.id == uuid.UUID(str(conv_id))))
            c = r.scalar_one_or_none()
            if not c:
                return
            context = dict(c.context or {})
            active = str(context.get("active_task_id") or "").strip()
            if active and tid and active != tid:
                return
            if "active_task_id" in context:
                del context["active_task_id"]
                c.context = context
                await db.commit()
    except Exception as e:
        print(f"[WS] clear active_task_id error: {e}")

def _message_target_value(msg: dict) -> str:
    target = msg.get("target") or {}
    if isinstance(target, dict) and target.get("value"):
        return str(target.get("value") or "").strip()
    text = str(msg.get("text") or msg.get("initial_instruction") or "")
    return extract_target(text)


def _completed_pentest_followup_requested(msg: dict, target_value: str) -> bool:
    requested_agent = _agent_target(msg)
    if requested_agent == "platform":
        return False
    if target_value:
        return True
    if requested_agent != "pentest":
        return False
    text = str(msg.get("text") or msg.get("initial_instruction") or "")
    return bool(FOLLOW_UP_ACTION_RE.search(text))


def _user_message_route(msg: dict, conversation_status: str | None) -> dict:
    target_value = _message_target_value(msg)
    if conversation_status == "completed":
        action = "completed_followup" if _completed_pentest_followup_requested(msg, target_value) else "completed"
        return {"action": action, "target_value": target_value}
    if conversation_status == "running" and not target_value:
        return {"action": "steer_or_resume", "target_value": target_value}
    if not target_value:
        return {"action": "resume", "target_value": target_value}
    return {"action": "assign", "target_value": target_value}


def _task_context_from_snapshot(resume_context: dict) -> dict:
    """Snapshot uses task_context; some callers still stash task on the envelope."""
    if not isinstance(resume_context, dict):
        return {}
    for key in ("task_context", "task"):
        value = resume_context.get(key)
        if isinstance(value, dict) and value:
            return value
    return {}


def _has_resumable_task(resume_context: dict) -> bool:
    task = _task_context_from_snapshot(resume_context)
    target = task.get("target")
    if isinstance(target, dict) and str(target.get("value") or "").strip():
        return True
    if isinstance(target, str) and target.strip():
        return True
    return False


def _message_has_task_target(msg: dict) -> bool:
    """True only when this user message carries an authorized execution target.

    Structured product fields (target/scope) or explicit URL/IP in text — not
    free-text intent guessing. Greetings like "你好" must return False.
    """
    if not isinstance(msg, dict):
        return False
    target = msg.get("target")
    if isinstance(target, dict) and str(target.get("value") or "").strip():
        return True
    if isinstance(target, str) and target.strip():
        return True
    scope = msg.get("scope")
    if isinstance(scope, dict):
        allow = scope.get("allow")
        if isinstance(allow, list) and any(str(item or "").strip() for item in allow):
            return True
    if extract_targets(str(msg.get("text") or "")):
        return True
    return False


def _looks_like_continue_request(text: str) -> bool:
    raw = str(text or "").strip()
    if not raw:
        return False
    if CONTINUE_REQUEST_RE.match(raw):
        return True
    # Slightly longer "继续扫剩下的" style, but still short steers.
    if len(raw) <= 40 and FOLLOW_UP_ACTION_RE.search(raw) and not re.search(r"https?://", raw, re.I):
        return True
    return False


# Default objective when UI enables goal mode without custom text (not NLP on free text).
DEFAULT_GOAL_OBJECTIVE = (
    "Within authorized scope, maximize verified findings, flags, and challenge unlocks "
    "with evidence-backed booking. Enumerate challenges/modules yourself. "
    "Do not mark goal complete until remaining items from your recon are solved or proven blocked; "
    "partial clearance is not done. Complete requires audit_notes, remaining_unsolved=0, "
    "and harness progress gates (continuations + no-progress stalls)."
)


def _goal_objective_from_message(msg: dict, *, fallback: str | None = None) -> str:
    """Structured goal_objective only — never invent from free-text instruction NLP."""
    if msg.get("goal_mode") in (True, "true", "1", 1, "yes"):
        custom = str(msg.get("goal_objective") or msg.get("goalObjective") or "").strip()
        if custom:
            return custom
        fb = str(fallback or "").strip()
        return fb or DEFAULT_GOAL_OBJECTIVE
    custom = str(msg.get("goal_objective") or msg.get("goalObjective") or "").strip()
    if custom:
        return custom
    return str(fallback or "").strip()


def _resume_message_from_context(msg: dict, resume_context: dict, *, include_checkpoint: bool = True) -> tuple[dict | None, bool]:
    task_context = _task_context_from_snapshot(resume_context)
    if not task_context.get("target"):
        return None, False

    base_instruction = str(task_context.get("instruction") or "")
    continue_instruction = str(msg.get("text") or "")
    combined_instruction = f"{base_instruction}\n\nUser continuation: {continue_instruction}".strip()
    out = {
        **msg,
        "target": task_context.get("target") or {},
        "scope": task_context.get("scope") or {},
        "text": combined_instruction,
        "initial_instruction": combined_instruction,
    }
    # Preserve prior structured goal seed on resume unless the new message overrides.
    prior_goal = str(task_context.get("goal_objective") or "").strip()
    resolved_goal = _goal_objective_from_message(msg, fallback=prior_goal)
    if resolved_goal:
        out["goal_objective"] = resolved_goal
        out["goal_mode"] = True
    if include_checkpoint:
        checkpoint = resume_context.get("checkpoint") if isinstance(resume_context.get("checkpoint"), dict) else {}
        if not checkpoint and isinstance(task_context.get("checkpoint"), dict):
            checkpoint = task_context.get("checkpoint") or {}
        out["checkpoint"] = checkpoint or {}
    return out, True


def _message_with_decision_target(msg: dict, decision) -> dict:
    if msg.get("target") or not getattr(decision, "targets", None):
        return msg
    target_value = str(decision.targets[0] or "").strip()
    if not target_value:
        return msg
    target_type = "url" if target_value.lower().startswith(("http://", "https://")) else "host"
    return {
        **msg,
        "target": {"type": target_type, "value": target_value},
        "scope": msg.get("scope") or {"allow": [target_value], "deny": []},
    }

def _task_assign_from_user_message(conv_id: str, msg: dict, task_id: str) -> dict:
    task_target = msg.get("target") or {}
    task_scope = msg.get("scope") or {"allow": [task_target.get("value")] if task_target else []}
    out = {
        "type": "task_assign",
        "conversation_id": conv_id,
        "task_id": task_id,
        "target": task_target,
        "scope": task_scope,
        "initial_instruction": msg.get("text", ""),
        "snapshot": msg.get("snapshot") or {},
    }
    goal_objective = _goal_objective_from_message(msg)
    if goal_objective:
        out["goal_objective"] = goal_objective
        out["goal_mode"] = True
    # Structured engagement/role only (expert pack / UI field) — never NLP of text.
    eng = engagement_from_task_message(msg)
    if eng:
        out["engagement"] = eng
        pack = normalize_pack_id(eng)
        if pack:
            out["role"] = pack
        snap = out.get("snapshot") if isinstance(out.get("snapshot"), dict) else {}
        snap = dict(snap)
        snap["engagement"] = eng
        if pack:
            snap["role"] = pack
        out["snapshot"] = snap
    # Carry expert persona so Node/UI attribute work to the expert, not the box.
    expert_id = str(msg.get("expert_id") or "").strip()
    expert_name = str(msg.get("expert_name") or "").strip()
    if expert_id:
        out["expert_id"] = expert_id
    if expert_name:
        out["expert_name"] = expert_name
    # RoE / engagement template (structured; may come from message or later sticky merge)
    et = str(msg.get("engagement_template") or msg.get("engagementTemplate") or "").strip()
    if et:
        out["engagement_template"] = et
    if "allow_postex" in msg or "allowPostex" in msg:
        raw = msg.get("allow_postex", msg.get("allowPostex"))
        if isinstance(raw, bool):
            out["allow_postex"] = raw
        elif str(raw).strip().lower() in {"true", "1", "yes"}:
            out["allow_postex"] = True
        elif str(raw).strip().lower() in {"false", "0", "no"}:
            out["allow_postex"] = False
    if msg.get("accounts") is not None:
        out["accounts"] = msg.get("accounts")
    return out


async def _merge_case_roe_into_task_assign(conv_id: str | None, task_msg: dict) -> dict:
    """Attach sticky Case RoE fields from conversation when message omits them."""
    if not conv_id:
        return task_msg
    out = dict(task_msg)
    try:
        from app.db.base import async_session
        from app.models.conversation import Conversation
        from app.services.case_engagement import roe_payload_for_task_assign

        async with async_session() as db:
            r = await db.execute(select(Conversation).where(Conversation.id == uuid.UUID(str(conv_id))))
            c = r.scalar_one_or_none()
            if not c:
                return out
            roe = roe_payload_for_task_assign(c.context)
            if "engagement_template" not in out and roe.get("engagement_template"):
                out["engagement_template"] = roe["engagement_template"]
            if "allow_postex" not in out and "allow_postex" in roe:
                out["allow_postex"] = roe["allow_postex"]
            if out.get("accounts") is None and roe.get("accounts") is not None:
                out["accounts"] = roe["accounts"]
            # If template set but engagement blank, use template (alias → pentest on node)
            if not engagement_from_task_message(out) and roe.get("engagement_template"):
                out["engagement"] = roe["engagement_template"]
                pack = normalize_pack_id(roe["engagement_template"])
                if pack:
                    out["role"] = pack
    except Exception as e:
        print(f"[WS] merge case roe error: {e}")
    return out


async def _attach_case_context_to_task_assign(conv_id: str | None, task_msg: dict) -> dict:
    """Attach work-group thread + findings so experts join the same case chat.

    Does not invent engagement. Skips if case_context already present.
    """
    if not conv_id:
        return task_msg
    out = dict(task_msg)
    if isinstance(out.get("case_context"), dict) and (
        out["case_context"].get("thread") is not None
        or out["case_context"].get("findings_summary") is not None
    ):
        return out
    try:
        from app.db.base import async_session
        from app.models.conversation import Conversation
        from app.services.case_context import load_case_context_for_conversation

        async with async_session() as db:
            r = await db.execute(select(Conversation).where(Conversation.id == uuid.UUID(str(conv_id))))
            c = r.scalar_one_or_none()
            if not c:
                return out
            user_id = getattr(c, "user_id", None)
            ctx = await load_case_context_for_conversation(
                db,
                c.id,
                user_id=user_id,
            )
            # Always attach (even empty first turn) so Node knows the field exists
            out["case_context"] = ctx
    except Exception as e:
        print(f"[WS] attach case_context error: {e}")
    return out


async def _worker_limits_for_node(node_id: str | None) -> dict:
    """Attach node-configured runtime budgets (worker + main + schedule) to task_assign."""
    if not node_id:
        return {}
    try:
        from app.db.base import async_session
        from app.models.node import Node
        from app.api.nodes import worker_limits_from_config

        async with async_session() as db:
            result = await db.execute(select(Node).where(Node.id == uuid.UUID(str(node_id))))
            node = result.scalar_one_or_none()
            if not node or str(node.type or "") == "platform":
                return {}
            return worker_limits_from_config(node.config)
    except Exception as e:
        print(f"[WS] _worker_limits_for_node error: {e}")
        return {}

def _agent_assignment_notice(
    decision,
    node_id: str,
    node_name: str | None = None,
    expert_name: str | None = None,
) -> str:
    """User-facing dispatch notice: prefer expert persona over physical node name."""
    capability = str(getattr(decision, "capability", "") or "").strip()
    capability_part = f"\uff0c\u80fd\u529b: {capability}" if capability else ""
    ename = str(expert_name or "").strip().lstrip("@")
    if ename:
        return (
            f"\u5e73\u53f0 Agent \u5df2\u8bf7\u4e13\u5bb6\u300c{ename}\u300d\u63a5\u624b\u5904\u7406"
            f"{capability_part}\u3002"
        )
    agent_label = _agent_label_for_notice(
        getattr(decision, "agent", "") or _capability_for_notice(getattr(decision, "capability", ""))
    )
    node_label = str(node_name or "").strip() or (node_id[:8] if node_id else "")
    node_part = f"\uff08{node_label}\uff09" if node_label else ""
    return f"\u5e73\u53f0 Agent \u5df2\u5c06\u4efb\u52a1\u4ea4\u7ed9 {agent_label}{node_part} \u5904\u7406{capability_part}\u3002"


def _capability_for_notice(capability: str) -> str:
    value = str(capability or "").lower()
    if value.startswith("pentest"):
        return "pentest"
    if value.startswith("report"):
        return "report"
    if value.startswith("remediation"):
        return "remediation"
    if value.startswith("baseline"):
        return "baseline"
    return "agent"


def _agent_label_for_notice(agent: str) -> str:
    labels = {
        "platform": "\u5e73\u53f0 Agent",
        "pentest": "\u6e17\u900f Agent",
        "baseline": "\u57fa\u7ebf Agent",
        "remediation": "\u6574\u6539 Agent",
        "report": "\u62a5\u544a Agent",
    }
    key = str(agent or "").strip().lower()
    return labels.get(key, f"{key or 'Agent'} Agent")


async def _node_name(node_id: str | None) -> str:
    if not node_id:
        return ""
    try:
        from app.db.base import async_session
        from app.models.node import Node

        async with async_session() as db:
            result = await db.execute(select(Node).where(Node.id == uuid.UUID(node_id)))
            node = result.scalar_one_or_none()
            return str(getattr(node, "name", "") or "") if node else ""
    except Exception:
        return ""


async def _announce_agent_assignment(
    conv_id: str,
    decision,
    node_id: str,
    *,
    expert_name: str | None = None,
) -> None:
    sticky_id, sticky_name = await _conversation_expert_label(conv_id)
    ename = str(expert_name or sticky_name or "").strip() or None
    notice = _agent_assignment_notice(
        decision,
        node_id,
        await _node_name(node_id),
        expert_name=ename,
    )
    content: dict = {"text": notice}
    if sticky_id:
        content["expert_id"] = sticky_id
    if ename:
        content["expert_name"] = ename
    await _persist_and_broadcast(conv_id, {
        "type": "text",
        "conversation_id": conv_id,
        "content": content,
        "agent_source": "platform",
        "agent_node_id": str(PLATFORM_AGENT_NODE_ID),
    }, "agent")


def _should_announce_agent_assignment(requested_node_id: str | None, msg: dict) -> bool:
    return not (requested_node_id or _agent_node_id(msg))


async def _send_to_bound_node(conv_id: str, raw: str) -> bool:
    node_id = conversation_node.get(conv_id)
    if not node_id:
        _, bound_node = await _conversation_owner(conv_id)
        node_id = str(bound_node) if bound_node else None
    if node_id and node_id in node_connections:
        await node_connections[node_id].send_text(raw)
        return True
    return False


async def _send_direct_node_message(conv_id: str, node_id: str | None, msg: dict, capability: str | None = None) -> bool:
    if not node_id or node_id not in node_connections:
        return False
    node_msg = {
        **msg,
        "type": "user_steer",
        "conversation_id": conv_id,
        "agent_node_id": node_id,
    }
    if capability:
        node_msg["agent_capability"] = capability
    conversation_node[conv_id] = node_id
    await node_connections[node_id].send_text(json.dumps(node_msg, ensure_ascii=False))
    return True


async def _persist_and_broadcast(conv_id: str, msg: dict, role: str = "agent"):
    await _save_message(msg, role)
    await _broadcast_to_conversation(conv_id, json.dumps(msg, ensure_ascii=False))



async def _answer_with_platform_agent(conv_id: str, user_id: str, text: str, agent_source: str = "platform", mode: str = "platform_chat", agent_node_id: str | None = None):
    if mode == "snapshot_qa":
        answer = await answer_snapshot_qa(conv_id, user_id, text, agent_source)
    else:
        answer = await answer_platform_chat(conv_id, user_id, text)
    display_node_id = str(PLATFORM_AGENT_NODE_ID) if agent_source == "platform" else agent_node_id
    if display_node_id:
        answer["agent_node_id"] = str(display_node_id)
        if isinstance(answer.get("content"), dict):
            answer["content"]["agent_node_id"] = str(display_node_id)
    await _save_message(answer, "agent")
    await _broadcast_to_conversation(conv_id, json.dumps(answer, ensure_ascii=False))


async def _recent_room_chat_turns(conv_id: str, *, limit: int = 12) -> list[dict]:
    """Prior user/agent text turns for multi-turn expert room chat (LLM context)."""
    try:
        from app.db.base import async_session
        from app.models.message import Message

        async with async_session() as db:
            result = await db.execute(
                select(Message)
                .where(Message.conversation_id == uuid.UUID(conv_id))
                .order_by(Message.created_at.desc())
                .limit(max(1, min(limit, 40)))
            )
            rows = list(reversed(result.scalars().all()))
    except Exception as e:
        print(f"[WS] load room chat turns error: {e}")
        return []

    turns: list[dict] = []
    for row in rows:
        content = row.content if isinstance(row.content, dict) else {}
        text = str(content.get("text") or content.get("display_text") or "").strip()
        if not text:
            continue
        role = str(row.role or "").strip().lower()
        if role == "user":
            turns.append({"role": "user", "content": text})
        elif role in {"agent", "assistant", "system"}:
            # Only chat text — skip status/task_complete noise.
            msg_type = str(getattr(row, "msg_type", "") or content.get("type") or "text")
            if msg_type in {"text", "agent_text", ""} or content.get("agent_mode"):
                turns.append({"role": "assistant", "content": text})
    return turns


async def _reply_expert_preamble(conv_id: str, msg: dict, decision) -> None:
    """
    Expert selected, no authorized target yet: LLM-authored room chat only.

    Does not bind node workers, does not set conversation running, does not open
    a Node work burst. User-visible wording comes from the model — never a
    hardcoded monologue.
    """
    expert_name = str(msg.get("expert_name") or "").strip().lstrip("@") or "渗透专家"
    expert_id = str(msg.get("expert_id") or "").strip() or None
    eng = str(msg.get("engagement") or msg.get("role") or "").strip() or None
    node_id = str(
        getattr(decision, "agent_node_id", None)
        or msg.get("agent_node_id")
        or ""
    ).strip() or None
    user_text = str(msg.get("text") or msg.get("display_text") or "").strip()

    await _remember_conversation_expert(
        conv_id,
        expert_id=expert_id,
        expert_name=expert_name,
        engagement=eng,
    )

    recent = await _recent_room_chat_turns(conv_id)
    # Drop the just-saved current user turn from history so we do not double-send it.
    if recent and recent[-1].get("role") == "user" and str(recent[-1].get("content") or "").strip() == user_text:
        recent = recent[:-1]

    answer = await answer_expert_room_chat(
        conv_id,
        user_text,
        expert_name=expert_name,
        expert_id=expert_id,
        engagement=eng,
        recent_turns=recent,
    )
    if isinstance(answer.get("content"), dict):
        answer["content"]["expert_name"] = expert_name
        if expert_id:
            answer["content"]["expert_id"] = expert_id
    if node_id:
        answer["agent_node_id"] = node_id
        if isinstance(answer.get("content"), dict):
            answer["content"]["agent_node_id"] = node_id
    _apply_agent_attribution(
        answer,
        agent_source="pentest",
        agent_node_id=str(node_id or PLATFORM_AGENT_NODE_ID),
    )
    await _persist_and_broadcast(conv_id, answer, "agent")


async def _broadcast_to_conversation(conv_id: str, raw: str):
    if conv_id in conversation_subscribers:
        for sub in list(conversation_subscribers[conv_id]):
            try:
                await sub.send_text(raw)
            except Exception:
                conversation_subscribers[conv_id].discard(sub)


@router.websocket("/ws")
async def websocket_endpoint(ws: WebSocket, token: str = Query(...)):
    await ws.accept()

    try:
        import jwt
        from app.config import settings

        payload = jwt.decode(token, settings.JWT_SECRET, algorithms=[settings.JWT_ALGORITHM])
        client_type = "user"
        client_id = payload["sub"]
    except Exception:
        client_type = "node"
        client_id = await _find_node_by_token(token)

    if client_type == "node" and client_id:
        # Replace any stale socket for this node. Closing the old one must NOT mark
        # the node offline (see finally: only the active socket may go offline).
        old_ws = node_connections.get(client_id)
        node_connections[client_id] = ws
        if old_ws is not None and old_ws is not ws:
            try:
                await old_ws.close(code=4000, reason="replaced by new connection")
            except Exception:
                pass
        await _update_node_status(client_id, "online", ip=str(ws.client.host) if ws.client else None)
        print(f"[WS] NODE ONLINE: {client_id[:8]} (total nodes: {len(node_connections)})")

    try:
        while True:
            raw = await ws.receive_text()
            msg = json.loads(raw)
            conv_id = msg.get("conversation_id")

            if client_type == "node":
                # Isolate each inbound node message so one bad payload cannot drop
                # the websocket and lose a subsequent task_complete (timer stuck running).
                try:
                    await _handle_node_message(ws, client_id, msg, conv_id)
                except Exception as e:
                    print(f"[WS] node message handler error type={msg.get('type')}: {e}")

            elif client_type == "user":
                if msg.get("type") == "subscribe" and conv_id:
                    conversation_subscribers.setdefault(conv_id, set()).add(ws)
                    continue

                if conv_id:
                    conversation_subscribers.setdefault(conv_id, set()).add(ws)
                    await _save_message(msg, "user")

                if msg.get("type") == "user_message" and conv_id:
                    conversation_status = await _conversation_status(conv_id)
                    resume_context = await _conversation_snapshot(conv_id, client_id)
                    _, bound_node = await _conversation_owner(conv_id)
                    bound_node_id = conversation_node.get(conv_id) or (str(bound_node) if bound_node else None)
                    capabilities = await _available_agent_capabilities()
                    # @Expert mention designates participant in the shared room (node is the seat).
                    requested_node_id, msg = await _resolve_mention_route(msg, capabilities)
                    if msg.get("expert_id") or msg.get("expert_name"):
                        await _remember_conversation_expert(
                            conv_id,
                            expert_id=str(msg.get("expert_id") or "") or None,
                            expert_name=str(msg.get("expert_name") or "") or None,
                            engagement=str(msg.get("engagement") or msg.get("role") or "") or None,
                        )
                    requested_agent = _agent_target_for_request(msg, requested_node_id, capabilities)
                    if _should_use_sticky_node_binding(
                        conversation_status=conversation_status,
                        requested_node_id=requested_node_id,
                        bound_node_id=bound_node_id,
                    ):
                        # Mid-task only: keep talking to the active expert/worker.
                        steer_msg = await _hydrate_sticky_expert_on_message(conv_id, msg)
                        bound_capability = next((item.capability for item in capabilities if item.node_id == bound_node_id), None)
                        sent = await _send_direct_node_message(conv_id, bound_node_id, steer_msg, bound_capability)
                        await _audit(
                            actor_type="user",
                            actor_id=uuid.UUID(client_id),
                            action="user_steer",
                            resource_type="conversation",
                            resource_id=uuid.UUID(conv_id),
                            conversation_id=uuid.UUID(conv_id),
                            detail={
                                "sent": sent,
                                "source": "sticky_mid_task",
                                "node_id": bound_node_id,
                                "capability": bound_capability,
                                "conversation_status": conversation_status,
                                "expert_id": str(steer_msg.get("expert_id") or "") or None,
                            },
                        )
                        if sent:
                            continue
                        await _persist_and_broadcast(conv_id, {
                            "type": "task_error",
                            "conversation_id": conv_id,
                            "message": "Bound expert runtime is unavailable. @ another online expert to switch, or wait for the node to reconnect.",
                            "agent_source": "platform",
                            "agent_node_id": str(PLATFORM_AGENT_NODE_ID),
                        }, "agent")
                        continue
                    has_resume_task = _has_resumable_task(resume_context)
                    # Pre-target chat (e.g. "你好" with 渗透大师 selected): never open a work
                    # burst / bind node / flip status to running. Expert-voiced room reply only.
                    # Structured signal only — explicit expert seat + no target + no resumable task.
                    if (
                        requested_agent
                        and requested_agent != "platform"
                        and (requested_node_id or msg.get("expert_id") or msg.get("expert_name"))
                        and not _message_has_task_target(msg)
                        and not has_resume_task
                        and not _is_active_runtime_status(conversation_status)
                    ):
                        from app.services.agent_router import RoutingDecision

                        await _reply_expert_preamble(
                            conv_id,
                            msg,
                            RoutingDecision(
                                action="platform_reply",
                                capability="platform.chat",
                                mode="expert_preamble",
                                agent=requested_agent,
                                agent_node_id=requested_node_id,
                                requires_target=False,
                                reason="router fast-path: expert selected, no task target",
                            ),
                        )
                        continue
                    # After failed/incomplete, short "继续" must resume — do not rely on the planner
                    # alone (it often answer_user's and leaves the user with no node activity).
                    force_continue = (
                        str(conversation_status or "").lower() in {"failed", "incomplete", "paused", "canceled"}
                        and has_resume_task
                        and _looks_like_continue_request(str(msg.get("text") or ""))
                        and (requested_agent or "pentest") != "platform"
                    )
                    try:
                        if force_continue:
                            from app.services.agent_router import RoutingDecision

                            decision = RoutingDecision(
                                action="continue_task",
                                capability="pentest.web",
                                mode="resume_after_terminal",
                                agent="pentest",
                                agent_node_id=requested_node_id or bound_node_id,
                                reason="policy forced continue_task after failed/incomplete with resumable task",
                            )
                        else:
                            decision = await route_with_platform_agent(
                                text=str(msg.get("text") or ""),
                                context=OrchestrationContext(
                                    conversation_status=conversation_status,
                                    requested_agent=requested_agent,
                                    requested_node_id=requested_node_id,
                                    has_resume_task=has_resume_task,
                                    has_bound_node=bool(bound_node_id),
                                    bound_node_id=bound_node_id,
                                    capabilities=capabilities,
                                ),
                            )
                    except OrchestrationError as e:
                        await _persist_and_broadcast(conv_id, {
                            "type": "task_error",
                            "conversation_id": conv_id,
                            "message": f"Platform Agent orchestration failed: {str(e)}",
                            "agent_source": "platform",
                            "agent_node_id": str(PLATFORM_AGENT_NODE_ID),
                        }, "agent")
                        continue

                    if decision.action == "platform_reply":
                        if str(decision.mode or "") == "expert_preamble":
                            # Selected expert, no task target: in-room chat only.
                            # Do not bind/running, do not open right-panel work surface.
                            await _reply_expert_preamble(conv_id, msg, decision)
                            continue
                        await _answer_with_platform_agent(
                            conv_id,
                            client_id,
                            msg.get("text", ""),
                            decision.agent or "platform",
                            decision.mode or "platform_chat",
                            decision.agent_node_id,
                        )
                        continue

                    if decision.action == "ask_clarification":
                        # Mid-task: forward to active expert runtime.
                        if (
                            requested_node_id
                            and requested_agent
                            and requested_agent != "platform"
                            and str(requested_node_id) in node_connections
                            and _is_active_runtime_status(conversation_status)
                        ):
                            sent = await _send_direct_node_message(
                                conv_id, requested_node_id, msg, decision.capability or "pentest.web"
                            )
                            await _audit(
                                actor_type="user",
                                actor_id=uuid.UUID(client_id),
                                action="user_steer",
                                resource_type="conversation",
                                resource_id=uuid.UUID(conv_id),
                                conversation_id=uuid.UUID(conv_id),
                                detail={
                                    "sent": sent,
                                    "source": "expert_clarification_steer",
                                    "node_id": requested_node_id,
                                    "capability": decision.capability,
                                    "expert_id": str(msg.get("expert_id") or "") or None,
                                },
                            )
                            if sent:
                                continue
                            await _persist_and_broadcast(conv_id, {
                                "type": "task_error",
                                "conversation_id": conv_id,
                                "message": "Requested expert runtime is unavailable.",
                                "agent_source": "platform",
                                "agent_node_id": str(PLATFORM_AGENT_NODE_ID),
                            }, "agent")
                            continue
                        # Idle + explicit expert: preamble chat (no task), not "已记下专家".
                        if (
                            requested_node_id
                            and requested_agent
                            and requested_agent != "platform"
                        ):
                            await _reply_expert_preamble(conv_id, msg, decision)
                            continue
                        # Platform-only clarification.
                        prompt = (
                            decision.message
                            or "Please provide the target URL or IP and confirm it is in authorized scope."
                        )
                        answer = await answer_clarification(
                            conv_id,
                            prompt,
                            mode=decision.mode or "clarification",
                            agent_source="platform",
                        )
                        _apply_agent_attribution(
                            answer,
                            agent_source="platform",
                            agent_node_id=str(PLATFORM_AGENT_NODE_ID),
                        )
                        await _persist_and_broadcast(conv_id, answer, "agent")
                        continue

                    resumed_from_context = False
                    force_dispatch_resumed_task = False
                    if decision.action == "continue_task":
                        # Mid-task: steer the active worker. After settle: re-dispatch with sticky expert pack.
                        steer_node_id = (
                            decision.agent_node_id
                            or requested_node_id
                            or bound_node_id
                            or conversation_node.get(conv_id)
                        )
                        if (
                            steer_node_id
                            and str(steer_node_id) in node_connections
                            and _is_active_runtime_status(conversation_status)
                        ):
                            steer_base = await _hydrate_sticky_expert_on_message(conv_id, msg)
                            steer_msg = {
                                **steer_base,
                                "type": "user_steer",
                                "conversation_id": conv_id,
                                "agent_node_id": str(steer_node_id),
                            }
                            if decision.capability:
                                steer_msg["agent_capability"] = decision.capability
                            conversation_node[conv_id] = str(steer_node_id)
                            await node_connections[str(steer_node_id)].send_text(
                                json.dumps(steer_msg, ensure_ascii=False)
                            )
                            await _persist_and_broadcast(conv_id, {
                                "type": "status",
                                "conversation_id": conv_id,
                                "text": "已将继续指令发给正在运行的专家（同一会话）。",
                                "status": "running",
                                "agent_source": "platform",
                                "agent_node_id": str(PLATFORM_AGENT_NODE_ID),
                            }, "agent")
                            await _audit(
                                actor_type="user",
                                actor_id=uuid.UUID(client_id),
                                action="user_steer",
                                resource_type="conversation",
                                resource_id=uuid.UUID(conv_id),
                                conversation_id=uuid.UUID(conv_id),
                                detail={
                                    "sent": True,
                                    "source": "continue_mid_task",
                                    "node_id": str(steer_node_id),
                                    "conversation_status": conversation_status,
                                },
                            )
                            continue
                        # Settled or offline: re-dispatch (new work burst) with resume context + sticky expert.
                        resumed_msg, resumed_from_context = _resume_message_from_context(msg, resume_context)
                        if resumed_msg:
                            msg = resumed_msg
                            force_dispatch_resumed_task = True
                        else:
                            await _persist_and_broadcast(conv_id, {
                                "type": "task_error",
                                "conversation_id": conv_id,
                                "message": "无法继续：绑定的渗透节点不在线，且没有可恢复的目标任务上下文。请确认节点在线后重新发送目标 URL/IP。",
                                "agent_source": "platform",
                                "agent_node_id": str(PLATFORM_AGENT_NODE_ID),
                            }, "agent")
                            continue

                    if decision.action == "dispatch_node" or force_dispatch_resumed_task:
                        if decision.mode == "completed_followup" and not decision.targets:
                            resumed_msg, resumed_from_context = _resume_message_from_context(msg, resume_context, include_checkpoint=False)
                            if resumed_msg:
                                msg = resumed_msg
                            elif decision.requires_target:
                                answer_agent_source, answer_agent_node_id = _decision_agent_attribution(decision)
                                answer = await answer_clarification(
                                    conv_id,
                                    "Please provide the target URL/IP to continue or retest.",
                                    mode="clarification",
                                    agent_source=answer_agent_source,
                                )
                                _apply_agent_attribution(answer, agent_source=answer_agent_source, agent_node_id=answer_agent_node_id)
                                await _persist_and_broadcast(conv_id, answer, "agent")
                                continue

                        try:
                            eligible_node_ids = await _eligible_node_ids_for_capability(decision.capability)
                        except OrchestrationError as e:
                            await _persist_and_broadcast(conv_id, {
                                "type": "task_error",
                                "conversation_id": conv_id,
                                "message": f"Platform Agent dispatch failed: {str(e)}",
                                "agent_source": "platform",
                                "agent_node_id": str(PLATFORM_AGENT_NODE_ID),
                            }, "agent")
                            continue
                        if eligible_node_ids:
                            msg = _message_with_decision_target(msg, decision)
                            # Expert is routing primary: sticky → auto-pick expert for pack → pack fallback.
                            msg = await _ensure_expert_on_dispatch(
                                conv_id,
                                msg,
                                capability=decision.capability,
                                preferred_node_id=decision.agent_node_id,
                                eligible_node_ids=eligible_node_ids,
                            )
                            task_msg = _task_assign_from_user_message(conv_id, msg, str(uuid.uuid4()))
                            task_msg = await _merge_case_roe_into_task_assign(conv_id, task_msg)
                            task_msg = await _attach_case_context_to_task_assign(conv_id, task_msg)
                            task_target = task_msg["target"]
                            task_scope = task_msg["scope"]
                            task_instruction = task_msg["initial_instruction"]
                            task_goal = str(task_msg.get("goal_objective") or "").strip() or None
                            task_engagement = str(task_msg.get("engagement") or "").strip() or None
                            task_expert_id = str(msg.get("expert_id") or task_msg.get("expert_id") or "").strip() or None
                            task_expert_name = str(msg.get("expert_name") or task_msg.get("expert_name") or "").strip() or None
                            task_eng_template = (
                                str(task_msg.get("engagement_template") or "").strip() or None
                            )
                            task_allow_postex = task_msg.get("allow_postex")
                            if not isinstance(task_allow_postex, bool):
                                task_allow_postex = None
                            await _remember_conversation_task(
                                conv_id,
                                target=task_target,
                                scope=task_scope,
                                instruction=task_instruction,
                                goal_objective=task_goal,
                                engagement=task_engagement,
                                expert_id=task_expert_id,
                                expert_name=task_expert_name,
                                engagement_template=task_eng_template,
                                allow_postex=task_allow_postex,
                                accounts=task_msg.get("accounts"),
                            )
                            global _round_robin_counter
                            preferred_node_id = (
                                _agent_node_id(msg)
                                or decision.agent_node_id
                            )
                            if preferred_node_id and preferred_node_id not in eligible_node_ids:
                                await _persist_and_broadcast(conv_id, {
                                    "type": "task_error",
                                    "conversation_id": conv_id,
                                    "message": f"Requested expert runtime is unavailable for capability {decision.capability}.",
                                    "agent_source": "platform",
                                    "agent_node_id": str(PLATFORM_AGENT_NODE_ID),
                                }, "agent")
                                continue
                            node_ids = eligible_node_ids
                            if preferred_node_id:
                                node_id = preferred_node_id
                            else:
                                idx = _round_robin_counter % len(node_ids)
                                _round_robin_counter += 1
                                node_id = node_ids[idx]
                            # Dispatch gate: engagement pack must be in node's offers.
                            gate_err = await _gate_engagement_for_node(
                                node_id, task_msg.get("engagement") or msg.get("engagement") or msg.get("role")
                            )
                            if gate_err:
                                await _persist_and_broadcast(conv_id, {
                                    "type": "task_error",
                                    "conversation_id": conv_id,
                                    "message": gate_err,
                                    "agent_source": "platform",
                                    "agent_node_id": str(PLATFORM_AGENT_NODE_ID),
                                }, "agent")
                                continue
                            await _bind_conversation_to_node(
                                conv_id, node_id, active_task_id=str(task_msg.get("task_id") or "")
                            )
                            # Optimistic working until Node work_status confirms busy.
                            working_payload = await _apply_worker_state(
                                conv_id,
                                node_id=node_id,
                                working=True,
                                task_id=task_msg.get("task_id"),
                                expert_id=task_expert_id,
                                expert_name=task_expert_name,
                                interrupt_pending=False,
                            )
                            await _broadcast_conversation_working(working_payload)
                            await _incr_sessions(node_id, 1)
                            task_msg["agent_node_id"] = node_id
                            task_msg["agent_capability"] = decision.capability
                            if task_expert_id:
                                task_msg["expert_id"] = task_expert_id
                            if task_expert_name:
                                task_msg["expert_name"] = task_expert_name
                            snapshot = await _conversation_snapshot(conv_id, client_id)
                            if "checkpoint" in msg:
                                snapshot["checkpoint"] = msg.get("checkpoint") or {}
                            elif not resumed_from_context:
                                snapshot["checkpoint"] = {}
                            # Preserve structured engagement on snapshot for the worker.
                            if task_msg.get("engagement"):
                                if not isinstance(snapshot, dict):
                                    snapshot = {}
                                snapshot = dict(snapshot)
                                snapshot["engagement"] = task_msg["engagement"]
                                if task_msg.get("role"):
                                    snapshot["role"] = task_msg["role"]
                            task_msg["snapshot"] = snapshot
                            worker_limits = await _worker_limits_for_node(node_id)
                            if worker_limits:
                                task_msg["worker_limits"] = worker_limits
                            # Announce expert handoff (not silent node dispatch).
                            if force_dispatch_resumed_task or _should_announce_agent_assignment(requested_node_id, msg):
                                await _announce_agent_assignment(
                                    conv_id,
                                    decision,
                                    node_id,
                                    expert_name=task_expert_name,
                                )
                            if force_dispatch_resumed_task:
                                resume_label = (
                                    f"专家「{task_expert_name}」"
                                    if task_expert_name
                                    else "专家"
                                )
                                await _persist_and_broadcast(conv_id, {
                                    "type": "status",
                                    "conversation_id": conv_id,
                                    "text": f"任务已重新交给{resume_label}，正在从上次进度继续…",
                                    "status": "running",
                                    "agent_source": "platform",
                                    "agent_node_id": str(PLATFORM_AGENT_NODE_ID),
                                }, "agent")
                            await node_connections[node_id].send_text(json.dumps(task_msg, ensure_ascii=False))
                            continue

                        await _persist_and_broadcast(conv_id, {
                            "type": "task_error",
                            "conversation_id": conv_id,
                            "message": f"No online agent node provides capability {decision.capability}.",
                            "agent_source": "platform",
                            "agent_node_id": str(PLATFORM_AGENT_NODE_ID),
                        }, "agent")
                elif msg.get("type") == "user_decision" and conv_id:
                    request_id = msg.get("request_id")
                    decision = msg.get("decision", "cancel")
                    approval = pending_approvals.pop(request_id, {}) if request_id else {}
                    node_msg = {
                        "type": "user_input",
                        "conversation_id": conv_id,
                        "request_id": request_id,
                        "response": decision,
                        "decision": decision,
                    }
                    sent = await _send_to_bound_node(conv_id, json.dumps(node_msg))
                    await _audit(
                        actor_type="user",
                        actor_id=uuid.UUID(client_id),
                        action=f"approval.{decision}",
                        resource_type="conversation",
                        resource_id=uuid.UUID(conv_id),
                        conversation_id=uuid.UUID(conv_id),
                        detail={"request_id": request_id, "sent": sent, "node_id": approval.get("node_id")},
                    )

                elif msg.get("type") in ("user_steer", "user_interrupt") and conv_id:
                    if msg.get("type") == "user_interrupt":
                        action = str(msg.get("action") or "cancel").lower()
                        # Keep session status=running while experts wind down; fan-out
                        # interrupt to every worker on this conversation (not only sticky bind).
                        fanout = await _interrupt_all_session_workers(conv_id, msg)
                        sent_to = fanout.get("sent_to") or []
                        if sent_to:
                            # Ensure each target is tracked as working so UI stays on
                            # Interrupt until every node emits work_status(idle).
                            working_payload = {
                                "type": "conversation_working",
                                "conversation_id": conv_id,
                                "working": True,
                                "status": "running",
                                "workers": [],
                                "interrupting": True,
                            }
                            for nid in sent_to:
                                working_payload = await _apply_worker_state(
                                    conv_id,
                                    node_id=nid,
                                    working=True,
                                    interrupt_pending=True,
                                    reason="interrupt" if action != "pause" else "pause",
                                )
                            working_payload["interrupting"] = True
                            working_payload["working"] = True
                        else:
                            # No online runtime — clear ghost workers and leave interrupt mode.
                            working_payload = await _apply_worker_state(
                                conv_id,
                                working=False,
                                interrupt_pending=False,
                                clear_all_workers=True,
                                reason="not_busy",
                            )
                            await _set_conversation_status(
                                conv_id,
                                "paused" if action == "pause" else "canceled",
                            )
                            working_payload["status"] = "paused" if action == "pause" else "canceled"
                            working_payload["working"] = False
                        await _broadcast_conversation_working(working_payload)
                        if sent_to:
                            note = (
                                f"已向 {len(sent_to)} 个专家运行时发送中止，正在停止本会话全部工作…"
                                if action != "pause"
                                else f"已向 {len(sent_to)} 个专家运行时发送暂停…"
                            )
                        else:
                            note = "当前会话没有在线专家在工作，已解除运行态。"
                        await _persist_and_broadcast(conv_id, {
                            "type": "status",
                            "conversation_id": conv_id,
                            "text": note,
                            "status": "running" if sent_to else ("paused" if action == "pause" else "canceled"),
                            "working": bool(sent_to),
                            "agent_source": "platform",
                            "agent_node_id": str(PLATFORM_AGENT_NODE_ID),
                        }, "agent")
                        await _audit(
                            actor_type="user",
                            actor_id=uuid.UUID(client_id),
                            action=msg.get("type"),
                            resource_type="conversation",
                            resource_id=uuid.UUID(conv_id),
                            conversation_id=uuid.UUID(conv_id),
                            detail={"sent_to": sent_to, "targets": fanout.get("targets"), "action": action},
                        )
                    else:
                        sent = await _send_to_bound_node(conv_id, raw)
                        await _audit(
                            actor_type="user",
                            actor_id=uuid.UUID(client_id),
                            action=msg.get("type"),
                            resource_type="conversation",
                            resource_id=uuid.UUID(conv_id),
                            conversation_id=uuid.UUID(conv_id),
                            detail={"sent": sent, "action": msg.get("action")},
                        )

    except WebSocketDisconnect:
        pass
    finally:
        for conv_id, subs in list(conversation_subscribers.items()):
            subs.discard(ws)
            if not subs:
                del conversation_subscribers[conv_id]

        if client_type == "node" and client_id:
            # Only the currently registered socket may mark the node offline.
            # Without this check, a reconnect race (new socket online → old finally)
            # would pop the new connection and emit a false node.offline audit.
            if node_connections.get(client_id) is ws:
                node_connections.pop(client_id, None)
                await _update_node_status(client_id, "offline")
                # Prevent stuck timers when the node dies after finish_scan but
                # before task_complete is processed.
                await _settle_running_conversations_for_node(client_id, reason="node_offline")
