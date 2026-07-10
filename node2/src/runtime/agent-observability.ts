/**
 * Persist Pi/Node2 runtime observability so stalled or incomplete runs can be diagnosed.
 *
 * Writes under the task directory:
 * - events.jsonl: append-only agent + platform lifecycle events
 * - agent-state.json: latest phase snapshot (llm_waiting / tool_running / …)
 * - agent-summary.json: compact end-of-run counters (also updated incrementally)
 */

import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PlatformMessage, PlatformSink, TaskEnvelope } from "../types.js";
import {
  LlmUsageLedger,
  loadLlmCostRatesFromEnv,
  type LlmCostRates,
  type LlmUsageSnapshot,
} from "./llm-usage.js";

export type AgentPhase =
  | "starting"
  | "llm_waiting"
  | "tool_running"
  | "turn_end"
  | "agent_end"
  | "completion_gate"
  | "finished"
  | "error"
  | "aborted";

export type AgentStateSnapshot = {
  conversationId: string;
  taskId: string;
  phase: AgentPhase;
  turn: number;
  activeTool?: string;
  activeToolCallId?: string;
  lastTool?: string;
  lastToolEndedAt?: string;
  lastEventType?: string;
  lastEventAt?: string;
  llmStartedAt?: string;
  assistantStopReason?: string;
  errorMessage?: string;
  idleMs?: number;
  toolCallCount: number;
  llmTurnCount: number;
  errorCount: number;
  startedAt?: string;
  updatedAt: string;
};

export class TaskDiagnostics {
  private readonly eventsPath: string;
  private readonly statePath: string;
  private readonly summaryPath: string;
  private queue: Promise<void> = Promise.resolve();
  private turn = 0;
  private toolCallCount = 0;
  private llmTurnCount = 0;
  private errorCount = 0;
  private phase: AgentPhase = "starting";
  private activeTool?: string;
  private activeToolCallId?: string;
  private lastTool?: string;
  private lastToolEndedAt?: string;
  private lastEventType?: string;
  private lastEventAt?: string;
  private llmStartedAt?: string;
  private assistantStopReason?: string;
  private errorMessage?: string;
  private openTools = new Map<string, { toolName: string; startedAt: string }>();
  private readonly startedAt: string = new Date().toISOString();
  private readonly usageLedger: LlmUsageLedger;
  private lastUsageCheckpointAt = 0;
  /** Main agent counts as 1; each completed worker launch increments this. */
  private workerAgentCount = 0;
  private workerToolCalls = 0;

  private constructor(
    private readonly taskDir: string,
    private readonly task: TaskEnvelope,
    costRates?: LlmCostRates,
  ) {
    this.eventsPath = join(taskDir, "events.jsonl");
    this.statePath = join(taskDir, "agent-state.json");
    this.summaryPath = join(taskDir, "agent-summary.json");
    this.usageLedger = new LlmUsageLedger(costRates || loadLlmCostRatesFromEnv());
  }

  static async create(taskDir: string, task: TaskEnvelope, costRates?: LlmCostRates): Promise<TaskDiagnostics> {
    await mkdir(taskDir, { recursive: true });
    const diagnostics = new TaskDiagnostics(taskDir, task, costRates);
    await writeFile(diagnostics.eventsPath, "", "utf8");
    await diagnostics.setPhase("starting", { reason: "task_start" });
    await diagnostics.append({
      kind: "runtime",
      type: "task_start",
      conversation_id: task.conversationId,
      task_id: task.taskId,
      scan_mode: task.scanMode,
      target: task.target,
    });
    return diagnostics;
  }

  get paths(): { eventsPath: string; statePath: string; summaryPath: string; taskDir: string } {
    return {
      eventsPath: this.eventsPath,
      statePath: this.statePath,
      summaryPath: this.summaryPath,
      taskDir: this.taskDir,
    };
  }

  /** Wrap a platform sink so every outbound message is also written to events.jsonl. */
  wrapPlatform(platform: PlatformSink): PlatformSink {
    return {
      send: async (message: PlatformMessage) => {
        await this.append({
          kind: "platform_out",
          type: message.type,
          conversation_id: message.conversation_id ?? this.task.conversationId,
          task_id: message.task_id ?? this.task.taskId,
          payload: compactPlatformPayload(message),
        });
        if (message.type === "task_complete" || message.type === "task_incomplete" || message.type === "task_error") {
          await this.setPhase(
            message.type === "task_error" ? "error" : "finished",
            {
              reason: message.type,
              status: message.status,
              summary: typeof message.summary === "string" ? message.summary.slice(0, 500) : undefined,
            },
          );
        }
        if (message.type === "completion_blocked") {
          await this.setPhase("completion_gate", { reason: "completion_blocked", round: message.round });
        }
        await platform.send(message);
      },
    };
  }

