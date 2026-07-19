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

/** First token goes out immediately; subsequent flushes coalesce. */
const TEXT_STREAM_FLUSH_MS = 40;
/** Force a flush when buffered growth exceeds this (chars) even before the timer. */
const TEXT_STREAM_MIN_CHARS = 24;
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

/** Extract thinking/reasoning blocks from a Pi assistant partial. */
export function assistantThinking(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item: { type?: string }) => item?.type === "thinking")
    .map((item: { thinking?: string; text?: string }) =>
      String(item.thinking || item.text || ""),
    )
    .filter(Boolean)
    .join("\n");
}

type StreamChannel = "text" | "thinking";

/**
 * Progressive stream of one content channel (visible text or thinking).
 * Source of truth is the Pi partial message snapshot — never raw `+=` deltas.
 */
class ProgressiveContentStream {
  private sequence = 0;
  private streamId = "";
  private text = "";
  private lastSentText = "";
  private timer: ReturnType<typeof setTimeout> | undefined;
  private sending: Promise<void> = Promise.resolve();
  private firstFlushPending = false;

  constructor(
    private readonly platform: PlatformSink,
    private readonly task: TaskEnvelope,
    private readonly channel: StreamChannel,
    private readonly extract: (message: unknown) => string,
  ) {}

  /**
   * Apply a full partial snapshot (already includes latest delta).
   * Never concatenate deltas — that produced doubled prefixes ("好的好的").
   */
  applySnapshot(message: unknown, ame?: { type?: string; delta?: string; partial?: unknown }): void {
    const fromMessage = this.extract(message);
    const fromPartial = ame?.partial !== undefined ? this.extract(ame.partial) : "";
    // Prefer the longer non-empty snapshot; both should already be cumulative full text.
    let next = fromMessage.length >= fromPartial.length ? fromMessage : fromPartial;
    if (!next) {
      // Last resort for providers that only send delta without updating partial body.
      const delta = String(ame?.delta || "");
      if (!delta) return;
      if (!this.text) next = delta;
      else if (delta.startsWith(this.text)) next = delta; // cumulative delta
      else if (this.text.endsWith(delta)) next = this.text; // duplicate frame
      else if (this.text.includes(delta) && delta.length < this.text.length) next = this.text;
      else next = `${this.text}${delta}`; // true incremental token
    }
    if (!next) return;
    // Allow correction from a doubled longer string to a shorter clean one.
    if (this.text && next.length < this.text.length && this.text.startsWith(next)) return;
    this.text = next;
  }

  ensureStream(): void {
    if (!this.streamId) this.startStream();
  }

  async maybeFlush(): Promise<void> {
    if (!this.text) return;
    await this.scheduleFlush();
  }

  async finalFlush(message?: unknown): Promise<void> {
    if (message !== undefined) this.applySnapshot(message);
    this.ensureStream();
    await this.flush();
    this.reset();
  }

  async dispose(): Promise<void> {
    await this.flush();
  }

  private reset(): void {
    this.streamId = "";
    this.text = "";
    this.lastSentText = "";
    this.firstFlushPending = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (!this.streamId || !this.text || this.text === this.lastSentText) return this.sending;

    const text = this.text;
    const streamId = this.streamId;
    this.lastSentText = text;
    this.firstFlushPending = false;
    const type = this.channel === "thinking" ? "thinking" : "text";
    const content =
      this.channel === "thinking"
        ? { text, reasoning: text, stream_id: streamId }
        : { text, stream_id: streamId };
    // Chain WS sends for order, but never await disk (caller platform must not block).
    this.sending = this.sending
      .then(() =>
        this.platform.send({
          type,
          conversation_id: this.task.conversationId,
          task_id: this.task.taskId,
          content,
          stream_id: streamId,
        } as PlatformMessage),
      )
      .catch(() => {});
    // Do not return the chain to callers — progressive UI must not wait on prior frames.
    return Promise.resolve();
  }

  private startStream(): void {
    this.sequence += 1;
    this.streamId = `n4-${this.channel}-${this.task.taskId}-${this.sequence}`;
    this.text = "";
    this.lastSentText = "";
    this.firstFlushPending = true;
  }

  private async scheduleFlush(): Promise<void> {
    if (!this.streamId || !this.text) return;
    if (this.firstFlushPending || this.text.length - this.lastSentText.length >= TEXT_STREAM_MIN_CHARS) {
      await this.flush();
      return;
    }
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, TEXT_STREAM_FLUSH_MS);
  }
}

/**
 * Stream assistant prose + thinking to the platform progressively.
 */
export class PlatformTextStream {
  private readonly text: ProgressiveContentStream;
  private readonly thinking: ProgressiveContentStream;

  constructor(
    platform: PlatformSink,
    task: TaskEnvelope,
  ) {
    this.text = new ProgressiveContentStream(platform, task, "text", assistantText);
    this.thinking = new ProgressiveContentStream(platform, task, "thinking", assistantThinking);
  }

