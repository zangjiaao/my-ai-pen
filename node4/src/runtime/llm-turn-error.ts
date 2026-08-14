/**
 * Detect soft LLM turn failures (stopReason=error / errorMessage) that do not throw.
 * Spec: surface to UI + task_error — never silent natural_stop / completed.
 * Spec #353: optional stream diagnosis package on terminal LLM failures (S2).
 */

import type { StreamDiagnosis } from "./llm-stream-health.js";
import {
  isIncompleteStreamMessage,
  type LlmStreamHealth,
} from "./llm-stream-health.js";

export class LlmTurnError extends Error {
  readonly code = "llm_error" as const;
  readonly userMessage: string;
  /** Spec #353 S2: durable stream forensics (no full tool args). */
  readonly diagnosis?: StreamDiagnosis;

  constructor(message: string, diagnosis?: StreamDiagnosis) {
    const msg = String(message || "Model request failed").trim() || "Model request failed";
    super(msg);
    this.name = "LlmTurnError";
    this.userMessage = msg;
    if (diagnosis) this.diagnosis = diagnosis;
  }
}

/**
 * Build LlmTurnError with diagnosis from stream health (incomplete / idle / provider).
 * Marks health terminal when a tracker is provided.
 */
export function llmTurnErrorWithDiagnosis(
  providerMessage: string,
  health?: LlmStreamHealth | null,
  opts?: { finishReasonPresent?: boolean },
): LlmTurnError {
  const raw = String(providerMessage || "").trim() || "Model request failed";
  const user = formatLlmErrorForUser(raw);
  const diagnosis = health
    ? health.state === "terminal"
      ? health.diagnosis({
          providerMessage: raw,
          finishReasonPresent: opts?.finishReasonPresent === true,
        })
      : health.terminalFailure({
          providerMessage: raw,
          finishReasonPresent: opts?.finishReasonPresent === true,
        })
    : undefined;
  return new LlmTurnError(user, diagnosis);
}

/** Thrown or soft provider text that is incomplete-stream class (fail-closed immediately). */
export function isIncompleteStreamError(err: unknown): boolean {
  const raw =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : String((err as { message?: string })?.message || err || "");
  return isIncompleteStreamMessage(raw);
}

/** Last assistant message fields we care about for error detection. */
export type AssistantTurnSnapshot = {
  stopReason?: string;
  errorMessage?: string;
  content?: unknown;
};

/**
 * Scan session messages from the end for the latest assistant turn.
 * Returns a user-facing error string when the turn failed without throwing.
 */
export function extractLlmTurnError(messages: readonly unknown[] | undefined | null): string | null {
  if (!Array.isArray(messages) || !messages.length) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const raw = messages[i];
    if (!raw || typeof raw !== "object") continue;
    const m = raw as Record<string, unknown>;
    if (String(m.role || "") !== "assistant") continue;
    return assistantTurnErrorMessage(m);
  }
  return null;
}

/** Successful / non-error provider stop reasons — do not treat as soft-fail. */
const SUCCESS_LOOKING_STOPS = new Set([
  "end_turn",
  "end-turn",
  "tool_use",
  "tool-use",
  "tool_calls",
  "tool-calls",
  "stop",
  "length",
  "max_tokens",
  "content_filter",
]);

/** Read string error fields only — ignore non-string `error` objects. */
function stringErrorField(message: AssistantTurnSnapshot | Record<string, unknown>): string {
  const rec = message as Record<string, unknown>;
  const candidates = [
    (message as AssistantTurnSnapshot).errorMessage,
    rec.error_message,
    rec.error,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  return "";
}

/** Pure helper for one assistant message object (tests + event handlers). */
export function assistantTurnErrorMessage(message: AssistantTurnSnapshot | Record<string, unknown>): string | null {
  const stop = String(
    (message as AssistantTurnSnapshot).stopReason ??
      (message as Record<string, unknown>).stop_reason ??
      "",
  )
    .trim()
    .toLowerCase();
  const err = stringErrorField(message);

  // Prefer explicit stopReason/stop_reason === "error".
  if (stop === "error") {
    return formatLlmErrorForUser(err || "Model request failed (provider stopReason=error)");
  }
  // String errorMessage only when stop is empty/missing or not a successful-looking stop.
  // Stray non-string `error` objects never trip (handled by stringErrorField).
  if (err && !SUCCESS_LOOKING_STOPS.has(stop)) {
    return formatLlmErrorForUser(err);
  }
  return null;
}

/** Short user-facing Chinese/English hybrid message; keep provider detail. */
export function formatLlmErrorForUser(raw: string): string {
  const t = String(raw || "").trim() || "Model request failed";
  // Keep provider text — operators need 403 / opt-in URLs.
  if (/模型调用失败|Model request failed/i.test(t)) {
    if (isOccupancyProviderText(t) && !/occupancy/i.test(t)) {
      return `${t} (occupancy / context-length)`;
    }
    return t;
  }
  if (isOccupancyProviderText(t)) {
    return `模型调用失败：occupancy / context-length — ${t}`;
  }
  return `模型调用失败：${t}`;
}

/** Provider overflow text — diagnosis only, not intent routing. */
export function isOccupancyProviderText(raw: string): boolean {
  const t = String(raw || "").toLowerCase();
  return (
    t.includes("context_length") ||
    t.includes("context length") ||
    t.includes("maximum context") ||
    t.includes("context window") ||
    t.includes("too many tokens") ||
    t.includes("prompt is too long")
  );
}

export function isLlmTurnError(err: unknown): err is LlmTurnError {
  return err instanceof LlmTurnError || (err as { code?: string })?.code === "llm_error";
}