  async handleAgentEvent(event: any): Promise<void> {
    const type = String(event?.type || "unknown");
    const now = new Date().toISOString();
    this.lastEventType = type;
    this.lastEventAt = now;

    switch (type) {
      case "agent_start":
        await this.append({ kind: "agent", type, at: now });
        await this.setPhase("llm_waiting", { reason: "agent_start" });
        break;

      case "turn_start":
        this.turn += 1;
        this.llmTurnCount += 1;
        this.llmStartedAt = now;
        await this.append({ kind: "agent", type, turn: this.turn, at: now });
        await this.setPhase("llm_waiting", { reason: "turn_start", turn: this.turn });
        break;

      case "message_start":
        await this.append({
          kind: "agent",
          type,
          turn: this.turn,
          role: event.message?.role,
          at: now,
        });
        if (event.message?.role === "assistant") {
          await this.setPhase("llm_waiting", { reason: "assistant_message_start", turn: this.turn });
        }
        break;

      case "message_end": {
        const role = event.message?.role;
        const stopReason = event.message?.stopReason;
        const toolNames = toolNamesFromMessage(event.message);
        let usageRecorded = false;
        if (role === "assistant") {
          this.assistantStopReason = stopReason ? String(stopReason) : undefined;
          if (stopReason === "error") {
            this.errorCount += 1;
            this.errorMessage = String(event.message?.errorMessage || "assistant error");
          }
          usageRecorded = this.usageLedger.recordAssistantMessage(event.message);
        }
        const usage = this.llmUsage();
        await this.append({
          kind: "agent",
          type,
          turn: this.turn,
          role,
          stop_reason: stopReason,
          tool_names: toolNames,
          text_preview: textPreview(event.message),
          error_message: event.message?.errorMessage,
          usage_recorded: usageRecorded || undefined,
          usage: usageRecorded
            ? {
                input: event.message?.usage?.input,
                output: event.message?.usage?.output,
                cacheRead: event.message?.usage?.cacheRead,
                totalTokens: event.message?.usage?.totalTokens,
                cost: event.message?.usage?.cost?.total,
              }
            : undefined,
          llm_usage: usage.requests > 0 ? usage : undefined,
          at: now,
        });
        if (role === "assistant" && stopReason === "error") {
          await this.setPhase("error", { reason: "assistant_error", error: this.errorMessage });
        } else if (usageRecorded) {
          // Keep agent-summary.json current so operators can tail usage mid-run.
          await this.persistState({ reason: "llm_usage", usage });
        }
        break;
      }

      case "tool_execution_start": {
        const toolName = String(event.toolName || "unknown");
        const toolCallId = String(event.toolCallId || "");
        this.toolCallCount += 1;
        this.activeTool = toolName;
        this.activeToolCallId = toolCallId || undefined;
        if (toolCallId) this.openTools.set(toolCallId, { toolName, startedAt: now });
        await this.append({
          kind: "agent",
          type,
          turn: this.turn,
          tool_name: toolName,
          tool_call_id: toolCallId || undefined,
          args_preview: argsPreview(event.args),
          at: now,
        });
        await this.setPhase("tool_running", {
          reason: "tool_execution_start",
          tool_name: toolName,
          tool_call_id: toolCallId || undefined,
        });
        break;
      }

      case "tool_execution_end": {
        const toolName = String(event.toolName || this.activeTool || "unknown");
        const toolCallId = String(event.toolCallId || "");
        const started = toolCallId ? this.openTools.get(toolCallId) : undefined;
        if (toolCallId) this.openTools.delete(toolCallId);
        const durationMs = started ? Date.parse(now) - Date.parse(started.startedAt) : undefined;
        this.lastTool = toolName;
        this.lastToolEndedAt = now;
        if (this.activeToolCallId === toolCallId || !this.openTools.size) {
          this.activeTool = undefined;
          this.activeToolCallId = undefined;
        }
        await this.append({
          kind: "agent",
          type,
          turn: this.turn,
          tool_name: toolName,
          tool_call_id: toolCallId || undefined,
          is_error: Boolean(event.isError),
          duration_ms: durationMs,
          result_preview: resultPreview(event.result),
          at: now,
        });
        // After tools finish, the next blocking wait is usually the LLM.
        await this.setPhase(this.openTools.size ? "tool_running" : "llm_waiting", {
          reason: "tool_execution_end",
          tool_name: toolName,
          open_tools: this.openTools.size,
        });
        break;
      }

      case "turn_end": {
        const toolNames = toolNamesFromMessage(event.message);
        await this.append({
          kind: "agent",
          type,
          turn: this.turn,
          stop_reason: event.message?.stopReason,
          tool_names: toolNames,
          tool_result_count: Array.isArray(event.toolResults) ? event.toolResults.length : 0,
          at: now,
        });
        await this.setPhase("turn_end", { reason: "turn_end", turn: this.turn });
        break;
      }

      case "agent_end":
        await this.append({
          kind: "agent",
          type,
          turn: this.turn,
          message_count: Array.isArray(event.messages) ? event.messages.length : undefined,
          open_tools: [...this.openTools.keys()],
          at: now,
        });
        await this.setPhase("agent_end", { reason: "agent_end" });
        break;

      default:
        // Keep rare events for forensics without flooding state transitions.
        if (shouldPersistRawEvent(type)) {
          await this.append({
            kind: "agent",
            type,
            turn: this.turn,
            at: now,
            note: "passthrough",
          });
        }
        break;
    }
  }

