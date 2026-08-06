/**
 * Spec #308 — Worker process audit channel (Node emit side).
 *
 * Package sessions emit Case-persisted frames stamped with agent_id + package_turn_id.
 * Main chat must not render these (channel: worker_audit / package_turn_id scope).
 * Policy A evolution: Worker tools go here instead of silent drop only.
 */

import type { PlatformSink, TaskEnvelope, ToolRuntime } from "../types.js";
import type { SubagentHandoffFields } from "./subagent-handoff.js";
import {
  assistantText,
  assistantThinking,
} from "./platform-observability.js";

export const WORKER_AUDIT_CHANNEL = "worker_audit" as const;

export type WorkerAuditScope = {
  agentId: string;
  packageTurnId: string;
  workerOrdinal?: number;
};

export type DeliveryStatus = "ok" | "failed" | "interrupted";

/** Stable package turn id for one Main→Worker package attempt. */
export function newPackageTurnId(agentId: string): string {
  const id = String(agentId || "worker").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48);
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `pkg_${id}_${Date.now().toString(36)}_${rand}`;
}

/** Fail-closed: true when payload is Worker-audit scoped (must not render in Main). */
export function isWorkerAuditScoped(payload: Record<string, unknown> | null | undefined): boolean {
  if (!payload || typeof payload !== "object") return false;
  if (String(payload.channel || "") === WORKER_AUDIT_CHANNEL) return true;
  const turn = String(payload.package_turn_id || "").trim();
  const agent = String(payload.agent_id || "").trim();
  return Boolean(turn && agent);
}

/** Map host race/settlement flags → Delivery card status (S4). */
export function mapDeliveryStatus(input: {
  aborted?: boolean;
  ok?: boolean;
  timedOut?: boolean;
}): DeliveryStatus {
  if (input.aborted) return "interrupted";
  if (input.ok) return "ok";
  return "failed";
}

export function handoffFieldsForAudit(
  handoff: SubagentHandoffFields,
  assignment?: string,
): Record<string, string> {
  const out: Record<string, string> = {
    target: String(handoff.target || ""),
    scope: String(handoff.scope || ""),
    already_done: String(handoff.already_done || ""),
    this_turn_goal: String(handoff.this_turn_goal || ""),
    success_criteria: String(handoff.success_criteria || ""),
  };
  const a = String(assignment || "").trim();
  if (a) out.assignment = a.slice(0, 4000);
  return out;
}

function baseFields(
  task: TaskEnvelope,
  scope: WorkerAuditScope,
): Record<string, unknown> {
  return {
    conversation_id: task.conversationId,
    task_id: task.taskId,
    channel: WORKER_AUDIT_CHANNEL,
    agent_id: scope.agentId,
    package_turn_id: scope.packageTurnId,
    ...(typeof scope.workerOrdinal === "number" && scope.workerOrdinal >= 1
      ? { worker_ordinal: scope.workerOrdinal }
      : {}),
  };
}

export async function emitWorkerPackageStart(options: {
  platform: PlatformSink;
  task: TaskEnvelope;
  scope: WorkerAuditScope;
  handoff: SubagentHandoffFields;
  assignment?: string;
}): Promise<void> {
  const { platform, task, scope, handoff } = options;
  await platform.send({
    type: "worker_package_start",
    ...baseFields(task, scope),
    handoff: handoffFieldsForAudit(handoff, options.assignment),
  } as any);
}

export async function emitWorkerPackageDelivery(options: {
  platform: PlatformSink;
  task: TaskEnvelope;
  scope: WorkerAuditScope;
  status: DeliveryStatus;
  summary: string;
  settlement?: unknown;
}): Promise<void> {
  const { platform, task, scope } = options;
  const payload: Record<string, unknown> = {
    type: "worker_package_delivery",
    ...baseFields(task, scope),
    status: options.status,
    summary: String(options.summary || "").slice(0, 2000),
  };
  if (options.settlement != null && typeof options.settlement === "object") {
    payload.settlement = options.settlement;
  }
  await platform.send(payload as any);
}