  async handle(event: {
    type?: string;
    message?: unknown;
    assistantMessageEvent?: { type?: string; delta?: string; partial?: unknown };
  }): Promise<void> {
    const msg = event.message as { role?: string } | undefined;
    if (event.type === "message_start" && msg?.role === "assistant") {
      this.text.ensureStream();
      this.thinking.ensureStream();
      this.text.applySnapshot(event.message, event.assistantMessageEvent);
      this.thinking.applySnapshot(event.message, event.assistantMessageEvent);
      await Promise.all([this.text.maybeFlush(), this.thinking.maybeFlush()]);
      return;
    }

    if (event.type === "message_update" && msg?.role === "assistant") {
      const ame = event.assistantMessageEvent;
      const kind = String(ame?.type || "");
      if (kind.startsWith("toolcall_")) return;

      if (kind.startsWith("thinking_")) {
        this.thinking.ensureStream();
        this.thinking.applySnapshot(event.message, ame);
        await this.thinking.maybeFlush();
        return;
      }

      if (kind.startsWith("text_") || !kind) {
        this.text.ensureStream();
        this.text.applySnapshot(event.message, ame);
        await this.text.maybeFlush();
        return;
      }
      // Unknown update: try both channels from partial snapshot.
      this.text.ensureStream();
      this.thinking.ensureStream();
      this.text.applySnapshot(event.message, ame);
      this.thinking.applySnapshot(event.message, ame);
      await Promise.all([this.text.maybeFlush(), this.thinking.maybeFlush()]);
      return;
    }

    if (event.type === "message_end" && msg?.role === "assistant") {
      await Promise.all([
        this.text.finalFlush(event.message),
        this.thinking.finalFlush(event.message),
      ]);
    }
  }

  /** Test helper: drive a complete assistant text emit without full Pi events. */
  async emitFinalText(text: string): Promise<void> {
    this.text.ensureStream();
    this.text.applySnapshot({ role: "assistant", content: [{ type: "text", text }] });
    await this.text.finalFlush();
  }

  async dispose(): Promise<void> {
    await Promise.all([this.text.dispose(), this.thinking.dispose()]);
  }
}

/**
 * Build Node3-shaped checkpoint root for platform right panel.
 *
 * Timing contract (work-burst hooks):
 * - `started_at` = task/work-burst start (`task_start`)
 * - `end_time` = settle (`task_complete` terminal checkpoint)
 * Elapsed UI should use only this window — not outer continue counters or tool hooks.
 */
export function buildNode4Checkpoint(
  ctx: ObservabilityContext,
  options?: {
    terminal?: boolean;
    status?: string;
    endTime?: string;
    attackSurfaceCandidates?: unknown[];
  },
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
    attack_surface_candidates: options?.attackSurfaceCandidates || [],
  };
}

export async function emitCheckpointUpdate(
  ctx: ObservabilityContext,
  options?: {
    terminal?: boolean;
    status?: string;
    endTime?: string;
    attackSurfaceCandidates?: unknown[];
  },
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
  let panelChanged = false;
  if (event.type === "tool_execution_start") {
    ctx.counters.toolCallCount += 1;
    ctx.counters.activeTool = String(event.toolName || event.tool_name || "tool");
    ctx.counters.phase = "tool_running";
    ctx.panel.setMainActivity({
      phase: "tool_running",
      tool: ctx.counters.activeTool,
    });
    panelChanged = true;
    const panel = ctx.panel.list()[0];
    await ctx.platform.send({
      type: "status_update",
      conversation_id: ctx.task.conversationId,
      task_id: ctx.task.taskId,
      message: `${ctx.counters.activeTool} running`,
      active_tool: ctx.counters.activeTool,
      agent_phase: "tool_running",
      current_detail: panel?.current_detail,
      status: "running",
      llm_usage: ctx.usage.snapshot({ tool_calls: ctx.counters.toolCallCount }),
      // Live panel patch so UI does not wait for throttled checkpoint.
      panel_agents: ctx.panel.list(),
    } as PlatformMessage);
  }

  if (event.type === "tool_execution_end") {
    ctx.counters.phase = "llm_waiting";
    ctx.counters.activeTool = undefined;
    // Clear active tool; lastTool is retained for "分析…结果" detail.
    ctx.panel.setMainActivity({ phase: "llm_waiting", tool: "" });
    panelChanged = true;
    await ctx.platform.send({
      type: "status_update",
      conversation_id: ctx.task.conversationId,
      task_id: ctx.task.taskId,
      message: "llm_waiting",
      active_tool: "",
      agent_phase: "llm_waiting",
      current_detail: ctx.panel.list()[0]?.current_detail,
      status: "running",
      llm_usage: ctx.usage.snapshot({ tool_calls: ctx.counters.toolCallCount }),
      panel_agents: ctx.panel.list(),
    } as PlatformMessage);
  }

  if (event.type === "turn_start") {
    ctx.counters.phase = "llm_waiting";
    ctx.panel.setMainActivity({ phase: "llm_waiting", tool: "" });
    panelChanged = true;
    // No chatty status_update body — panel via checkpoint / status_update below.
    await ctx.platform.send({
      type: "status_update",
      conversation_id: ctx.task.conversationId,
      task_id: ctx.task.taskId,
      message: "llm_waiting",
      active_tool: "",
      agent_phase: "llm_waiting",
      current_detail: ctx.panel.list()[0]?.current_detail,
      status: "running",
      llm_usage: ctx.usage.snapshot({ tool_calls: ctx.counters.toolCallCount }),
      panel_agents: ctx.panel.list(),
    } as PlatformMessage);
  }

  await textStream.handle(event);

  if (event.type === "message_end" && event.message?.role === "assistant") {
    const recorded = ctx.usage.recordAssistantMessage(event.message);
    if (recorded) {
      const delta = messageTokenTotal(event.message);
      // OMP: account while active or budget-limited (isAccounting).
      if (delta > 0 && ctx.goals.isAccounting()) {
        ctx.goals.addTokensUsed(delta);
      }
    }
  }

  // Tool phase changes: always refresh checkpoint so right panel stays in sync.
  if (panelChanged) {
    await emitCheckpointUpdate(ctx);
    throttle.markEmitted();
    return;
  }

  if (
    (event.type === "turn_end" || (event.type === "message_end" && event.message?.role === "assistant")) &&
    throttle.shouldEmit(ctx.usage.snapshot())
  ) {
    await emitCheckpointUpdate(ctx);
  }
}
