import { useCallback, useEffect, useRef } from "react";

type MessageHandler = (msg: Record<string, unknown>) => void;

export function useWebSocket(handlers: Record<string, MessageHandler>) {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>();
  const queueRef = useRef<Record<string, unknown>[]>([]);
  const attemptRef = useRef(0);
  const shouldReconnectRef = useRef(false);
  const connectSeqRef = useRef(0);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  const connect = () => {
    if (!shouldReconnectRef.current) return;

    const token = localStorage.getItem("access_token");
    if (!token) {
      reconnectTimer.current = setTimeout(connect, 1000);
      return;
    }

    if (wsRef.current && wsRef.current.readyState <= WebSocket.OPEN) return;

    const connectSeq = ++connectSeqRef.current;
    const explicitWsUrl = import.meta.env.VITE_WS_URL as string | undefined;
    const backendUrl = (import.meta.env.VITE_BACKEND_URL as string | undefined) || "http://localhost:8000";
    const wsBase = explicitWsUrl || backendUrl.replace(/^http/, "ws");
    const wsUrl = `${wsBase.replace(/\/$/, "")}/ws?token=${token}`;
    console.log("[WS] Connecting", wsUrl);

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      if (connectSeq !== connectSeqRef.current || wsRef.current !== ws) return;
      console.log("[WS] Connected");
      attemptRef.current = 0;
      while (queueRef.current.length > 0) {
        const msg = queueRef.current.shift()!;
        ws.send(JSON.stringify(msg));
      }
    };

    ws.onmessage = (event) => {
      if (connectSeq !== connectSeqRef.current || wsRef.current !== ws) return;
      try {
        const msg = JSON.parse(event.data);
        const h = handlersRef.current[msg.type as string];
        if (h) h(msg);
      } catch {
        // Ignore malformed websocket messages.
      }
    };

    ws.onclose = () => {
      if (!shouldReconnectRef.current || connectSeq !== connectSeqRef.current || wsRef.current !== ws) return;
      wsRef.current = null;
      const delay = Math.min(1000 * Math.pow(2, Math.min(attemptRef.current, 5)), 30000);
      attemptRef.current = Math.min((attemptRef.current || 0) + 1, 5);
      reconnectTimer.current = setTimeout(connect, delay);
    };
  };

  useEffect(() => {
    shouldReconnectRef.current = true;
    connect();
    return () => {
      shouldReconnectRef.current = false;
      connectSeqRef.current += 1;
      clearTimeout(reconnectTimer.current);
      const ws = wsRef.current;
      wsRef.current = null;
      ws?.close();
    };
  }, []);

  const send = useCallback((msg: Record<string, unknown>) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    } else {
      queueRef.current.push(msg);
    }
  }, []);

  return { send };
}