/** Read mutable Worker audit scope from child runtime lifecycle (set per package). */
export function readWorkerAuditScope(runtime: ToolRuntime): WorkerAuditScope | null {
  const raw = (runtime.lifecycle as { workerAudit?: WorkerAuditScope | null }).workerAudit;
  if (!raw || typeof raw !== "object") return null;
  const agentId = String(raw.agentId || "").trim();
  const packageTurnId = String(raw.packageTurnId || "").trim();
  if (!agentId || !packageTurnId) return null;
  return {
    agentId,
    packageTurnId,
    workerOrdinal:
      typeof raw.workerOrdinal === "number" && raw.workerOrdinal >= 1
        ? raw.workerOrdinal
        : undefined,
  };
}

export function setWorkerAuditScope(runtime: ToolRuntime, scope: WorkerAuditScope | null): void {
  (runtime.lifecycle as { workerAudit?: WorkerAuditScope | null }).workerAudit = scope;
}

const TEXT_STREAM_FLUSH_MS = 40;
const TEXT_STREAM_MIN_CHARS = 24;

type StreamChannel = "text" | "thinking";

/**
 * Progressive Worker process stream (thinking/text) — same identity model as Main
 * but stamps agent_id + package_turn_id + channel on every frame.
 */
class WorkerProgressiveStream {
  private sequence = 0;
  private streamId = "";
  private text = "";
  private lastSentText = "";
  private timer: ReturnType<typeof setTimeout> | undefined;
  private sending: Promise<void> = Promise.resolve();
  private firstFlushPending = false;

  constructor(
    private readonly platform: PlatformSink,
    private readonly getTask: () => TaskEnvelope,
    private readonly getScope: () => WorkerAuditScope | null,
    private readonly channel: StreamChannel,
    private readonly extract: (message: unknown) => string,
  ) {}

  applySnapshot(message: unknown, ame?: { type?: string; delta?: string; partial?: unknown }): void {
    const fromMessage = this.extract(message);
    const fromPartial = ame?.partial !== undefined ? this.extract(ame.partial) : "";
    let next = fromMessage.length >= fromPartial.length ? fromMessage : fromPartial;
    if (!next) {
      const delta = String(ame?.delta || "");
      if (!delta) return;
      if (!this.text) next = delta;
      else if (delta.startsWith(this.text)) next = delta;
      else if (this.text.endsWith(delta)) next = this.text;
      else if (this.text.includes(delta) && delta.length < this.text.length) next = this.text;
      else next = `${this.text}${delta}`;
    }
    if (!next) return;
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
    const scope = this.getScope();
    if (!scope || !this.streamId || !this.text || this.text === this.lastSentText) {
      return this.sending;
    }
    const text = this.text;
    const streamId = this.streamId;
    this.lastSentText = text;
    this.firstFlushPending = false;
    const task = this.getTask();
    const type = this.channel === "thinking" ? "thinking" : "text";
    const content: Record<string, unknown> =
      this.channel === "thinking"
        ? {
            text,
            reasoning: text,
            stream_id: streamId,
            channel: WORKER_AUDIT_CHANNEL,
            agent_id: scope.agentId,
            package_turn_id: scope.packageTurnId,
          }
        : {
            text,
            stream_id: streamId,
            channel: WORKER_AUDIT_CHANNEL,
            agent_id: scope.agentId,
            package_turn_id: scope.packageTurnId,
          };
    this.sending = this.sending
      .then(() =>
        this.platform.send({
          type,
          ...baseFields(task, scope),
          content,
          stream_id: streamId,
        } as any),
      )
      .catch(() => {});
    return Promise.resolve();
  }

