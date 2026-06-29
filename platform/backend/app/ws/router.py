import json
import hashlib
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect
from sqlalchemy import select

from app.services.conversation_state import ConversationStatusError, transition_conversation

router = APIRouter()

node_connections: dict[str, WebSocket] = {}
conversation_subscribers: dict[str, set[WebSocket]] = {}
conversation_node: dict[str, str] = {}
pending_approvals: dict[str, dict] = {}
_round_robin_counter: int = 0


def _uuid(value: str | uuid.UUID | None) -> uuid.UUID | None:
    if not value:
        return None
    if isinstance(value, uuid.UUID):
        return value
    try:
        return uuid.UUID(str(value))
    except ValueError:
        return None


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


async def _update_node_status(node_id: str, status: str, ip: str | None = None):
    try:
        from app.db.base import async_session
        from app.models.node import Node

        async with async_session() as db:
            result = await db.execute(select(Node).where(Node.id == uuid.UUID(node_id)))
            node = result.scalar_one_or_none()
            if node:
                node.status = status
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


async def _bind_conversation_to_node(conv_id: str, node_id: str):
    try:
        from app.db.base import async_session
        from app.models.conversation import Conversation

        async with async_session() as db:
            r = await db.execute(select(Conversation).where(Conversation.id == uuid.UUID(conv_id)))
            c = r.scalar_one_or_none()
            if c:
                c.node_id = uuid.UUID(node_id)
                transition_conversation(c, "running")
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


async def _save_message(msg: dict, role: str) -> uuid.UUID | None:
    try:
        from app.db.base import async_session
        from app.models.message import Message

        conv_id = msg.get("conversation_id")
        if not conv_id:
            return None

        msg_type = msg.get("type", "text")
        if role == "user":
            if msg_type == "user_decision":
                content = {
                    "request_id": msg.get("request_id"),
                    "decision": msg.get("decision"),
                    "text": f"授权决定：{msg.get('decision')}",
                }
                msg_type = "decision"
            else:
                content = {"text": msg.get("text", "")}
                msg_type = "text"
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
            }
        elif msg_type in ("status_update", "phase_changed"):
            msg_type = "status"
            content = {
                "text": f"Phase: {msg.get('phase', '')} (iter {msg.get('iteration', '')})",
                "phase": msg.get("phase"),
                "iteration": msg.get("iteration"),
                "active_tool": msg.get("active_tool"),
            }
        elif msg_type == "request_decision":
            msg_type = "confirm_card"
            content = {
                "request_id": msg.get("request_id"),
                "risk_level": msg.get("risk_level", "intrusive"),
                "question": msg.get("question", "是否授权该操作？"),
                "proposed_action": msg.get("proposed_action", ""),
                "target": msg.get("target", ""),
                "expires_at": msg.get("expires_at", ""),
                "options": ["authorize", "cancel"],
            }
        elif msg_type == "task_complete":
            msg_type = "status"
            content = {"text": "任务完成", "summary": msg.get("summary", {})}
        elif msg_type == "task_error":
            msg_type = "status"
            content = {"text": f"任务失败: {msg.get('message', msg.get('error', ''))}"}
        else:
            content = msg

        message_id = uuid.uuid4()
        async with async_session() as db:
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
        return
    user_id, bound_node = await _conversation_owner(conv_id)
    if not user_id:
        return
    node_uuid = _uuid(node_id) or bound_node
    try:
        from app.db.base import async_session
        from app.models.asset import Asset

        address = msg.get("address") or msg.get("affected_asset") or msg.get("target") or "unknown"
        async with async_session() as db:
            existing = await db.execute(select(Asset).where(Asset.user_id == user_id, Asset.address == address))
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
                asset.conversation_id = asset.conversation_id or uuid.UUID(conv_id)
                asset.node_id = asset.node_id or node_uuid
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
    except Exception as e:
        print(f"[WS] persist asset error: {e}")


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
                    properties={
                        "status": msg.get("status"),
                        "stderr": msg.get("stderr", ""),
                    },
                )
                db.add(evidence)
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

