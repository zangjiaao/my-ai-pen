import json
import hashlib
import re
import uuid
from datetime import datetime, timezone
from urllib.parse import urlparse

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect
from sqlalchemy import select

from app.services.conversation_state import ConversationStatusError, transition_conversation
from app.services.agent_router import extract_target
from app.services.agent_orchestrator import AgentCapability, OrchestrationContext, OrchestrationError, route_with_platform_agent
from app.services.platform_agent import answer_clarification, answer_platform_chat, answer_snapshot_qa
from app.services.conversation_snapshot import build_conversation_snapshot
from app.models.node import PLATFORM_AGENT_NODE_ID

router = APIRouter()

node_connections: dict[str, WebSocket] = {}
conversation_subscribers: dict[str, set[WebSocket]] = {}
conversation_node: dict[str, str] = {}
pending_approvals: dict[str, dict] = {}
_round_robin_counter: int = 0

FOLLOW_UP_ACTION_RE = re.compile(
    "\u786e\u8ba4|\u68c0\u67e5|\u67e5\u770b|\u8bbf\u95ee|\u6253\u5f00|\u590d\u6d4b|\u91cd\u6d4b|\u91cd\u65b0\u6d4b|\u7ee7\u7eed\u6d4b|\u9a8c\u8bc1|\u8bf7\u6c42|\u6293\u53d6|\u767b\u5f55|\u770b\u4e00\u4e0b|"
    r"\b(check|confirm|verify|retest|rerun|visit|open|fetch|request|scan|test|login)\b",
    re.IGNORECASE,
)


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


