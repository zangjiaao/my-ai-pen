import type { PlatformMessage } from "../types.js";

type Handler = (message: PlatformMessage) => Promise<void> | void;

export class PlatformWSClient {
  private ws?: WebSocket;
  private readonly handlers = new Map<string, Handler[]>();
  private reconnect = true;

  constructor(private readonly url: string, private readonly token: string) {}

  on(type: string, handler: Handler): void {
    const handlers = this.handlers.get(type) || [];
    handlers.push(handler);
    this.handlers.set(type, handlers);
  }

  async connect(): Promise<void> {
    let attempt = 0;
    while (this.reconnect) {
      try {
        const wsUrl = `${this.url}?token=${encodeURIComponent(this.token)}`;
        this.ws = new WebSocket(wsUrl);
        await waitOpen(this.ws);
        attempt = 0;
        console.log(`[node2] websocket connected: ${this.url}`);

        await new Promise<void>((resolve) => {
          if (!this.ws) return resolve();
          this.ws.onmessage = (event) => void this.dispatch(String(event.data));
          this.ws.onclose = () => resolve();
          this.ws.onerror = () => resolve();
        });
      } catch (error) {
        console.warn(`[node2] websocket error: ${formatError(error)}`);
      }
      attempt += 1;
      const delayMs = Math.min(2 ** attempt * 1000, 30_000);
      console.warn(`[node2] reconnecting in ${delayMs}ms`);
      await sleep(delayMs);
    }
  }

  async send(message: PlatformMessage): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn(`[node2] dropped outbound message, websocket not open: ${message.type}`);
      return;
    }
    this.ws.send(JSON.stringify(message));
  }

  close(): void {
    this.reconnect = false;
    this.ws?.close();
  }

  private async dispatch(raw: string): Promise<void> {
    let message: PlatformMessage;
    try {
      message = JSON.parse(raw) as PlatformMessage;
    } catch {
      console.warn("[node2] invalid websocket JSON");
      return;
    }
    const handlers = this.handlers.get(message.type) || [];
    for (const handler of handlers) {
      await handler(message);
    }
  }
}

function waitOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("websocket open failed"));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
