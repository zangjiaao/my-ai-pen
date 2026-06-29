import json
import hashlib
import uuid
from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Query

router = APIRouter()

node_connections: dict[str, WebSocket] = {}  # node_id → ws
conversation_subscribers: dict[str, set[WebSocket]] = {}  # conv_id → {browser_ws}


async def _update_node_status(node_id: str, status: str):
    """更新节点数据库状态"""
    try:
        from app.db.base import async_session
        from app.models.node import Node
        from sqlalchemy import select
        async with async_session() as db:
            result = await db.execute(select(Node).where(Node.id == uuid.UUID(node_id)))
            node = result.scalar_one_or_none()
            if node:
                node.status = status
                await db.commit()
    except Exception:
        pass


async def _find_node_by_token(token: str) -> str | None:
    """根据 token 找到节点 ID"""
    try:
        from app.db.base import async_session
        from app.models.node import Node
        from sqlalchemy import select
        token_hash = hashlib.sha256(token.encode()).hexdigest()
        async with async_session() as db:
            result = await db.execute(select(Node).where(Node.token_hash == token_hash))
            node = result.scalar_one_or_none()
            return str(node.id) if node else None
    except Exception:
        return None


@router.websocket("/ws")
async def websocket_endpoint(ws: WebSocket, token: str = Query(...)):
    await ws.accept()

    # 识别客户端类型
    try:
        import jwt
        from app.config import settings
        payload = jwt.decode(token, settings.JWT_SECRET, algorithms=[settings.JWT_ALGORITHM])
        client_type = "user"
        client_id = payload["sub"]
    except Exception:
        client_type = "node"
        client_id = await _find_node_by_token(token)

    # 节点上线
    if client_type == "node" and client_id:
        node_connections[client_id] = ws
        await _update_node_status(client_id, "online")
        print(f"[WS] NODE ONLINE: {client_id[:8]} (total nodes: {len(node_connections)})")

    if client_type == "user":
        print(f"[WS] USER CONNECTED")

    try:
        while True:
            raw = await ws.receive_text()
            msg = json.loads(raw)

            if client_type == "node":
                print(f"[WS] NODE_MSG received: type={msg.get('type')} conv={str(msg.get('conversation_id',''))[:8]} subs={len(conversation_subscribers.get(msg.get('conversation_id',''), set()))}")
                conv_id = msg.get("conversation_id")
                if conv_id and conv_id in conversation_subscribers:
                    for sub in list(conversation_subscribers[conv_id]):
                        try:
                            await sub.send_text(raw)
                        except Exception:
                            conversation_subscribers[conv_id].discard(sub)

            elif client_type == "user":
                conv_id = msg.get("conversation_id")
                if conv_id:
                    conversation_subscribers.setdefault(conv_id, set()).add(ws)

                # 用户发消息 → 转发给所有在线节点作为 task_assign
                if msg.get("type") == "user_message":
                    print(f"[WS] USER_MSG received. node_connections={len(node_connections)} keys={list(node_connections.keys())}")
                    if node_connections:
                        task_msg = {
                            "type": "task_assign",
                            "conversation_id": conv_id,
                            "task_id": str(uuid.uuid4()),
                            "target": msg.get("target") or {},
                            "initial_instruction": msg.get("text", ""),
                        }
                        for nid, node_ws in list(node_connections.items()):
                            try:
                                await node_ws.send_text(json.dumps(task_msg))
                                print(f"[WS] task_assign SENT to node {nid[:8]}")
                                break  # 只发给第一个可用节点
                            except Exception as e:
                                print(f"[WS] send to node failed: {e}")
                    else:
                        print(f"[WS] NO NODES CONNECTED - dropping message")

                # steer/interrupt 转发给节点
                if msg.get("type") in ("user_steer", "user_interrupt"):
                    for node_ws in node_connections.values():
                        try:
                            await node_ws.send_text(raw)
                        except Exception:
                            pass

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