  private startStream(): void {
    this.sequence += 1;
    const scope = this.getScope();
    const task = this.getTask();
    const aid = scope?.agentId || "worker";
    const turn = scope?.packageTurnId || "turn";
    this.streamId = `n4-w-${this.channel}-${aid}-${turn}-${this.sequence}`;
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
 * Attach progressive thinking/text observability for a package Worker session.
 * Scope is read live from runtime.lifecycle.workerAudit (update per package turn).
 */
export function attachWorkerProcessStream(options: {
  session: { subscribe: (listener: (event: unknown) => void) => (() => void) | void };
  runtime: ToolRuntime;
}): { unsubscribe: () => void; dispose: () => Promise<void> } {
  const { session, runtime } = options;
  const getScope = () => readWorkerAuditScope(runtime);
  const getTask = () => runtime.task;
  const text = new WorkerProgressiveStream(
    runtime.platform,
    getTask,
    getScope,
    "text",
    assistantText,
  );
  const thinking = new WorkerProgressiveStream(
    runtime.platform,
    getTask,
    getScope,
    "thinking",
    assistantThinking,
  );

  const unsubRaw = session.subscribe((event: any) => {
    void handleWorkerProcessEvent(text, thinking, event).catch(() => {});
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
      try {
        await Promise.all([text.dispose(), thinking.dispose()]);
      } catch {
        /* ignore */
      }
    },
  };
}

async function handleWorkerProcessEvent(
  text: WorkerProgressiveStream,
  thinking: WorkerProgressiveStream,
  event: {
    type?: string;
    message?: unknown;
    assistantMessageEvent?: { type?: string; delta?: string; partial?: unknown };
  },
): Promise<void> {
  if (!event || typeof event !== "object") return;
  const msg = event.message as { role?: string } | undefined;

  if (event.type === "message_start" && msg?.role === "assistant") {
    text.ensureStream();
    thinking.ensureStream();
    text.applySnapshot(event.message, event.assistantMessageEvent);
    thinking.applySnapshot(event.message, event.assistantMessageEvent);
    await Promise.all([text.maybeFlush(), thinking.maybeFlush()]);
    return;
  }

  if (event.type === "message_update" && msg?.role === "assistant") {
    const ame = event.assistantMessageEvent;
    const kind = String(ame?.type || "");
    if (kind.startsWith("toolcall_")) return;
    if (kind.startsWith("thinking_")) {
      thinking.ensureStream();
      thinking.applySnapshot(event.message, ame);
      await thinking.maybeFlush();
      return;
    }
    if (kind.startsWith("text_") || !kind) {
      text.ensureStream();
      text.applySnapshot(event.message, ame);
      await text.maybeFlush();
      return;
    }
    text.ensureStream();
    thinking.ensureStream();
    text.applySnapshot(event.message, ame);
    thinking.applySnapshot(event.message, ame);
    await Promise.all([text.maybeFlush(), thinking.maybeFlush()]);
    return;
  }

  if (event.type === "message_end" && msg?.role === "assistant") {
    await Promise.all([text.finalFlush(event.message), thinking.finalFlush(event.message)]);
  }
}

/**
 * Emit Worker-scoped tool_output frame (Policy A evolution — not Main chat).
 * Returns true if a worker frame was sent.
 */
export async function emitWorkerToolFrame(options: {
  runtime: ToolRuntime;
  toolName: string;
  toolCallId: string;
  status: "running" | "done" | "error";
  summary?: string;
  resultText?: string;
  args?: Record<string, unknown>;
}): Promise<boolean> {
  const scope = readWorkerAuditScope(options.runtime);
  if (!scope) return false;
  const { runtime } = options;
  await runtime.platform.send({
    type: "tool_output",
    ...baseFields(runtime.task, scope),
    tool_name: options.toolName,
    tool_run_id: options.toolCallId,
    status: options.status,
    summary: String(options.summary || "").slice(0, 500),
    result_text: options.resultText != null ? String(options.resultText).slice(0, 4000) : undefined,
    args: options.args || {},
  } as any);
  return true;
}