  async setPhase(phase: AgentPhase, details: Record<string, unknown> = {}): Promise<void> {
    this.phase = phase;
    if (phase === "error" && typeof details.error === "string") {
      this.errorMessage = details.error;
    }
    if (phase === "aborted") {
      this.errorMessage = this.errorMessage || "aborted";
    }
    await this.persistState(details);
  }

  async noteRuntime(type: string, details: Record<string, unknown> = {}): Promise<void> {
    await this.append({
      kind: "runtime",
      type,
      conversation_id: this.task.conversationId,
      task_id: this.task.taskId,
      ...details,
    });
  }

  /** Node3-shaped llm_usage for checkpoints / right panel (main + workers). */
  llmUsage(): LlmUsageSnapshot {
    const agentCount = 1 + this.workerAgentCount;
    const toolCalls = this.toolCallCount + this.workerToolCalls;
    const usage = this.usageLedger.snapshot({ agent_count: agentCount, tool_calls: toolCalls });
    // Fall back to turn count when the provider did not report token usage.
    if (usage.requests <= 0 && this.llmTurnCount > 0) {
      return { ...usage, requests: this.llmTurnCount };
    }
    return usage;
  }

  /**
   * Merge a worker session's usage into the task ledger and bump agent_count.
   * Call once per worker run (even if tokens are zero) so panel agent_count reflects workers.
   */
  async mergeWorkerUsage(
    usage: LlmUsageSnapshot | undefined | null,
    details: Record<string, unknown> = {},
  ): Promise<void> {
    this.workerAgentCount += 1;
    if (usage) {
      this.usageLedger.mergeSnapshot(usage);
      this.workerToolCalls += Math.max(0, Number(usage.tool_calls) || 0);
    }
    await this.append({
      kind: "runtime",
      type: "worker_usage_merged",
      conversation_id: this.task.conversationId,
      task_id: this.task.taskId,
      worker_agent_count: this.workerAgentCount,
      usage: usage || undefined,
      ...details,
    });
    await this.persistState({ reason: "worker_usage_merged", ...details });
  }

  /**
   * Whether a live checkpoint_update is due (throttled) so the platform panel
   * can refresh tokens/cost without waiting for task end.
   */
  shouldEmitUsageCheckpoint(minIntervalMs = 10_000): boolean {
    const usage = this.llmUsage();
    if (usage.requests <= 0 && usage.total_tokens <= 0) return false;
    const now = Date.now();
    if (now - this.lastUsageCheckpointAt < minIntervalMs) return false;
    this.lastUsageCheckpointAt = now;
    return true;
  }

