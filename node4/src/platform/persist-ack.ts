/**
 * Spec #280 / #543: Node waits for platform persist outcome on vuln_found.
 * Production WS must echo the applied frame (same persist_nonce) back to the Node.
 */
import { randomUUID } from "node:crypto";
import type { PlatformMessage } from "../types.js";

export const VULN_PERSIST_ACK_TIMEOUT_MS = 15_000;

export function needsVulnPersistAck(message: PlatformMessage): boolean {
  return String(message.type || "") === "vuln_found";
}

export function stampPersistNonce(message: PlatformMessage): string {
  const existing = String(
    (message as { persist_nonce?: unknown }).persist_nonce || "",
  ).trim();
  if (existing) return existing;
  const nonce = randomUUID();
  (message as { persist_nonce?: string }).persist_nonce = nonce;
  return nonce;
}

export function isVulnPersistAck(outboundNonce: string, inbound: PlatformMessage): boolean {
  const nonce = String(outboundNonce || "").trim();
  if (!nonce) return false;
  const t = String(inbound.type || "");
  if (t !== "vuln_found" && t !== "vuln_found_error") return false;
  return String((inbound as { persist_nonce?: unknown }).persist_nonce || "") === nonce;
}

export function persistAckTimeoutFrame(nonce: string): Record<string, unknown> {
  return {
    type: "vuln_found_error",
    persist_nonce: nonce,
    created: false,
    error: "persist ack timeout",
  };
}

/** In-flight persist waiters keyed by persist_nonce. */
export class PersistAckHub {
  private readonly pending = new Map<string, (msg: PlatformMessage) => void>();

  register(
    nonce: string,
    timeoutMs = VULN_PERSIST_ACK_TIMEOUT_MS,
  ): Promise<Record<string, unknown>> {
    const key = String(nonce || "").trim();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        resolve(persistAckTimeoutFrame(key));
      }, timeoutMs);
      this.pending.set(key, (msg) => {
        clearTimeout(timer);
        resolve(msg as Record<string, unknown>);
      });
    });
  }

  /** Consume a matching inbound persist frame. Returns true if a waiter took it. */
  take(inbound: PlatformMessage): boolean {
    const nonce = String((inbound as { persist_nonce?: unknown }).persist_nonce || "").trim();
    const fn = this.pending.get(nonce);
    if (!fn || !isVulnPersistAck(nonce, inbound)) return false;
    this.pending.delete(nonce);
    fn(inbound);
    return true;
  }
}