def _finding_audit_action(*, created: bool, raw_status: str, stored_status: str) -> str:
    raw = str(raw_status or "").lower()
    if raw == "confirmed" or stored_status == "confirmed":
        return "finding.confirm"
    if raw in {"rejected", "false_positive"} or stored_status == "false_positive":
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
    try:
        from app.db.base import async_session
        from app.models.node import Node

        async with async_session() as db:
            result = await db.execute(select(Node).where(Node.id == uuid.UUID(node_id)))
            node = result.scalar_one_or_none()
            if node:
                node.status = status
                if status == "offline":
                    node.current_sessions = 0
                node.last_heartbeat = datetime.now(timezone.utc)
                if ip:
                    node.ip = ip
                await db.commit()
                await _audit(
                    actor_type="node",
                    actor_id=uuid.UUID(node_id),
                    action=f"node.{status}",
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

async def _bind_conversation_to_node(conv_id: str, node_id: str):
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
                    detail={"node_id": node_id},
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
    capabilities = [
        AgentCapability(agent_type="platform", capability="platform.chat", node_id=str(PLATFORM_AGENT_NODE_ID), name="Platform Agent", online=True),
        AgentCapability(agent_type="platform", capability="snapshot.qa", node_id=str(PLATFORM_AGENT_NODE_ID), name="Platform Agent", online=True),
    ]
    if not node_connections:
        return capabilities

    try:
        from app.db.base import async_session
        from app.models.node import Node

        node_ids = [_uuid(item) for item in node_connections.keys()]
        node_ids = [item for item in node_ids if item]
        async with async_session() as db:
            result = await db.execute(select(Node).where(Node.id.in_(node_ids)))
            nodes = {str(item.id): item for item in result.scalars().all()}
    except Exception as e:
        raise OrchestrationError(f"Failed to load agent capabilities: {str(e)[:300]}") from e

    for node_id in sorted(node_connections.keys()):
        node = nodes.get(node_id)
        if not node:
            raise OrchestrationError(f"Connected node {node_id} is missing from the node registry")
        node_type = str(node.type)
        capabilities.append(AgentCapability(
            agent_type=node_type,
            capability=_capability_for_node_type(node_type),
            node_id=node_id,
            name=str(getattr(node, "name", None) or node_type),
            online=True,
        ))
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

def _message_dedupe_key(*, role: str, original_type: str, stored_type: str, content: dict) -> str | None:
    if role == "user":
        client_message_id = content.get("client_message_id")
        return f"user:{client_message_id}" if client_message_id else None
    if original_type == "tool_output":
        tool_run_id = content.get("tool_run_id")
        return f"tool:{tool_run_id}" if tool_run_id else None
    if original_type in {"status_update", "phase_changed"}:
        return "status:{phase}:{iteration}:{active_tool}:{status}".format(
            phase=content.get("phase") or "",
            iteration=content.get("iteration") or "",
            active_tool=content.get("active_tool") or "",
            status=content.get("status") or "",
        )
    if original_type == "request_decision":
        request_id = content.get("request_id")
        return f"approval:{request_id}" if request_id else None
    if original_type == "task_error":
        return f"task_error:{hashlib.sha256(str(content.get('text') or '').encode()).hexdigest()[:16]}"
    if original_type == "task_complete":
        return "task_complete"
    if original_type in {"evidence_created", "vuln_found", "asset_discovered"}:
        stable_id = content.get("evidence_id") or content.get("id") or content.get("vulnerability_id") or content.get("asset_id")
        return f"{original_type}:{stable_id}" if stable_id else None
    return None


def _append_tool_stdout(current: object, incoming: object) -> str:
    current_stdout = str(current or "")
    incoming_stdout = str(incoming or "")
    if incoming_stdout and incoming_stdout not in current_stdout:
        separator = "" if current_stdout.endswith("\n") or not current_stdout else "\n"
        return f"{current_stdout}{separator}{incoming_stdout}"
    return current_stdout or incoming_stdout


def _tool_item_from_content(content: dict) -> dict:
    return {
        "tool_name": content.get("tool_name", ""),
        "tool_run_id": content.get("tool_run_id"),
        "command": content.get("command", ""),
        "status": content.get("status", "running"),
        "stdout": content.get("stdout", ""),
        "evidence_id": content.get("evidence_id"),
    }


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
            merged.append({
                **item,
                **incoming_item,
                "command": incoming_item.get("command") or item.get("command") or "",
                "stdout": _append_tool_stdout(item.get("stdout"), incoming_item.get("stdout")),
                "status": incoming_item.get("status") or item.get("status") or "running",
                "evidence_id": incoming_item.get("evidence_id") or item.get("evidence_id"),
            })
            updated = True
        else:
            merged.append(item)

    if not updated:
        merged.append(incoming_item)
    return merged


def _merge_saved_message_content(existing: dict, incoming: dict, msg_type: str) -> dict:
    if msg_type != "tool_call":
        return {**existing, **incoming}
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
        elif msg_type == "text":
            inner = msg.get("content", {})
            content = {"text": inner.get("text", str(msg)) if isinstance(inner, dict) else str(inner)}
        elif msg_type == "tool_output":
            msg_type = "tool_call"
            content = {
                "tool_name": msg.get("tool_name", ""),
                "tool_run_id": msg.get("tool_run_id"),
                "command": msg.get("command", ""),
                "status": msg.get("status", "running"),
                "stdout": msg.get("line", ""),
                "evidence_id": msg.get("evidence_id"),
            }
            content["tool_items"] = [_tool_item_from_content(content)]
        elif msg_type in ("status_update", "phase_changed"):
            msg_type = "status"
            content = {
                "text": f"Phase: {msg.get('phase', '')} (iter {msg.get('iteration', '')})",
                "phase": msg.get("phase"),
                "iteration": msg.get("iteration"),
                "active_tool": msg.get("active_tool"),
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
        elif msg_type == "task_complete":
            msg_type = "status"
            content = {"text": "Task complete", "summary": msg.get("summary", {})}
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

        dedupe_key = _message_dedupe_key(role=role, original_type=str(original_type), stored_type=str(msg_type), content=content)
        if dedupe_key:
            content["dedupe_key"] = dedupe_key

        message_id = uuid.uuid4()
        msg["message_id"] = str(message_id)
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
    conv_id = msg.get("conversation_id")
    if not conv_id:
        return None
    user_id, bound_node = await _conversation_owner(conv_id)
    if not user_id:
        return None
    node_uuid = _uuid(node_id) or bound_node
    try:
        from app.db.base import async_session
        from app.models.asset import Asset

        address = _asset_address(msg.get("address") or msg.get("affected_asset") or msg.get("target") or "unknown")
        async with async_session() as db:
            existing = await db.execute(select(Asset).where(Asset.user_id == user_id, Asset.conversation_id == uuid.UUID(conv_id), Asset.address == address))
            asset = existing.scalar_one_or_none()
            if not asset:
                asset = Asset(
                    id=uuid.uuid4(),
                    user_id=user_id,
                    conversation_id=uuid.UUID(conv_id),
                    node_id=node_uuid,
                    name=msg.get("hostname") or address,
                    address=address,
                    type=msg.get("asset_type", "host"),
                    source="agent_discovered",
                    properties={
                        "open_ports": msg.get("open_ports", []),
                        "services": msg.get("services", []),
                    },
                )
                db.add(asset)
            else:
                asset.conversation_id = uuid.UUID(conv_id)
                asset.user_id = asset.user_id or user_id
                asset.node_id = node_uuid or asset.node_id
                asset.name = msg.get("hostname") or asset.name
                asset.type = msg.get("asset_type") or asset.type
                asset.source = "agent_discovered"
                asset.properties = {
                    **(asset.properties or {}),
                    "open_ports": msg.get("open_ports", (asset.properties or {}).get("open_ports", [])),
                    "services": msg.get("services", (asset.properties or {}).get("services", [])),
                }
            await db.commit()
            await _audit(
                actor_type="agent",
                actor_id=node_uuid or uuid.UUID(int=0),
                action="asset.discover",
                resource_type="asset",
                resource_id=asset.id,
                conversation_id=uuid.UUID(conv_id),
                detail={"address": address},
            )
            return {
                "id": str(asset.id),
                "asset_id": str(asset.id),
                "conversation_id": str(asset.conversation_id) if asset.conversation_id else conv_id,
                "node_id": str(asset.node_id) if asset.node_id else None,
                "name": asset.name,
                "address": asset.address,
                "asset_type": asset.type,
                "properties": asset.properties or {},
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
        raw_hash = msg.get("hash") or hashlib.sha256(str(summary).encode()).hexdigest()
        evidence_id = msg.get("evidence_id") or f"ev-{raw_hash[:12]}"
        incoming_properties = msg.get("properties") if isinstance(msg.get("properties"), dict) else {}
        properties = {
            **incoming_properties,
            "status": msg.get("status"),
            "stderr": msg.get("stderr", ""),
        }

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
                    type=msg.get("evidence_type") or msg.get("type", "tool_output"),
                    source_tool=msg.get("source_tool") or msg.get("tool_name"),
                    tool_run_id=tool_run_id,
                    raw_ref=msg.get("raw_ref"),
                    summary=str(summary)[:2000],
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
                evidence.summary = str(summary)[:2000] or evidence.summary
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
        from app.models.asset import Asset
        from app.models.evidence import Evidence
        from app.models.vulnerability import Vulnerability

        context = await _conversation_context(conv_id)
        affected_asset = _asset_address(msg.get("affected_asset") or msg.get("target"))
        if affected_asset == "unknown":
            affected_asset = _target_address_from_context(context)
        title = str(msg.get("title") or "Untitled finding").strip() or "Untitled finding"
        location = msg.get("location") or msg.get("poc") or ""
        poc_value = msg.get("poc") or msg.get("location") or ""

        async with async_session() as db:
            existing_evidence = await db.execute(
                select(Evidence).where(
                    Evidence.conversation_id == uuid.UUID(conv_id),
                    Evidence.evidence_id.in_(evidence_ids),
                )
            )
            known_evidence_ids = {item.evidence_id for item in existing_evidence.scalars().all()}
            if set(evidence_ids) - known_evidence_ids:
                return None

            existing_vulns = (await db.execute(
                select(Vulnerability)
                .where(
                    Vulnerability.user_id == user_id,
                    Vulnerability.conversation_id == uuid.UUID(conv_id),
                    Vulnerability.title == title,
                )
                .order_by(Vulnerability.discovered_at, Vulnerability.id)
            )).scalars().all()
            vuln = existing_vulns[0] if existing_vulns else None
            created = vuln is None

            asset_id = vuln.asset_id if vuln else None
            if affected_asset != "unknown":
                existing_asset = await db.execute(select(Asset).where(Asset.user_id == user_id, Asset.conversation_id == uuid.UUID(conv_id), Asset.address == affected_asset))
                asset = existing_asset.scalar_one_or_none()
                if not asset:
                    asset = Asset(
                        id=uuid.uuid4(),
                        user_id=user_id,
                        conversation_id=uuid.UUID(conv_id),
                        node_id=node_uuid,
                        name=affected_asset,
                        address=affected_asset,
                        type="host",
                        source="agent_discovered",
                    )
                    db.add(asset)
                    await db.flush()
                else:
                    asset.user_id = asset.user_id or user_id
                    asset.conversation_id = asset.conversation_id or uuid.UUID(conv_id)
                    asset.node_id = asset.node_id or node_uuid
                asset_id = asset_id or asset.id

            if not asset_id:
                fallback_address = _target_address_from_context(context)
                if fallback_address == "unknown":
                    fallback_address = f"unknown:{conv_id}"
                existing_asset = await db.execute(select(Asset).where(Asset.user_id == user_id, Asset.conversation_id == uuid.UUID(conv_id), Asset.address == fallback_address))
                asset = existing_asset.scalar_one_or_none()
                if not asset:
                    asset = Asset(
                        id=uuid.uuid4(),
                        user_id=user_id,
                        conversation_id=uuid.UUID(conv_id),
                        node_id=node_uuid,
                        name=fallback_address,
                        address=fallback_address,
                        type="host",
                        source="agent_discovered",
                    )
                    db.add(asset)
                    await db.flush()
                asset_id = asset.id

            if not vuln:
                vuln = Vulnerability(
                    id=uuid.uuid4(),
                    user_id=user_id,
                    node_id=node_uuid,
                    title=title,
                    severity=msg.get("severity", "medium"),
                    asset_id=asset_id,
                    conversation_id=uuid.UUID(conv_id),
                    description=msg.get("description") or msg.get("evidence_summary") or "",
                    poc=poc_value,
                    remediation=msg.get("remediation") or "",
                    confidence=str(msg.get("confidence", "high")),
                    status="confirmed",
                    evidence_ids=evidence_ids,
                )
                db.add(vuln)
            else:
                vuln.user_id = vuln.user_id or user_id
                vuln.node_id = vuln.node_id or node_uuid
                vuln.asset_id = vuln.asset_id or asset_id
                vuln.severity = msg.get("severity") or vuln.severity
                vuln.description = msg.get("description") or msg.get("evidence_summary") or vuln.description
                vuln.poc = poc_value or vuln.poc
                vuln.remediation = msg.get("remediation") or vuln.remediation
                vuln.confidence = str(msg.get("confidence", vuln.confidence or "high"))
                vuln.status = _merge_status(vuln.status, "confirmed")
                vuln.evidence_ids = sorted(set(vuln.evidence_ids or []) | set(evidence_ids))

            for duplicate in existing_vulns[1:]:
                vuln.evidence_ids = sorted(set(vuln.evidence_ids or []) | set(duplicate.evidence_ids or []))
                vuln.description = vuln.description or duplicate.description
                vuln.poc = vuln.poc or duplicate.poc
                vuln.remediation = vuln.remediation or duplicate.remediation
                vuln.asset_id = vuln.asset_id or duplicate.asset_id
                vuln.status = _merge_status(vuln.status, duplicate.status)
                await db.delete(duplicate)

            await db.commit()
            await _audit(
                actor_type="agent",
                actor_id=node_uuid or uuid.UUID(int=0),
                action=_finding_audit_action(created=created, raw_status=raw_status, stored_status=vuln.status),
                resource_type="vulnerability",
                resource_id=vuln.id,
                conversation_id=uuid.UUID(conv_id),
                detail={
                    "title": vuln.title,
                    "severity": vuln.severity,
                    "status": vuln.status,
                    "evidence_gate": "passed",
                    "evidence_ids": vuln.evidence_ids or [],
                    "deduped": max(0, len(existing_vulns) - 1),
                },
            )
            return {
                "id": str(vuln.id),
                "vulnerability_id": str(vuln.id),
                "asset_id": str(vuln.asset_id) if vuln.asset_id else None,
                "conversation_id": str(vuln.conversation_id),
                "node_id": str(vuln.node_id) if vuln.node_id else None,
                "title": vuln.title,
                "severity": vuln.severity,
                "location": vuln.poc or location,
                "confidence": vuln.confidence,
                "status": vuln.status,
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



async def _remember_conversation_task(conv_id: str, *, target: dict, scope: dict, instruction: str):
    try:
        from app.db.base import async_session
        from app.models.conversation import Conversation

        async with async_session() as db:
            r = await db.execute(select(Conversation).where(Conversation.id == uuid.UUID(conv_id)))
            c = r.scalar_one_or_none()
            if not c:
                return
            context = dict(c.context or {})
            context["task"] = {"target": target or {}, "scope": scope or {}, "instruction": instruction or ""}
            c.context = context
            await db.commit()
    except Exception as e:
        print(f"[WS] remember conversation task error: {e}")


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
            context["checkpoint"] = checkpoint
            task = context.get("task") or {}
            if checkpoint.get("target") and not task.get("target"):
                task["target"] = checkpoint.get("target") or {}
            if checkpoint.get("scope") and not task.get("scope"):
                task["scope"] = checkpoint.get("scope") or {}
            if task:
                context["task"] = task
            c.context = context
            await db.commit()
    except Exception as e:
        print(f"[WS] remember conversation checkpoint error: {e}")

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


def _resume_message_from_context(msg: dict, resume_context: dict, *, include_checkpoint: bool = True) -> tuple[dict | None, bool]:
    task_context = resume_context.get("task_context") or resume_context.get("task") or {}
    if not task_context.get("target"):
        return None, False

    base_instruction = str(task_context.get("instruction") or "")
    continue_instruction = str(msg.get("text") or "")
    combined_instruction = f"{base_instruction}\\n\\nUser continuation: {continue_instruction}".strip()
    return {
        **msg,
        "target": task_context.get("target") or {},
        "scope": task_context.get("scope") or {},
        "checkpoint": (resume_context.get("checkpoint") or {}) if include_checkpoint else {},
        "text": combined_instruction,
    }, True


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
    return {
        "type": "task_assign",
        "conversation_id": conv_id,
        "task_id": task_id,
        "target": task_target,
        "scope": task_scope,
        "initial_instruction": msg.get("text", ""),
        "snapshot": msg.get("snapshot") or {},
    }

def _agent_assignment_notice(decision, node_id: str, node_name: str | None = None) -> str:
    agent_label = _agent_label_for_notice(getattr(decision, "agent", "") or _capability_for_notice(getattr(decision, "capability", "")))
    node_label = str(node_name or "").strip() or (node_id[:8] if node_id else "")
    node_part = f"\uff08{node_label}\uff09" if node_label else ""
    capability = str(getattr(decision, "capability", "") or "").strip()
    capability_part = f"\uff0c\u80fd\u529b: {capability}" if capability else ""
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


async def _announce_agent_assignment(conv_id: str, decision, node_id: str) -> None:
    await _persist_and_broadcast(conv_id, {
        "type": "text",
        "conversation_id": conv_id,
        "content": {"text": _agent_assignment_notice(decision, node_id, await _node_name(node_id))},
        "agent_source": "platform",
        "agent_node_id": str(PLATFORM_AGENT_NODE_ID),
    }, "agent")

async def _send_to_bound_node(conv_id: str, raw: str) -> bool:
    node_id = conversation_node.get(conv_id)
    if not node_id:
        _, bound_node = await _conversation_owner(conv_id)
        node_id = str(bound_node) if bound_node else None
    if node_id and node_id in node_connections:
        await node_connections[node_id].send_text(raw)
        return True
    return False


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
        node_connections[client_id] = ws
        await _update_node_status(client_id, "online", ip=str(ws.client.host) if ws.client else None)
        print(f"[WS] NODE ONLINE: {client_id[:8]} (total nodes: {len(node_connections)})")

    try:
        while True:
            raw = await ws.receive_text()
            msg = json.loads(raw)
            conv_id = msg.get("conversation_id")

            if client_type == "node":
                if conv_id:
                    msg["agent_source"] = "pentest"
                    msg["agent_node_id"] = client_id
                    raw = json.dumps(msg, ensure_ascii=False)
                if msg.get("type") == "request_decision" and not msg.get("request_id"):
                    msg["request_id"] = str(uuid.uuid4())
                    raw = json.dumps(msg)
                if msg.get("type") == "asset_discovered":
                    persisted = await _persist_asset(msg, client_id)
                    if persisted:
                        msg.update({k: v for k, v in persisted.items() if v is not None})
                    raw = json.dumps(msg, ensure_ascii=False)
                elif msg.get("type") == "vuln_found":
                    persisted = await _persist_vulnerability(msg, client_id)
                    if persisted:
                        msg.update({k: v for k, v in persisted.items() if v is not None})
                    raw = json.dumps(msg, ensure_ascii=False)
                elif msg.get("type") in ("tool_output", "evidence_created"):
                    await _persist_evidence(msg, client_id)
                    if msg.get("type") == "tool_output":
                        await _audit_tool_output(msg, client_id)
                if msg.get("type") == "checkpoint_update":
                    await _remember_conversation_checkpoint(conv_id, msg.get("checkpoint") or {})
                elif msg.get("type") != "intake_update":
                    await _save_message(msg, "agent")
                if msg.get("type") == "request_decision":
                    request_id = msg.get("request_id") or str(uuid.uuid4())
                    msg["request_id"] = request_id
                    raw = json.dumps(msg)
                    pending_approvals[request_id] = {"conversation_id": conv_id, "node_id": client_id}
                    await _audit(
                        actor_type="agent",
                        actor_id=uuid.UUID(client_id),
                        action="approval.request",
                        resource_type="conversation",
                        resource_id=_uuid(conv_id),
                        conversation_id=_uuid(conv_id),
                        detail={"request_id": request_id, "risk_level": msg.get("risk_level")},
                    )
                elif msg.get("type") in ("task_complete", "task_error"):
                    if msg.get("type") == "task_error":
                        await _record_node_failure(client_id, msg.get("message") or msg.get("error"))
                    if client_id:
                        await _incr_sessions(client_id, -1)
                    if conv_id:
                        try:
                            from app.db.base import async_session
                            from app.models.conversation import Conversation

                            next_status = "completed" if msg.get("type") == "task_complete" else "failed"
                            await _set_conversation_status(conv_id, next_status)
                        except Exception as e:
                            print(f"[WS] update conversation status error: {e}")

                if conv_id:
                    raw = json.dumps(msg, ensure_ascii=False)
                    await _broadcast_to_conversation(conv_id, raw)

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
                    bound_node_id = str(bound_node) if bound_node else conversation_node.get(conv_id)
                    try:
                        decision = await route_with_platform_agent(
                            text=str(msg.get("text") or ""),
                            context=OrchestrationContext(
                                conversation_status=conversation_status,
                                requested_agent=_agent_target(msg),
                                requested_node_id=_agent_node_id(msg),
                                has_resume_task=bool((resume_context.get("task") or {}).get("target")),
                                has_bound_node=bool(bound_node_id),
                                bound_node_id=bound_node_id,
                                capabilities=await _available_agent_capabilities(),
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
                        await _answer_with_platform_agent(conv_id, client_id, msg.get("text", ""), decision.agent or "platform", decision.mode or "platform_chat", decision.agent_node_id)
                        continue

                    if decision.action == "ask_clarification":
                        prompt = decision.message or "Please provide the target URL or IP and confirm it is in authorized scope."
                        answer = await answer_clarification(
                            conv_id,
                            prompt,
                            mode=decision.mode or "clarification",
                        )
                        answer["agent_node_id"] = str(PLATFORM_AGENT_NODE_ID)
                        if isinstance(answer.get("content"), dict):
                            answer["content"]["agent_node_id"] = str(PLATFORM_AGENT_NODE_ID)
                        await _persist_and_broadcast(conv_id, answer, "agent")
                        continue

                    resumed_from_context = False
                    if decision.action == "continue_task":
                        steer_msg = {**msg, "type": "user_steer"}
                        sent = await _send_to_bound_node(conv_id, json.dumps(steer_msg, ensure_ascii=False))
                        if sent:
                            await _audit(
                                actor_type="user",
                                actor_id=uuid.UUID(client_id),
                                action="user_steer",
                                resource_type="conversation",
                                resource_id=uuid.UUID(conv_id),
                                conversation_id=uuid.UUID(conv_id),
                                detail={"sent": sent, "source": "agent_router"},
                            )
                            continue
                        resumed_msg, resumed_from_context = _resume_message_from_context(msg, resume_context)
                        if resumed_msg:
                            msg = resumed_msg
                        else:
                            await _answer_with_platform_agent(conv_id, client_id, msg.get("text", ""), "platform", "platform_chat")
                            continue

                    if decision.action == "dispatch_node":
                        if decision.mode == "completed_followup" and not decision.targets:
                            resumed_msg, resumed_from_context = _resume_message_from_context(msg, resume_context, include_checkpoint=False)
                            if resumed_msg:
                                msg = resumed_msg
                            elif decision.requires_target:
                                answer = await answer_clarification(
                                    conv_id,
                                    "Please provide the target URL/IP to continue or retest.",
                                    mode="clarification",
                                )
                                answer["agent_node_id"] = str(PLATFORM_AGENT_NODE_ID)
                                if isinstance(answer.get("content"), dict):
                                    answer["content"]["agent_node_id"] = str(PLATFORM_AGENT_NODE_ID)
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
                            task_msg = _task_assign_from_user_message(conv_id, msg, str(uuid.uuid4()))
                            task_target = task_msg["target"]
                            task_scope = task_msg["scope"]
                            task_instruction = task_msg["initial_instruction"]
                            if not resumed_from_context:
                                await _remember_conversation_task(conv_id, target=task_target, scope=task_scope, instruction=task_instruction)
                            global _round_robin_counter
                            preferred_node_id = decision.agent_node_id or _agent_node_id(msg)
                            if preferred_node_id and preferred_node_id not in eligible_node_ids:
                                await _persist_and_broadcast(conv_id, {
                                    "type": "task_error",
                                    "conversation_id": conv_id,
                                    "message": f"Requested node is unavailable for capability {decision.capability}.",
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
                            await _bind_conversation_to_node(conv_id, node_id)
                            await _incr_sessions(node_id, 1)
                            task_msg["agent_node_id"] = node_id
                            task_msg["agent_capability"] = decision.capability
                            snapshot = await _conversation_snapshot(conv_id, client_id)
                            if "checkpoint" in msg:
                                snapshot["checkpoint"] = msg.get("checkpoint") or {}
                            elif not resumed_from_context:
                                snapshot["checkpoint"] = {}
                            task_msg["snapshot"] = snapshot
                            await _announce_agent_assignment(conv_id, decision, node_id)
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
                        action = str(msg.get("action") or "").lower()
                        next_status = {"cancel": "canceled", "pause": "paused", "resume": "running"}.get(action)
                        if next_status:
                            await _set_conversation_status(conv_id, next_status)
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
            node_connections.pop(client_id, None)
            await _update_node_status(client_id, "offline")
