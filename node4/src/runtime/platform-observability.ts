/**
 * Platform-facing observability for Node4: text stream, llm_usage checkpoints,
 * and session event fan-out (Node2/3 parity shapes without importing node2).
 */

import type { PlatformMessage, PlatformSink, TaskEnvelope, ToolRuntime } from "../types.js";
import type { GoalStore } from "../stores/goal.js";
import {
  LlmUsageLedger,
  loadLlmCostRatesFromEnv,
  messageTokenTotal,
  type LlmUsageSnapshot,
} from "./llm-usage.js";
import type { PanelAgentTracker } from "./panel-agents.js";
import { buildTodoPlanTreePayload } from "./plan-projection.js";

const TEXT_STREAM_FLUSH_MS = 80;
const DEFAULT_CHECKPOINT_MIN_MS = 10_000;

export type ObservabilityContext = {
  platform: PlatformSink;
  task: TaskEnvelope;
  runtime: ToolRuntime;
  goals: GoalStore;
  usage: LlmUsageLedger;
  panel: PanelAgentTracker;
  startedAt: string;
  rolePackId: string;
  /** Mutable counters from the runner. */
  counters: {
    toolCallCount: number;
    activeTool?: string;
    phase: string;
  };
};

export function createUsageLedgerFromEnv(): LlmUsageLedger {
  return new LlmUsageLedger(loadLlmCostRatesFromEnv());
}

export class CheckpointThrottle {
  private lastAt = 0;

  shouldEmit(usage: LlmUsageSnapshot, minIntervalMs = DEFAULT_CHECKPOINT_MIN_MS): boolean {
    if (usage.requests <= 0 && usage.total_tokens <= 0) return false;
    const now = Date.now();
    if (now - this.lastAt < minIntervalMs) return false;
    this.lastAt = now;
    return true;
  }

  /** Force next shouldEmit to pass interval (e.g. after terminal emit already sent). */
  markEmitted(): void {
    this.lastAt = Date.now();
  }
}

/** Extract plain assistant text from a Pi message content array. */
export function assistantText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    if (typeof content === "string") return content;
    return "";
  }
  return content
    .filter((item: { type?: string; text?: string }) => item?.type === "text")
    .map((item: { text?: string }) => String(item.text || ""))
    .join("\n");
}

/**
 * Stream assistant prose to the platform as type:"text" with stream_id
 * (same protocol ConversationPage already handles for Node2).
 */
export class PlatformTextStream {
  private sequence = 0;
  private streamId = "";
  private text = "";
  private lastSentText = "";
  private timer: ReturnType<typeof setTimeout> | undefined;
  private sending: Promise<void> = Promise.resolve();

  constructor(
    private readonly platform: PlatformSink,
    private readonly task: TaskEnvelope,
  ) {}

  async handle(event: { type?: string; message?: unknown; assistantMessageEvent?: { type?: string; delta?: string } }): Promise<void> {
    const msg = event.message as { role?: string } | undefined;
    if (event.type === "message_start" && msg?.role === "assistant") {
      this.startStream();
      this.text = assistantText(event.message);
      await this.scheduleFlush();
      return;
    }

    if (event.type === "message_update" && msg?.role === "assistant") {
      if (!this.streamId) this.startStream();
      if (event.assistantMessageEvent?.type === "text_delta") {
        this.text += String(event.assistantMessageEvent.delta || "");
      } else {
        this.text = assistantText(event.message) || this.text;
      }
      await this.scheduleFlush();
      return;
    }

    if (event.type === "message_end" && msg?.role === "assistant") {
      if (!this.streamId) this.startStream();
      this.text = assistantText(event.message) || this.text;
      await this.flush();
      this.streamId = "";
      this.text = "";
      this.lastSentText = "";
    }
  }

  /** Test helper: drive a complete assistant text emit without full Pi events. */
  async emitFinalText(text: string): Promise<void> {
    this.startStream();
    this.text = text;
    await this.flush();
    this.streamId = "";
    this.text = "";
    this.lastSentText = "";
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (!this.streamId || !this.text || this.text === this.lastSentText) return this.sending;

    const text = this.text;
    const streamId = this.streamId;
    this.lastSentText = text;
    this.sending = this.sending.then(() =>
      this.platform.send({
        type: "text",
        conversation_id: this.task.conversationId,
        task_id: this.task.taskId,
        content: { text, stream_id: streamId },
      } as PlatformMessage),
    );
    return this.sending;
  }

  async dispose(): Promise<void> {
    await this.flush();
  }

  private startStream(): void {
    this.sequence += 1;
    this.streamId = `n4-stream-${this.task.taskId}-${this.sequence}`;
    this.text = "";
    this.lastSentText = "";
  }

  private async scheduleFlush(): Promise<void> {
    if (this.timer || !this.streamId || !this.text) return;
    this.timer = setTimeout(() => {
      void this.flush();
    }, TEXT_STREAM_FLUSH_MS);
  }
}

