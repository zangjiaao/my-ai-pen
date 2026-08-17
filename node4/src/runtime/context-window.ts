/**
 * Agent Runtime occupancy shrink = checkpoint (Spec context-window-management.md).
 *
 * transformContext changes the request-time view only. Platform chat is not rewritten.
 * persist pass then shrink. Overflow stays task_error, never natural_stop.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolRuntime } from "../types.js";
import { formatProcessFactIndexInjection } from "../stores/process-fact.js";
import { formatTodoSummary } from "../stores/todo.js";
import { formatIntelInjectLine, sortIntelSummaryForInject } from "./case-context.js";
import { isHarnessMessage, makeHarnessMessage } from "./harness-channel.js";
import { LlmTurnError } from "./llm-turn-error.js";

export const DEFAULT_COMPACT_THRESHOLD = 0.8;
export const CHECKPOINT_POINTER = "细节以 Store / 归档为准";
export const PERSIST_PASS_MARKER = "[context-window]";
export const PERSIST_PASS_TEXT =
  "### Context window\n[context-window] Occupancy is high. Persist living notebook clues with fact(upsert)/fact(forget) (Host hang) and any Store rows that should survive the smaller view, then continue. Unwritten process will be dropped.";

export type OccupancyEstimate = {
  tokens: number;
  usageTokens: number;
  trailingTokens: number;
  lastUsageIndex: number | null;
};

export type CompactCycle = {
  persistPassIssued: boolean;
  shrinkRetry: number;
  occupancyError?: string;
};

export type CheckpointRehydrate = {
  todoText?: string;
  surfaceText?: string;
  findingsLines?: string[];
  processFactText?: string;
  intelLines?: string[];
  goalText?: string;
};

export function parseCompactThreshold(raw: string | undefined | null): number {
  const s = String(raw ?? "").trim();
  if (!s) return DEFAULT_COMPACT_THRESHOLD;
  const n = Number(s);
  if (!Number.isFinite(n)) return DEFAULT_COMPACT_THRESHOLD;
  const frac = n > 1 ? n / 100 : n;
  return Math.min(0.95, Math.max(0.5, frac));
}

export function usageTokens(usage: unknown): number {
  if (!usage || typeof usage !== "object") return 0;
  const u = usage as Record<string, unknown>;
  const total = Number(u.totalTokens ?? u.total_tokens ?? 0);
  if (Number.isFinite(total) && total > 0) return total;
  const input = Number(u.input ?? u.input_tokens ?? 0) || 0;
  const output = Number(u.output ?? u.output_tokens ?? 0) || 0;
  const cacheRead = Number(u.cacheRead ?? u.cache_read ?? 0) || 0;
  const cacheWrite = Number(u.cacheWrite ?? u.cache_write ?? 0) || 0;
  const reasoning = Number(u.reasoningTokens ?? u.reasoning_tokens ?? u.reasoning ?? 0) || 0;
  const sum = input + output + cacheRead + cacheWrite + reasoning;
  return Number.isFinite(sum) && sum > 0 ? sum : 0;
}

export function estimateMessageTokens(message: unknown): number {
  try {
    const n = JSON.stringify(message)?.length ?? 0;
    return Math.max(1, Math.ceil(n / 4));
  } catch {
    return 1;
  }
}

function assistantUsage(message: unknown): number {
  if (!message || typeof message !== "object") return 0;
  const m = message as Record<string, unknown>;
  if (String(m.role || "") !== "assistant") return 0;
  const stop = String(m.stopReason || m.stop_reason || "").toLowerCase();
  if (stop === "aborted" || stop === "error") return 0;
  return usageTokens(m.usage);
}

export function estimateOccupancy(messages: readonly unknown[]): OccupancyEstimate {
  const list = Array.isArray(messages) ? messages : [];
  let lastUsageIndex: number | null = null;
  let usageTok = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    const u = assistantUsage(list[i]);
    if (u > 0) {
      lastUsageIndex = i;
      usageTok = u;
      break;
    }
  }
  if (lastUsageIndex == null) {
    let estimated = 0;
    for (const message of list) estimated += estimateMessageTokens(message);
    return { tokens: estimated, usageTokens: 0, trailingTokens: estimated, lastUsageIndex: null };
  }
  let trailing = 0;
  for (let i = lastUsageIndex + 1; i < list.length; i++) {
    trailing += estimateMessageTokens(list[i]);
  }
  return {
    tokens: usageTok + trailing,
    usageTokens: usageTok,
    trailingTokens: trailing,
    lastUsageIndex,
  };
}

export function occupancyAtOrAboveThreshold(
  tokens: number,
  contextWindow: number,
  threshold = DEFAULT_COMPACT_THRESHOLD,
): boolean {
  const window = Math.max(1, Number(contextWindow) || 0);
  if (!window) return false;
  return tokens >= window * threshold;
}

export function findKeepTailStart(
  messages: readonly unknown[],
  inProgressContent?: string | null,
): number {
  const list = Array.isArray(messages) ? messages : [];
  const needle = String(inProgressContent || "").trim();
  let lastUser = -1;
  for (let i = 0; i < list.length; i++) {
    const m = list[i] as { role?: string } | null;
    if (m && m.role === "user") lastUser = i;
  }
  if (!needle) return lastUser >= 0 ? lastUser : Math.max(0, list.length - 1);

  let startedAt = -1;
  for (let i = 0; i < list.length; i++) {
    const m = list[i] as { role?: string; content?: unknown } | null;
    if (!m) continue;
    if (m.role === "user") {
      startedAt = i;
      continue;
    }
    if (messageMentionsTodo(m, needle) && startedAt >= 0) {
      return startedAt;
    }
  }
  return lastUser >= 0 ? lastUser : Math.max(0, list.length - 1);
}

function messageMentionsTodo(message: { role?: string; content?: unknown }, needle: string): boolean {
  const content = message.content;
  const blob = typeof content === "string" ? content : safeJson(content);
  return blob.includes("todo") && blob.includes(needle);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) || "";
  } catch {
    return "";
  }
}

export function buildCheckpointMessages(
  messages: readonly AgentMessage[],
  keepTailStart: number,
  rehydrate: CheckpointRehydrate,
): AgentMessage[] {
  const tail = messages.slice(Math.max(0, keepTailStart)).filter((m) => {
    if (!isHarnessMessage(m)) return true;
    const text = typeof m.content === "string" ? m.content : "";
    return !text.includes(PERSIST_PASS_MARKER);
  });
  const lines = [
    CHECKPOINT_POINTER,
    "",
    "### Checkpoint rehydrate",
  ];
  if (rehydrate.todoText) {
    lines.push("", "#### Todo / TaskMap", rehydrate.todoText);
  }
  if (rehydrate.surfaceText) {
    lines.push("", "#### Surface coverage", rehydrate.surfaceText);
  }
  if (rehydrate.findingsLines?.length) {
    lines.push("", "#### Findings board");
    for (const line of rehydrate.findingsLines.slice(0, 20)) lines.push(line);
  }
  if (rehydrate.processFactText) {
    lines.push("", rehydrate.processFactText);
  }
  if (rehydrate.intelLines?.length) {
    lines.push("", "#### Living intel");
    for (const line of rehydrate.intelLines.slice(0, 50)) lines.push(line);
  }
  if (rehydrate.goalText) {
    lines.push("", rehydrate.goalText);
  }
  const checkpoint: AgentMessage = makeHarnessMessage(lines.join("\n"));
  return [checkpoint, ...tail];
}

export function withPersistPass(messages: readonly AgentMessage[]): AgentMessage[] {
  const last = messages[messages.length - 1];
  if (last && typeof last === "object" && (last.role === "user" || isHarnessMessage(last))) {
    const text = typeof last.content === "string" ? last.content : "";
    if (text.includes(PERSIST_PASS_MARKER)) return [...messages];
  }
  return [...messages, makeHarnessMessage(PERSIST_PASS_TEXT)];
}

export function occupancyLlmTurnError(detail: string): LlmTurnError {
  const raw = String(detail || "context occupancy exceeded").trim();
  return new LlmTurnError(`模型调用失败：occupancy / context-length — ${raw}`);
}

export function inProgressTodoContent(runtime: ToolRuntime | undefined): string | null {
  try {
    const phases = runtime?.todo?.snapshot?.();
    const list = Array.isArray(phases) ? phases : [];
    for (const phase of list) {
      for (const task of phase.tasks || []) {
        if (task.status === "in_progress") return String(task.content || "").trim() || null;
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

export async function collectCheckpointRehydrate(runtime: ToolRuntime | undefined): Promise<CheckpointRehydrate> {
  const out: CheckpointRehydrate = {};
  if (!runtime) return out;
  try {
    const phases = runtime.todo?.snapshot?.() ?? [];
    if (Array.isArray(phases) && phases.length) {
      out.todoText = formatTodoSummary(phases);
    }
  } catch {
    /* ignore */
  }
  try {
    const cov = await runtime.surfaceSqlite?.summary?.();
    if (cov) {
      out.surfaceText = `total=${cov.total} seen=${cov.open} touched=${cov.in_probe} booked=${cov.booked} deadend=${cov.deadend}`;
    }
  } catch {
    /* ignore */
  }
  const findings = runtime.task.caseContext?.findings_summary || [];
  if (findings.length) {
    out.findingsLines = findings.slice(0, 20).map((f) => {
      const sev = f.severity ? `[${f.severity}] ` : "";
      const loc = f.location ? ` @ ${f.location}` : "";
      const id = f.id ? ` id=${f.id}` : "";
      return `- ${sev}${f.title || "finding"}${loc}${id}`;
    });
  }
  try {
    const facts = runtime.processFacts ? await runtime.processFacts.list() : [];
    const factText = formatProcessFactIndexInjection(facts);
    if (factText) out.processFactText = factText;
  } catch {
    /* ignore */
  }
  const fetched = await fetchLivingIntelLines(runtime);
  if (fetched.length) {
    out.intelLines = fetched;
  } else {
    const intel = runtime.task.caseContext?.intel_summary || [];
    if (intel.length) {
      out.intelLines = sortIntelSummaryForInject(intel.slice(0, 50)).map(formatIntelInjectLine);
    }
  }
  try {
    const goal = runtime.goals?.formatForPrompt?.();
    if (goal) out.goalText = goal;
  } catch {
    /* ignore */
  }
  return out;
}

