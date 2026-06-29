import { useEffect, useRef } from "react";

type MessageHandler = (msg: Record<string, unknown>) => void;

export function useWebSocket(handlers: Record<string, MessageHandler>) {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>();
  const queueRef = useRef<Record<string, unknown>[]>([]);
  const mountedRef = useRef(true);

  const connect = () => {
    const token = localStorage.getItem("access_token");
    if (!token) {
      console.warn("[WS] No token, retrying in 1s...");
      reconnectTimer.current = setTimeout(connect, 1000);
      return;
    }

    const wsUrl = `ws://localhost:8000/ws?token=${token}`;
    console.log("[WS] Connecting to", wsUrl);

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log("[WS] Connected ✓");
      while (queueRef.current.length > 0) {
        const msg = queueRef.current.shift()!;
        ws.send(JSON.stringify(msg));
        console.log("[WS] Sent queued:", msg.type);
      }
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        console.log("[WS] Received:", msg.type);
        const handler = handlers[msg.type as string];
        if (handler) {
          handler(msg);
        } else {
          console.log("[WS] No handler for:", msg.type);
        }
      } catch (e) {
        console.warn("[WS] Parse error:", e);
      }
    };

    ws.onerror = (e) => {
      console.error("[WS] Error:", e);
    };

    ws.onclose = (e) => {
      console.log("[WS] Closed:", e.code, e.reason);
      if (!mountedRef.current) return;
      const delay = Math.min(1000 * Math.pow(2, Math.min(attemptRef.current, 5)), 30000);
      attemptRef.current = Math.min((attemptRef.current || 0) + 1, 5);
      reconnectTimer.current = setTimeout(connect, delay);
    };
  };

  const attemptRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    connect();
    return () => {
      mountedRef.current = false;
      clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, []);

  return {
    send: (msg: Record<string, unknown>) => {
      console.log("[WS] send:", msg.type);
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify(msg));
      } else {
        console.log("[WS] Queuing (state=" + wsRef.current?.readyState + "):", msg.type);
        queueRef.current.push(msg);
      }
    },
  };
}
