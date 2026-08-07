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
import { buildTodoPlanTreePayload, type PlanNodeLike } from "./plan-projection.js";

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

type ThinkingLifecycleStatus = "running" | "done";

/**
 * Progressive stream of one content channel (visible text or thinking).
 * Source of truth is the Pi partial message snapshot — never raw `+=` deltas.
 * Spec #305: thinking frames stamp content.status running|done; T1 allows empty running start.
 */
class ProgressiveContentStream {
  private sequence = 0;
  private streamId = "";
  private text = "";
  private lastSentText = "";
  private lastSentStatus: "" | ThinkingLifecycleStatus = "";
  private timer: ReturnType<typeof setTimeout> | undefined;
  private sending: Promise<void> = Promise.resolve();
  private firstFlushPending = false;
  /**
   * Thinking only: after finalFlush stamps done, message_end must not re-open a
   * second stream_id from the same assistant snapshot (early done on text_ or toolcall_).
   */
  private channelClosed = false;

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
    // Ignore body after thinking channel already stamped done (message_end / late thinking_end).
    if (this.channel === "thinking" && this.channelClosed) return;
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

  /**
   * Spec #305 T1: when the thinking channel opens, emit an empty running frame
   * with a stable stream_id so the timeline is not silent before first tokens.
   */
  async ensureRunningStart(): Promise<void> {
    if (this.channel !== "thinking") return;
    this.ensureStream();
    if (this.lastSentStatus) return;
    await this.flush({ status: "running", allowEmpty: true });
  }

  async maybeFlush(): Promise<void> {
    if (!this.text) return;
    await this.scheduleFlush();
  }

  async finalFlush(message?: unknown): Promise<void> {
    if (this.channel === "thinking" && this.channelClosed) {
      // Already stamped done for this thinking open (e.g. on text_*); ignore message_end.
      return;
    }
    if (message !== undefined) this.applySnapshot(message);
    if (this.channel === "thinking") {
      // Only stamp done if this channel was opened / had progressive activity.
      if (!this.streamId && !this.text) {
        this.reset();
        this.channelClosed = true;
        return;
      }
      this.ensureStream();
      await this.flush({ status: "done", force: true, allowEmpty: true });
      this.reset();
      this.channelClosed = true;
      return;
    }
    this.ensureStream();
    await this.flush();
    this.reset();
  }

  async dispose(): Promise<void> {
    if (this.channel === "thinking" && this.channelClosed) return;
    if (this.channel === "thinking" && this.streamId && this.lastSentStatus === "running") {
      await this.flush({ status: "done", force: true, allowEmpty: true });
      this.reset();
      this.channelClosed = true;
      return;
    }
    await this.flush();
  }

  private reset(): void {
    this.streamId = "";
    this.text = "";
    this.lastSentText = "";
    this.lastSentStatus = "";
    this.firstFlushPending = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private async flush(opts?: {
    status?: ThinkingLifecycleStatus;
    force?: boolean;
    allowEmpty?: boolean;
  }): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (!this.streamId) return this.sending;

    const text = this.text;
    const status: ThinkingLifecycleStatus | undefined =
      this.channel === "thinking" ? opts?.status || "running" : undefined;

    if (!text && !opts?.allowEmpty) return this.sending;

    // Skip no-op progressive frames (same body + same status).
    if (
      !opts?.force
      && text === this.lastSentText
      && (status === undefined || status === this.lastSentStatus)
    ) {
      return this.sending;
    }
    // Force final: still skip if we already sent identical done frame.
    if (
      opts?.force
      && text === this.lastSentText
      && status === "done"
      && this.lastSentStatus === "done"
    ) {
      return this.sending;
    }

    const streamId = this.streamId;
    this.lastSentText = text;
    if (status) this.lastSentStatus = status;
    this.firstFlushPending = false;
    const type = this.channel === "thinking" ? "thinking" : "text";
    const content =
      this.channel === "thinking"
        ? { text, reasoning: text, stream_id: streamId, status: status || "running" }
        : { text, stream_id: streamId };
    // Chain WS sends for order. Progressive flushes stay non-blocking for callers;
    // force/allowEmpty (final + T1 start) await the chain so status frames are ordered.
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
    if (opts?.force || opts?.allowEmpty) {
      await this.sending;
      return;
    }
    // Do not return the chain to callers — progressive UI must not wait on prior frames.
    return Promise.resolve();
  }

  private startStream(): void {
    this.sequence += 1;
    this.streamId = `n4-${this.channel}-${this.task.taskId}-${this.sequence}`;
    this.text = "";
    this.lastSentText = "";
    this.lastSentStatus = "";
    this.firstFlushPending = true;
    this.channelClosed = false;
  }