async function fetchLivingIntelLines(runtime: ToolRuntime): Promise<string[]> {
  const api = runtime.platformApi;
  if (!api?.baseUrl || !api.nodeToken) return [];
  try {
    const cid = String(runtime.task.conversationId || "").trim();
    const q = cid ? `?conversation_id=${encodeURIComponent(cid)}&limit=20` : "?limit=20";
    const res = await fetch(`${api.baseUrl.replace(/\/$/, "")}/api/node/ledger/intel${q}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${api.nodeToken}`,
        "X-Node-Token": api.nodeToken,
        "X-Conversation-Id": cid,
        "X-Task-Id": String(runtime.task.taskId || ""),
      },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { intel?: Array<Record<string, unknown>> };
    const rows = Array.isArray(data.intel) ? data.intel : [];
    return rows.slice(0, 20).map((r) => {
      const hang = r.port ? `${r.asset_id || "?"}:${r.port}` : String(r.asset_id || "");
      return `- ${r.id || "?"}${r.kind ? ` kind=${r.kind}` : ""}${hang ? ` hang=${hang}` : ""} — ${r.summary || ""}`;
    });
  } catch {
    return [];
  }
}

export function createContextWindowTransform(options: {
  contextWindow: number;
  cycle: CompactCycle;
  runtime?: ToolRuntime;
  threshold?: number;
}): (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]> {
  const threshold = options.threshold ?? parseCompactThreshold(process.env.NODE4_COMPACT_THRESHOLD);
  return async (messages) => {
    try {
      const occ = estimateOccupancy(messages);
      if (!occupancyAtOrAboveThreshold(occ.tokens, options.contextWindow, threshold)) {
        options.cycle.persistPassIssued = false;
        options.cycle.shrinkRetry = 0;
        return messages;
      }
      if (!options.cycle.persistPassIssued) {
        options.cycle.persistPassIssued = true;
        return withPersistPass(messages);
      }
      const keepFrom = findKeepTailStart(messages, inProgressTodoContent(options.runtime));
      const rehydrate = await collectCheckpointRehydrate(options.runtime);
      const next = buildCheckpointMessages(messages, keepFrom, rehydrate);
      options.cycle.persistPassIssued = false;
      options.cycle.shrinkRetry = 0;
      return next;
    } catch (err) {
      options.cycle.shrinkRetry += 1;
      if (options.cycle.shrinkRetry > 1) {
        options.cycle.occupancyError =
          err instanceof Error ? err.message : "occupancy shrink failed";
        const lastUser = findKeepTailStart(messages);
        return buildCheckpointMessages(messages, lastUser, {});
      }
      return messages;
    }
  };
}