async def _persist_vulnerability(msg: dict, node_id: str | None):
    conv_id = msg.get("conversation_id")
    if not conv_id:
        return
    user_id, bound_node = await _conversation_owner(conv_id)
    if not user_id:
        return
    node_uuid = _uuid(node_id) or bound_node
    try:
        from app.db.base import async_session
        from app.models.asset import Asset
        from app.models.vulnerability import Vulnerability

        affected_asset = msg.get("affected_asset") or msg.get("target") or "unknown"
        async with async_session() as db:
            asset_id = None
            if affected_asset != "unknown":
                existing_asset = await db.execute(select(Asset).where(Asset.user_id == user_id, Asset.address == affected_asset))
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
                asset_id = asset.id

            vuln = Vulnerability(
                id=uuid.uuid4(),
                user_id=user_id,
                node_id=node_uuid,
                title=msg.get("title", "未命名漏洞"),
                severity=msg.get("severity", "medium"),
                asset_id=asset_id,
                conversation_id=uuid.UUID(conv_id),
                description=msg.get("description") or msg.get("evidence_summary") or "",
                poc=msg.get("poc") or msg.get("location") or "",
                remediation=msg.get("remediation") or "",
                confidence=str(msg.get("confidence", "medium")),
                status="pending",
                evidence_ids=[str(x) for x in msg.get("evidence_ids", [])],
            )
            db.add(vuln)
            await db.commit()
            await _audit(
                actor_type="agent",
                actor_id=node_uuid or uuid.UUID(int=0),
                action="finding.create",
                resource_type="vulnerability",
                resource_id=vuln.id,
                conversation_id=uuid.UUID(conv_id),
                detail={"title": vuln.title, "severity": vuln.severity},
            )
    except Exception as e:
        print(f"[WS] persist vuln error: {e}")


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


async def _send_to_bound_node(conv_id: str, raw: str) -> bool:
    node_id = conversation_node.get(conv_id)
    if not node_id:
        _, bound_node = await _conversation_owner(conv_id)
        node_id = str(bound_node) if bound_node else None
    if node_id and node_id in node_connections:
        await node_connections[node_id].send_text(raw)
        return True
    return False


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
                if msg.get("type") == "request_decision" and not msg.get("request_id"):
                    msg["request_id"] = str(uuid.uuid4())
                    raw = json.dumps(msg)
                await _save_message(msg, "agent")
                if msg.get("type") == "asset_discovered":
                    await _persist_asset(msg, client_id)
                elif msg.get("type") == "vuln_found":
                    await _persist_vulnerability(msg, client_id)
                elif msg.get("type") in ("tool_output", "evidence_created"):
                    await _persist_evidence(msg, client_id)
                elif msg.get("type") == "request_decision":
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
                    await _broadcast_to_conversation(conv_id, raw)

            elif client_type == "user":
                if msg.get("type") == "subscribe" and conv_id:
                    conversation_subscribers.setdefault(conv_id, set()).add(ws)
                    continue

                if conv_id:
                    conversation_subscribers.setdefault(conv_id, set()).add(ws)
                    await _save_message(msg, "user")

                if msg.get("type") == "user_message" and conv_id:
                    if node_connections:
                        task_msg = {
                            "type": "task_assign",
                            "conversation_id": conv_id,
                            "task_id": str(uuid.uuid4()),
                            "target": msg.get("target") or {},
                            "scope": msg.get("scope") or {"allow": [msg.get("target", {}).get("value")] if msg.get("target") else []},
                            "initial_instruction": msg.get("text", ""),
                        }
                        global _round_robin_counter
                        node_ids = sorted(node_connections.keys())
                        idx = _round_robin_counter % len(node_ids)
                        _round_robin_counter += 1
                        node_id = node_ids[idx]
                        await _bind_conversation_to_node(conv_id, node_id)
                        await _incr_sessions(node_id, 1)
                        await node_connections[node_id].send_text(json.dumps(task_msg))
                    else:
                        await ws.send_text(json.dumps({
                            "type": "task_error",
                            "conversation_id": conv_id,
                            "message": "没有在线节点，任务无法下发",
                        }))

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