  private async scheduleFlush(): Promise<void> {
    if (!this.streamId || !this.text) return;
    if (this.firstFlushPending || this.text.length - this.lastSentText.length >= TEXT_STREAM_MIN_CHARS) {
      await this.flush(this.channel === "thinking" ? { status: "running" } : undefined);
      return;
    }
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush(this.channel === "thinking" ? { status: "running" } : undefined);
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

  /**
   * Spec #305 mid-task T1: after tools finish (llm_waiting), open empty running thinking
   * so the chat timeline is not silent until the first thinking token.
   * Does not reseed pending chrome (frontend #276) — progressive thinking frames only.
   */
  async announceThinkingWaitAfterTools(): Promise<void> {
    await this.thinking.ensureRunningStart();
  }

  async handle(event: {
    type?: string;
    message?: unknown;
    assistantMessageEvent?: { type?: string; delta?: string; partial?: unknown };
  }): Promise<void> {
    // Spec #305 residual: tool → llm_waiting gap owns mid-task liveness (not bare message_start).
    // Prefer tool_execution_end so pure text-only turns never get empty 思考完成 spam.
    if (event.type === "tool_execution_end") {
      await this.announceThinkingWaitAfterTools();
      return;
    }

    const msg = event.message as { role?: string } | undefined;
    if (event.type === "message_start" && msg?.role === "assistant") {
      // Spec #305 Issue 10: do not open thinking on every message_start (avoids empty
      // 思考完成 spam on text-only turns). T1 empty running starts on thinking_* only
      // (or tool_execution_end for mid-task llm_waiting).
      this.text.ensureStream();
      this.text.applySnapshot(event.message, event.assistantMessageEvent);
      this.thinking.applySnapshot(event.message, event.assistantMessageEvent);
      // If the first partial already carries thinking blocks, open T1 for this turn.
      if (assistantThinking(event.message) || assistantThinking(event.assistantMessageEvent?.partial)) {
        await this.thinking.ensureRunningStart();
      }
      await Promise.all([this.text.maybeFlush(), this.thinking.maybeFlush()]);
      return;
    }

    if (event.type === "message_update" && msg?.role === "assistant") {
      const ame = event.assistantMessageEvent;
      const kind = String(ame?.type || "");
      // Leaving thinking for tool calls — stamp done so title is not stuck on 思考中…
      // until the full assistant message_end (which is after text + toolcall blocks).
      if (kind.startsWith("toolcall_")) {
        await this.thinking.finalFlush(event.message);
        return;
      }

      if (kind === "thinking_end" || kind === "thinking_done") {
        // Thinking block closed before text/tools — stamp done with final body.
        // Do not ensureStream first: after early close (text_*), that would open a 2nd stream.
        this.thinking.applySnapshot(event.message, ame);
        await this.thinking.finalFlush(event.message);
        return;
      }

      if (kind.startsWith("thinking_")) {
        // Spec #305 T1: first thinking_* opens channel + empty running frame.
        this.thinking.ensureStream();
        await this.thinking.ensureRunningStart();
        this.thinking.applySnapshot(event.message, ame);
        await this.thinking.maybeFlush();
        return;
      }

      if (kind.startsWith("text_")) {
        // Text started: thinking is complete for this turn — do not wait for message_end.
        await this.thinking.finalFlush(event.message);
        this.text.ensureStream();
        this.text.applySnapshot(event.message, ame);
        await this.text.maybeFlush();
        return;
      }

      if (!kind) {
        this.text.ensureStream();
        this.text.applySnapshot(event.message, ame);
        await this.text.maybeFlush();
        return;
      }
      // Unknown update: try both channels from partial snapshot.
      this.text.ensureStream();
      this.text.applySnapshot(event.message, ame);
      this.thinking.applySnapshot(event.message, ame);
      if (assistantThinking(event.message) || assistantThinking(ame?.partial)) {
        await this.thinking.ensureRunningStart();
      }
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

/** Progress summary for a Hard Graph L1/L2 plan_tree (same shape as todo projection). */
function progressFromPlanTree(planTree: PlanNodeLike[]): {
  plan_tree: PlanNodeLike[];
  todo_open_count: number;
  progress: { percent: number; label: string };
} {
  const workItems = planTree.filter((n) => (n.level || "work_item") === "work_item");
  const done = workItems.filter((n) => n.status === "done" || n.status === "skipped").length;
  const total = workItems.length;
  const open = workItems.filter((n) => n.status === "pending" || n.status === "running").length;
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);
  return {
    plan_tree: planTree,
    todo_open_count: open,
    progress: {
      percent,
      label: total === 0 ? "No stage todos" : `${done}/${total} done (${open} open)`,
    },
  };
}

/**
 * Build Node3-shaped checkpoint root for platform right panel.
 *
 * Timing contract (work-burst hooks):
 * - `started_at` = task/work-burst start (`task_start`)
 * - `end_time` = settle (`task_complete` terminal checkpoint)
 * Elapsed UI should use only this window — not outer continue counters or tool hooks.
 *
 * plan_tree source: Hard Graph run plan (L1/L2) when present, else free-path TodoStore projection.
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
  const graphPlan = ctx.runtime.lifecycle.hardGraphRun?.plan;
  const planPayload = graphPlan
    ? progressFromPlanTree(graphPlan.toPlanTree())
    : (() => {
        const todoPayload = buildTodoPlanTreePayload(ctx.runtime.todo);
        return {
          plan_tree: todoPayload.plan_tree as PlanNodeLike[],
          todo_open_count: todoPayload.todo_open_count,
          progress: todoPayload.progress,
          todo_phases: todoPayload.todo_phases,
        };
      })();
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
    plan_tree: planPayload.plan_tree,
    todo_phases: "todo_phases" in planPayload ? planPayload.todo_phases : undefined,
    todo_open_count: planPayload.todo_open_count,
    progress: planPayload.progress,
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

/** Minimal session surface used by free path + Hard Graph stages. */
export type Node4SessionObservabilityTarget = {
  subscribe: (listener: (event: unknown) => void) => (() => void) | void;
};

/**
 * Shared attach: free path (session-runner) and Hard Graph stages subscribe the same way.
 * Returns unsubscribe + dispose (dispose also flushes/disposes textStream by default).
 */
export function attachNode4SessionObservability(options: {
  session: Node4SessionObservabilityTarget;
  obsCtx: ObservabilityContext;
  textStream: PlatformTextStream;
  checkpointThrottle: CheckpointThrottle;
  /** When false, dispose() only unsubscribes (caller owns textStream lifetime). Default true. */
  disposeTextStream?: boolean;
}): {
  unsubscribe: () => void;
  dispose: () => Promise<void>;
} {
  const { session, obsCtx, textStream, checkpointThrottle } = options;
  const ownTextStream = options.disposeTextStream !== false;
  const unsubRaw = session.subscribe((event) => {
    void handleNode4SessionEvent(obsCtx, textStream, checkpointThrottle, event).catch(() => {
      // Never let observability break the agent loop.
    });
  });
  let unsubscribed = false;
  const unsubscribe = () => {
    if (unsubscribed) return;
    unsubscribed = true;
    if (typeof unsubRaw === "function") {
      try {
        unsubRaw();
      } catch {
        /* ignore */
      }
    }
  };
  return {
    unsubscribe,
    dispose: async () => {
      unsubscribe();
      if (ownTextStream) {
        try {
          await textStream.dispose();
        } catch {
          /* ignore */
        }
      }
    },
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

  // tool_output is emitted only by attachProductToolEventBridge (createBoundNode4Session).
  // This handler owns panel / status / text stream / usage for Main.
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
      // User-visible (not opaque llm_waiting token) so re-wait / reattempt is scannable.
      message: "正在请求模型…",
      active_tool: "",
      agent_phase: "llm_waiting",
      current_detail: ctx.panel.list()[0]?.current_detail,
      status: "running",
      llm_usage: ctx.usage.snapshot({ tool_calls: ctx.counters.toolCallCount }),
      panel_agents: ctx.panel.list(),
    } as PlatformMessage);
    // Spec #305: textStream.handle(tool_execution_end) opens T1 empty running thinking
    // so chat is not silent during llm_waiting after tools (before thinking_* tokens).
  }

  if (event.type === "turn_start") {
    ctx.counters.phase = "llm_waiting";
    ctx.panel.setMainActivity({ phase: "llm_waiting", tool: "" });
    panelChanged = true;
    await ctx.platform.send({
      type: "status_update",
      conversation_id: ctx.task.conversationId,
      task_id: ctx.task.taskId,
      message: "正在请求模型…",
      active_tool: "",
      agent_phase: "llm_waiting",
      current_detail: ctx.panel.list()[0]?.current_detail,
      status: "running",
      llm_usage: ctx.usage.snapshot({ tool_calls: ctx.counters.toolCallCount }),
      panel_agents: ctx.panel.list(),
    } as PlatformMessage);
    // Do not open T1 on bare turn_start — pure text-only replies must stay silent
    // until thinking_* (Issue 10). Mid-task gap is covered by tool_execution_end.
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
