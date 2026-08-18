/**
 * Measure the serialized LLM HTTP body (the thing Zen 413s on) without storing it.
 */
import { join } from "node:path";
import { appendFileInsideRoot } from "./session-workspace.js";

export const MIB = 1_048_576;

export type LlmRequestMeter = {
  model: string;
  provider: string;
  bytes: number;
  messages: number;
  tools: number;
  messages_bytes: number;
  tools_bytes: number;
  over_1mib: boolean;
};

export function utf8Bytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
  } catch {
    return 0;
  }
}

export function measureLlmRequestPayload(
  payload: unknown,
  model?: { id?: string; provider?: string },
): LlmRequestMeter {
  const rec = payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
  const messages = Array.isArray(rec.messages) ? rec.messages : [];
  const tools = Array.isArray(rec.tools) ? rec.tools : [];
  const bytes = utf8Bytes(payload);
  return {
    model: String(rec.model || model?.id || ""),
    provider: String(model?.provider || ""),
    bytes,
    messages: messages.length,
    tools: tools.length,
    messages_bytes: utf8Bytes(messages),
    tools_bytes: utf8Bytes(tools),
    over_1mib: bytes >= MIB,
  };
}

export async function appendLlmRequestRecord(
  piDir: string,
  record: Record<string, unknown>,
): Promise<void> {
  const dir = String(piDir || "").trim();
  if (!dir) return;
  const line = `${JSON.stringify({ ts: new Date().toISOString(), type: "llm_request", ...record })}\n`;
  await Promise.all([
    appendFileInsideRoot(join(dir, "llm-requests.jsonl"), dir, line).catch(() => {}),
    appendFileInsideRoot(join(dir, "events.jsonl"), dir, line).catch(() => {}),
  ]);
}
