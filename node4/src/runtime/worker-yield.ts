/**
 * Spec #493 — Worker package return via yield or last assistant turn.
 * Files (settlement.json / result.json) are not package-success SoT.
 */
import { assistantText } from "./platform-observability.js";

export type WorkerYieldRecord = {
  status: "success" | "error";
  data?: unknown;
  error?: string;
  useLastTurn?: boolean;
};

export type WorkerHarvestInput = {
  yield?: WorkerYieldRecord | null;
  lastAssistantText: string;
  aborted?: boolean;
  timedOut?: boolean;
  promptError?: string;
};

export type WorkerHarvest = {
  ok: boolean;
  summary: string;
  has_valid_result: boolean;
  /** Always false on this path — file salvage is not the success SoT. */
  salvaged: false;
};

function isYieldToolCall(item: unknown): boolean {
  if (!item || typeof item !== "object") return false;
  const rec = item as { type?: string; name?: string };
  const t = String(rec.type || "");
  if (t !== "toolCall" && t !== "tool_use" && t !== "toolcall") return false;
  return String(rec.name || "") === "yield";
}

function messageHasYieldToolCall(msg: unknown): boolean {
  if (!msg || typeof msg !== "object") return false;
  const content = (msg as { content?: unknown }).content;
  return Array.isArray(content) && content.some(isYieldToolCall);
}

function lastUserIndex(messages: readonly unknown[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || typeof msg !== "object") continue;
    if (String((msg as { role?: string }).role || "") === "user") return i;
  }
  return -1;
}

/**
 * Oral report for yield({ result: {} }) is the assistant text on the yield turn
 * of **this package** (messages after the last user prompt).
 * Ignore post-yield closings ("see above") — they are not the report body.
 * Stop without yield: last non-empty assistant text in this package.
 * Warm resume must not harvest a prior package's yield.
 */
export function lastAssistantTextFromMessages(messages: readonly unknown[] | undefined | null): string {
  if (!Array.isArray(messages)) return "";
  const start = lastUserIndex(messages) + 1;
  let end = messages.length - 1;
  for (let i = messages.length - 1; i >= start; i--) {
    const msg = messages[i];
    if (!msg || typeof msg !== "object") continue;
    if (String((msg as { role?: string }).role || "") !== "assistant") continue;
    if (messageHasYieldToolCall(msg)) {
      end = i;
      break;
    }
  }
  for (let i = end; i >= start; i--) {
    const msg = messages[i];
    if (!msg || typeof msg !== "object") continue;
    if (String((msg as { role?: string }).role || "") !== "assistant") continue;
    const text = assistantText(msg).trim();
    if (text) return text;
  }
  return "";
}

export function formatYieldData(data: unknown): string {
  if (typeof data === "string") return data.trim();
  if (data && typeof data === "object") {
    const rec = data as Record<string, unknown>;
    if (typeof rec.summary === "string" && rec.summary.trim()) return rec.summary.trim();
    try {
      return JSON.stringify(data, null, 2);
    } catch {
      return String(data);
    }
  }
  if (data == null) return "";
  return String(data).trim();
}

/** Harvest Worker oral/structured report. Does not read workDir files. */
export function harvestWorkerReport(input: WorkerHarvestInput): WorkerHarvest {
  const last = String(input.lastAssistantText || "").trim();
  if (input.promptError && !input.aborted) {
    return {
      ok: false,
      summary: String(input.promptError).trim() || "session error",
      has_valid_result: false,
      salvaged: false,
    };
  }
  if (input.aborted) {
    return {
      ok: false,
      summary: last || "subagent aborted",
      has_valid_result: false,
      salvaged: false,
    };
  }
  if (input.timedOut) {
    return {
      ok: false,
      summary: last || "subagent timed out",
      has_valid_result: false,
      salvaged: false,
    };
  }

  const y = input.yield;
  if (y?.status === "error") {
    return {
      ok: false,
      summary: String(y.error || "").trim() || "yield error",
      has_valid_result: false,
      salvaged: false,
    };
  }
  if (y?.status === "success") {
    if (y.useLastTurn || y.data === undefined || y.data === null) {
      if (!last) {
        return {
          ok: false,
          summary: "yield requested last turn but assistant text was empty",
          has_valid_result: false,
          salvaged: false,
        };
      }
      return { ok: true, summary: last, has_valid_result: true, salvaged: false };
    }
    const fromData = formatYieldData(y.data);
    return {
      ok: true,
      summary: fromData || last || "yield",
      has_valid_result: true,
      salvaged: false,
    };
  }

  if (last) {
    return { ok: true, summary: last, has_valid_result: true, salvaged: false };
  }
  return {
    ok: false,
    summary: "subagent stopped without a report",
    has_valid_result: false,
    salvaged: false,
  };
}
