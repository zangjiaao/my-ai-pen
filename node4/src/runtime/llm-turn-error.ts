/**
 * Detect soft LLM turn failures (stopReason=error / errorMessage) that do not throw.
 * Spec: surface to UI + task_error — never silent natural_stop / completed.
 */

export class LlmTurnError extends Error {
  readonly code = "llm_error" as const;
  readonly userMessage: string;

  constructor(message: string) {
    const msg = String(message || "Model request failed").trim() || "Model request failed";
    super(msg);
    this.name = "LlmTurnError";
    this.userMessage = msg;
  }
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

/** Pure helper for one assistant message object (tests + event handlers). */
export function assistantTurnErrorMessage(message: AssistantTurnSnapshot | Record<string, unknown>): string | null {
  const stop = String(
    (message as AssistantTurnSnapshot).stopReason ??
      (message as Record<string, unknown>).stop_reason ??
      "",
  )
    .trim()
    .toLowerCase();
  const err = String(
    (message as AssistantTurnSnapshot).errorMessage ??
      (message as Record<string, unknown>).error_message ??
      (message as Record<string, unknown>).error ??
      "",
  ).trim();
  if (stop === "error" || err) {
    return formatLlmErrorForUser(err || "Model request failed (provider stopReason=error)");
  }
  return null;
}

/** Short user-facing Chinese/English hybrid message; keep provider detail. */
export function formatLlmErrorForUser(raw: string): string {
  const t = String(raw || "").trim() || "Model request failed";
  // Keep provider text — operators need 403 / opt-in URLs.
  if (/模型调用失败|Model request failed/i.test(t)) return t;
  return `模型调用失败：${t}`;
}

export function isLlmTurnError(err: unknown): err is LlmTurnError {
  return err instanceof LlmTurnError || (err as { code?: string })?.code === "llm_error";
}