/** Build Node3-shaped checkpoint root for platform right panel. */
export function buildNode4Checkpoint(
  ctx: ObservabilityContext,
  options?: { terminal?: boolean; status?: string; endTime?: string },
): Record<string, unknown> {
  const usage = ctx.usage.snapshot({
    agent_count: 1 + Math.max(0, (ctx.panel.list().length || 1) - 1),
    tool_calls: ctx.counters.toolCallCount,
  });
  const targetValue =
    typeof ctx.task.target?.value === "string"
      ? ctx.task.target.value
      : typeof ctx.task.target?.url === "string"
        ? String(ctx.task.target.url)
        : "";
  const todoPayload = buildTodoPlanTreePayload(ctx.runtime.todo);
  const goalSnap = ctx.goals.snapshot();
  const mode = goalSnap.mode;

  return {
    runtime: "node4-pi",
    role_pack: ctx.rolePackId,
    started_at: ctx.startedAt,
    end_time: options?.endTime,
    status: options?.status,
    task_id: ctx.task.taskId,
    scan_mode: ctx.task.scanMode || ctx.task.engagement || "pentest",
    engagement: ctx.task.engagement,
    task_target: ctx.task.target,
    targets_info: targetValue
      ? [{ type: "url", target: targetValue, original: targetValue }]
      : [],
    llm_usage: usage.requests > 0 || usage.total_tokens > 0 ? usage : usage,
    panel_agents: ctx.panel.list({ terminal: options?.terminal }),
    plan_tree: todoPayload.plan_tree,
    todo_phases: todoPayload.todo_phases,
    todo_open_count: todoPayload.todo_open_count,
    progress: todoPayload.progress,
    goal: mode
      ? {
          id: mode.id,
          objective: mode.objective,
          status: mode.status,
          tokensUsed: mode.tokensUsed,
          tokenBudget: mode.tokenBudget,
          goalContinueCount: mode.goalContinueCount,
          segmentsWithoutProgress: mode.segmentsWithoutProgress,
          lastBookedFindingCount: mode.lastBookedFindingCount,
          subagentIds: mode.subagentIds,
        }
      : null,
    goal_progress: goalSnap.progress,
    agent_phase: ctx.counters.phase,
    active_tool: ctx.counters.activeTool || "",
    tool_call_count: ctx.counters.toolCallCount,
  };
}

export async function emitCheckpointUpdate(
  ctx: ObservabilityContext,
  options?: { terminal?: boolean; status?: string; endTime?: string },
): Promise<Record<string, unknown>> {
  const checkpoint = buildNode4Checkpoint(ctx, options);
  await ctx.platform.send({
    type: "checkpoint_update",
    conversation_id: ctx.task.conversationId,
    task_id: ctx.task.taskId,
    checkpoint,
  } as PlatformMessage);
  return checkpoint;
}

/**
 * Handle Pi session events for usage, text, status, and throttled checkpoints.
 * Pure orchestration — tests can call with synthetic events.
 */
export async function handleNode4SessionEvent(
  ctx: ObservabilityContext,
  textStream: PlatformTextStream,
  throttle: CheckpointThrottle,
  event: any,
): Promise<void> {
  if (!event || typeof event !== "object") return;

  // Prefer Pi session tool_execution_* (extension tool_call is separate and already emits tool_output).
  if (event.type === "tool_execution_start") {
    ctx.counters.toolCallCount += 1;
    ctx.counters.activeTool = String(event.toolName || event.tool_name || "tool");
    ctx.counters.phase = "tool_running";
    ctx.panel.setMainPhase("tool_running", ctx.counters.activeTool);
    await ctx.platform.send({
      type: "status_update",
      conversation_id: ctx.task.conversationId,
      task_id: ctx.task.taskId,
      message: `${ctx.counters.activeTool} running`,
      active_tool: ctx.counters.activeTool,
      agent_phase: "tool_running",
      status: "running",
      llm_usage: ctx.usage.snapshot({ tool_calls: ctx.counters.toolCallCount }),
    } as PlatformMessage);
  }

  if (event.type === "tool_execution_end") {
    ctx.counters.phase = "llm_waiting";
    ctx.counters.activeTool = undefined;
    ctx.panel.setMainPhase("llm_waiting", "");
  }

  if (event.type === "turn_start") {
    ctx.counters.phase = "llm_waiting";
    ctx.panel.setMainPhase("llm_waiting", "");
    // No status_update here — "model turn" was being rendered as agent chat
    // under the physical node name. Right-panel state comes from throttled checkpoints.
  }

  await textStream.handle(event);

  if (event.type === "message_end" && event.message?.role === "assistant") {
    const recorded = ctx.usage.recordAssistantMessage(event.message);
    if (recorded) {
      const delta = messageTokenTotal(event.message);
      if (delta > 0 && ctx.goals.isActive()) {
        ctx.goals.addTokensUsed(delta);
      }
    }
  }

  if (
    (event.type === "turn_end" || (event.type === "message_end" && event.message?.role === "assistant")) &&
    throttle.shouldEmit(ctx.usage.snapshot())
  ) {
    await emitCheckpointUpdate(ctx);
  }
}
