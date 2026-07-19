import type { PlatformMessage } from "../types.js";

type Handler = (message: PlatformMessage) => Promise<void> | void;

/** Types we must not drop when the socket is briefly reconnecting. */
const RELIABLE_TYPES = new Set([
  "task_complete",
  "task_error",
  "text",
  "thinking",
  "tool_output",
  "status_update",
  "vuln_found",
  "evidence_created",
  "work_status",
  "checkpoint_update",
  "task_start",
]);

const MAX_QUEUE = 300;

export class PlatformWSClient {
  private ws?: WebSocket;
  private readonly handlers = new Map<string, Handler[]>();
  private reconnect = true;
  /** Outbound buffer while socket is closed (prevents truncated chat). */
  private outboundQueue: PlatformMessage[] = [];

  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}

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
        console.log(`[node4] websocket connected: ${this.url}`);
        this.flushOutboundQueue();
        await new Promise<void>((resolve) => {
          if (!this.ws) return resolve();
          this.ws.onmessage = (event) => void this.dispatch(String(event.data));
          this.ws.onclose = () => resolve();
          this.ws.onerror = () => resolve();
        });
      } catch (error) {
        console.warn(`[node4] websocket error: ${error instanceof Error ? error.message : String(error)}`);
      }
      attempt += 1;
      const delayMs = Math.min(2 ** attempt * 1000, 30_000);
      console.warn(`[node4] reconnecting in ${delayMs}ms`);
      await sleep(delayMs);
    }
  }

  async send(message: PlatformMessage): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(message));
        return;
      } catch (err) {
        console.warn(`[node4] send failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const typ = String(message.type || "");
    if (RELIABLE_TYPES.has(typ)) {
      this.outboundQueue.push(message);
      if (this.outboundQueue.length > MAX_QUEUE) {
        this.outboundQueue.splice(0, this.outboundQueue.length - MAX_QUEUE);
      }
      console.warn(`[node4] queued outbound message: ${typ} (queue=${this.outboundQueue.length})`);
    } else {
      console.warn(`[node4] dropped outbound message: ${typ}`);
      return;
    }

    // Brief wait — common during platform-side replace/reconnect.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await sleep(150 * (attempt + 1));
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.flushOutboundQueue();
        return;
      }
    }
  }

  close(): void {
    this.reconnect = false;
    this.ws?.close();
  }

  private flushOutboundQueue(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (!this.outboundQueue.length) return;
    const pending = this.outboundQueue.splice(0, this.outboundQueue.length);
    for (const message of pending) {
      try {
        this.ws.send(JSON.stringify(message));
      } catch (err) {
        // Re-queue remainder + failed message
        this.outboundQueue.unshift(message, ...pending.slice(pending.indexOf(message) + 1));
        console.warn(`[node4] flush failed, re-queued: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
    }
    if (pending.length) {
      console.log(`[node4] flushed ${pending.length} queued outbound message(s)`);
    }
  }

  private async dispatch(raw: string): Promise<void> {
    let message: PlatformMessage;
    try {
      message = JSON.parse(raw) as PlatformMessage;
    } catch {
      return;
    }
    for (const handler of this.handlers.get(message.type) || []) {
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