  snapshot(): AgentStateSnapshot {
    const updatedAt = new Date().toISOString();
    const lastAt = this.lastEventAt ? Date.parse(this.lastEventAt) : undefined;
    return {
      conversationId: this.task.conversationId,
      taskId: this.task.taskId,
      phase: this.phase,
      turn: this.turn,
      activeTool: this.activeTool,
      activeToolCallId: this.activeToolCallId,
      lastTool: this.lastTool,
      lastToolEndedAt: this.lastToolEndedAt,
      lastEventType: this.lastEventType,
      lastEventAt: this.lastEventAt,
      llmStartedAt: this.llmStartedAt,
      assistantStopReason: this.assistantStopReason,
      errorMessage: this.errorMessage,
      idleMs: lastAt ? Math.max(0, Date.now() - lastAt) : undefined,
      toolCallCount: this.toolCallCount,
      llmTurnCount: this.llmTurnCount,
      errorCount: this.errorCount,
      startedAt: this.startedAt,
      updatedAt,
    };
  }

  private async append(record: Record<string, unknown>): Promise<void> {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      conversation_id: this.task.conversationId,
      task_id: this.task.taskId,
      ...record,
    });
    this.queue = this.queue
      .then(() => appendFile(this.eventsPath, `${line}\n`, "utf8"))
      .catch((error) => {
        console.error("[node2-diagnostics] append failed:", error);
      });
    await this.queue;
  }

  private async persistState(details: Record<string, unknown> = {}): Promise<void> {
    const state = this.snapshot();
    const summary = {
      ...state,
      llm_usage: this.llmUsage(),
      openToolCallIds: [...this.openTools.keys()],
      details,
      paths: {
        events: "events.jsonl",
        state: "agent-state.json",
        summary: "agent-summary.json",
        piSessions: "pi-sessions",
      },
    };
    this.queue = this.queue
      .then(async () => {
        await writeFile(this.statePath, JSON.stringify(state, null, 2), "utf8");
        await writeFile(this.summaryPath, JSON.stringify(summary, null, 2), "utf8");
      })
      .catch((error) => {
        console.error("[node2-diagnostics] state persist failed:", error);
      });
    await this.queue;
  }
}

function toolNamesFromMessage(message: any): string[] {
  const content = Array.isArray(message?.content) ? message.content : [];
  return content
    .filter((item: any) => item?.type === "toolCall" || item?.type === "tool_use")
    .map((item: any) => String(item.name || item.toolName || "unknown"));
}

function textPreview(message: any): string | undefined {
  const content = Array.isArray(message?.content) ? message.content : [];
  const text = content
    .filter((item: any) => item?.type === "text")
    .map((item: any) => String(item.text || ""))
    .join("");
  if (typeof message?.text === "string" && message.text) {
    return message.text.slice(0, 400);
  }
  return text ? text.slice(0, 400) : undefined;
}

function argsPreview(args: unknown): unknown {
  try {
    const raw = JSON.stringify(args);
    if (!raw) return undefined;
    if (raw.length <= 800) return args;
    return { truncated: true, preview: raw.slice(0, 800) };
  } catch {
    return undefined;
  }
}

function resultPreview(result: unknown): unknown {
  try {
    if (result == null) return undefined;
    if (typeof result === "string") return result.slice(0, 500);
    const raw = JSON.stringify(result);
    if (raw.length <= 800) return result;
    return { truncated: true, preview: raw.slice(0, 800) };
  } catch {
    return { note: "unserializable_result" };
  }
}

function compactPlatformPayload(message: PlatformMessage): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of [
    "status",
    "summary",
    "message",
    "workflow_stage",
    "active_tool",
    "agent_phase",
    "round",
    "tool_name",
    "tool_run_id",
    "line",
    "reason",
  ]) {
    if (message[key] !== undefined) out[key] = message[key];
  }
  if (message.content && typeof message.content === "object") {
    const content = message.content as Record<string, unknown>;
    if (typeof content.text === "string") out.text_preview = content.text.slice(0, 300);
  }
  if (message.audit && typeof message.audit === "object") {
    out.audit_summary = (message.audit as Record<string, unknown>).summary;
  }
  return out;
}

function shouldPersistRawEvent(type: string): boolean {
  return [
    "agent_start",
    "agent_end",
    "turn_start",
    "turn_end",
    "message_start",
    "message_end",
    "tool_execution_start",
    "tool_execution_end",
  ].includes(type);
}
