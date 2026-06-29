import { useEffect, useRef } from "react";

type MessageHandler = (msg: Record<string, unknown>) => void;

export function useWebSocket(handlers: Record<string, MessageHandler>) {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>();
  const queueRef = useRef<Record<string, unknown>[]>([]);
  const attemptRef = useRef(0);
  const handlersRef = useRef(handlers);
  // 始终保持最新的 handlers
  handlersRef.current = handlers;

  const connect = () => {
    const token = localStorage.getItem("access_token");
    if (!token) {
      reconnectTimer.current = setTimeout(connect, 1000);
      return;
    }

    const wsUrl = `ws://localhost:8000/ws?token=${token}`;
    console.log("[WS] Connecting", wsUrl);

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log("[WS] Connected");
      while (queueRef.current.length > 0) {
        const msg = queueRef.current.shift()!;
        ws.send(JSON.stringify(msg));
      }
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        const h = handlersRef.current[msg.type as string];
        if (h) h(msg);
      } catch { /* ignore */ }
    };

    ws.onclose = () => {
      const delay = Math.min(1000 * Math.pow(2, Math.min(attemptRef.current, 5)), 30000);
      attemptRef.current = Math.min((attemptRef.current || 0) + 1, 5);
      reconnectTimer.current = setTimeout(connect, delay);
    };
  };

  useEffect(() => {
    connect();
    return () => {
      clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, []);

  return {
    send: (msg: Record<string, unknown>) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify(msg));
      } else {
        queueRef.current.push(msg);
      }
    },
  };
}
