import { useEffect, useRef } from "react";

type MessageHandler = (msg: Record<string, unknown>) => void;

export function useWebSocket(handlers: Record<string, MessageHandler>) {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>();
  const attemptRef = useRef(0);
  const queueRef = useRef<Record<string, unknown>[]>([]);

  const connect = () => {
    const token = localStorage.getItem("access_token");
    if (!token) return;

    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const backendHost = import.meta.env.DEV ? "localhost:8000" : location.host;
    const ws = new WebSocket(`${protocol}//${backendHost}/ws?token=${token}`);
    wsRef.current = ws;

    ws.onopen = () => {
      attemptRef.current = 0;
      console.log("[WS] connected");
      // 发送排队中的消息
      while (queueRef.current.length) {
        const msg = queueRef.current.shift()!;
        ws.send(JSON.stringify(msg));
      }
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        const handler = handlers[msg.type as string];
        if (handler) handler(msg);
      } catch { /* ignore parse errors */ }
    };

    ws.onclose = () => {
      const delay = Math.min(1000 * Math.pow(2, attemptRef.current), 30000);
      attemptRef.current += 1;
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
        // 连接未就绪 → 排队
        queueRef.current.push(msg);
      }
    },
  };
}
