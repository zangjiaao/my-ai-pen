import json
from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Query

router = APIRouter()

# 已连接客户端: node_id → WebSocket (节点连接)
# conversation_id → set[WebSocket] (浏览器订阅)
node_connections: dict[str, WebSocket] = {}
conversation_subscribers: dict[str, set[WebSocket]] = {}


@router.websocket("/ws")
async def websocket_endpoint(ws: WebSocket, token: str = Query(...)):
    """统一 WebSocket 端点。token 用于区分节点 vs 用户。
    """
    await ws.accept()

    try:
        import jwt
        from app.config import settings
        payload = jwt.decode(token, settings.JWT_SECRET, algorithms=[settings.JWT_ALGORITHM])
        client_type = "user"
        client_id = payload["sub"]
    except Exception:
        client_type = "node"
        client_id = None

    try:
        while True:
            raw = await ws.receive_text()
            msg = json.loads(raw)

            if client_type == "node":
                # 节点消息 → 广播给订阅该会话的浏览器
                conv_id = msg.get("conversation_id")
                if conv_id and conv_id in conversation_subscribers:
                    for sub in conversation_subscribers[conv_id]:
                        try:
                            await sub.send_text(raw)
                        except Exception:
                            pass

            elif client_type == "user":
                # 用户消息 → 转发给节点
                conv_id = msg.get("conversation_id")
                if conv_id and conv_id in conversation_subscribers:
                    conversation_subscribers[conv_id].add(ws)
                else:
                    conversation_subscribers[conv_id] = {ws}

                # 如果是 steer/interrupt → 转发给对应节点
                if msg.get("type") in ("user_steer", "user_interrupt", "user_input"):
                    for node_ws in node_connections.values():
                        try:
                            await node_ws.send_text(raw)
                        except Exception:
                            pass

    except WebSocketDisconnect:
        pass
    finally:
        # 清理
        for conv_id, subs in list(conversation_subscribers.items()):
            subs.discard(ws)
            if not subs:
                del conversation_subscribers[conv_id]

        if client_type == "node" and client_id:
            node_connections.pop(client_id, None)
