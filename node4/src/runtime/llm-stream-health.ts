/**
 * Spec #353 — LLM stream health lifecycle (S1) + diagnosis package (S2).
 *
 * Pure transitions: closed | open | stalled | terminal.
 * Runtime is SoT; FE projects Runtime frames only (no FE guess timers).
 */

export type StreamHealthState = "closed" | "open" | "stalled" | "terminal";

/** Coarse chunk kinds only — no raw SSE / full tool args. */
export type CoarseChunkKind = "thinking" | "text" | "toolcall" | "empty_or_other";

export type StreamTerminalClass =
  | "success"
  | "incomplete_finish"
  | "idle_timeout"
  | "provider_error"
  | "aborted"
  | "other";

export type StreamKindCounts = Record<CoarseChunkKind, number>;

/** Minimum diagnosis package on LLM-turn terminal failure (L6). */
export type StreamDiagnosis = {
  stream_terminal_class: StreamTerminalClass;
  provider_message: string;
  last_activity_at: string | null;
  idle_ms: number;
  chunk_count: number;
  kind_counts: StreamKindCounts;
  tool_name_seen: boolean;
  tool_name?: string;
  finish_reason_present: boolean;
};

export type StreamHealthConfig = {
  /** Idle while open → emit stall (ms). */
  stallThresholdMs: number;
  /**
   * Idle while open → abort stream (ms). Null/0 disables early abort.
   * Must be >= stallThresholdMs when set.
   */
  abortThresholdMs: number | null;
  /** Injectable clock for pure tests. */
  now?: () => number;
};

export type TickOutcome = "ok" | "stalled" | "abort";

export type StreamHealthSnapshot = {
  health: StreamHealthState;
  last_activity_at: string | null;
  idle_ms: number;
  chunk_count: number;
  kind_counts: StreamKindCounts;
  tool_name_seen: boolean;
  tool_name?: string;
  terminal_class?: StreamTerminalClass;
};

const ZERO_KINDS = (): StreamKindCounts => ({
  thinking: 0,
  text: 0,
  toolcall: 0,
  empty_or_other: 0,
});

/** Defaults: stall ~45s; early abort ~3m (optional, recommended v1). */
export const DEFAULT_STALL_THRESHOLD_MS = 45_000;
export const DEFAULT_ABORT_THRESHOLD_MS = 180_000;

export function loadStreamHealthConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): StreamHealthConfig {
  const stall = envPositiveMs(env, "NODE4_LLM_STALL_MS", DEFAULT_STALL_THRESHOLD_MS);
  const abortRaw = env["NODE4_LLM_IDLE_ABORT_MS"];
  let abort: number | null = DEFAULT_ABORT_THRESHOLD_MS;
  if (abortRaw !== undefined) {
    const n = Number(abortRaw);
    if (!Number.isFinite(n) || n <= 0) abort = null;
    else abort = Math.max(stall, Math.floor(n));
  } else {
    abort = Math.max(stall, DEFAULT_ABORT_THRESHOLD_MS);
  }
  return { stallThresholdMs: stall, abortThresholdMs: abort };
}

function envPositiveMs(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const n = Number(env[key]);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

/**
 * Classify provider / throw text into a terminal class (fail-closed incomplete).
 * Prefer known phrases; avoid bare "timeout"/"abort" false positives (review #353).
 */
export function classifyStreamProviderMessage(raw: string): StreamTerminalClass {
  const t = String(raw || "").trim().toLowerCase();
  if (!t) return "other";
  if (
    t.includes("without finish_reason") ||
    t.includes("no finish_reason") ||
    t.includes("missing finish_reason")
  ) {
    return "incomplete_finish";
  }
  if (
    t.includes("stream idle timeout") ||
    t.includes("llm stream idle") ||
    t === "stream idle timeout"
  ) {
    return "idle_timeout";
  }
  if (
    /\b(operation aborted|request aborted|stream aborted)\b/.test(t) ||
    t === "aborted" ||
    t === "cancelled" ||
    t === "canceled" ||
    t === "interrupted"
  ) {
    return "aborted";
  }
  if (
    /stream ended|econnreset|econnrefused|socket hang up|network error|502 bad gateway|503 service|504 gateway/.test(
      t,
    )
  ) {
    return "provider_error";
  }
  return "other";
}

export function isIncompleteStreamMessage(raw: string): boolean {
  return classifyStreamProviderMessage(raw) === "incomplete_finish";
}

/** Map Pi assistantMessageEvent.type → coarse kind. */
export function coarseKindFromAssistantEventType(type: string | undefined | null): CoarseChunkKind {
  const k = String(type || "").trim().toLowerCase();
  if (k.startsWith("thinking_")) return "thinking";
  if (k.startsWith("text_")) return "text";
  if (k.startsWith("toolcall_") || k.startsWith("tool_call")) return "toolcall";
  return "empty_or_other";
}

/**
 * Session-scoped stream health for one Main model wait.
 * Prefer one instance per attachNode4SessionObservability subscription.
 */
export class LlmStreamHealth {
  private health: StreamHealthState = "closed";
  private lastActivityMs = 0;
  private openedAtMs = 0;
  private chunkCount = 0;
  private kindCounts: StreamKindCounts = ZERO_KINDS();
  private toolNameSeen = false;
  private toolName = "";
  private terminalClass: StreamTerminalClass | undefined;
  private providerMessage = "";
  private finishReasonPresent = false;
  private readonly stallThresholdMs: number;
  private readonly abortThresholdMs: number | null;
  private readonly nowFn: () => number;
  /** True after idle-abort terminal so runners can map abort → LlmTurnError. */
  private idleAbortRequested = false;

  constructor(config?: Partial<StreamHealthConfig>) {
    const base = {
      stallThresholdMs: DEFAULT_STALL_THRESHOLD_MS,
      abortThresholdMs: DEFAULT_ABORT_THRESHOLD_MS as number | null,
      ...config,
    };
    this.stallThresholdMs = Math.max(1_000, Math.floor(base.stallThresholdMs));
    const abort = base.abortThresholdMs;
    this.abortThresholdMs =
      abort == null || abort <= 0
        ? null
        : Math.max(this.stallThresholdMs, Math.floor(abort));
    this.nowFn = base.now || (() => Date.now());
  }

  get state(): StreamHealthState {
    return this.health;
  }

  get isIdleAbortRequested(): boolean {
    return this.idleAbortRequested;
  }

  get config(): { stallThresholdMs: number; abortThresholdMs: number | null } {
    return {
      stallThresholdMs: this.stallThresholdMs,
      abortThresholdMs: this.abortThresholdMs,
    };
  }

  /**
   * Provider stream / model turn open (turn_start, tool_execution_end → llm_waiting).
   * Re-arms after a prior terminal so outer continues can track the next stream.
   * Mid-turn re-open (after tools) keeps cumulative counters for diagnosis.
   */
  open(atMs?: number): void {
    const t = atMs ?? this.nowFn();
    const rearmFromTerminal = this.health === "terminal";
    if (rearmFromTerminal) {
      this.chunkCount = 0;
      this.kindCounts = ZERO_KINDS();
      this.toolNameSeen = false;
      this.toolName = "";
      this.terminalClass = undefined;
      this.providerMessage = "";
      this.finishReasonPresent = false;
    }
    this.health = "open";
    this.openedAtMs = t;
    this.lastActivityMs = t;
    this.idleAbortRequested = false;
  }

  /** Close without failure (tool started, turn ended successfully, or disposed). */
  close(): void {
    if (this.health === "terminal") return;
    this.health = "closed";
    this.idleAbortRequested = false;
  }

  /**
   * Record provider chunk / projectable progress.
   * Clears stall → open when activity resumes.
   */
  noteActivity(
    kind: CoarseChunkKind = "empty_or_other",
    opts?: { toolName?: string; atMs?: number },
  ): void {
    if (this.health === "terminal" || this.health === "closed") return;
    const t = opts?.atMs ?? this.nowFn();
    this.lastActivityMs = t;
    this.chunkCount += 1;
    const k = kind in this.kindCounts ? kind : "empty_or_other";
    this.kindCounts[k] += 1;
    const name = String(opts?.toolName || "").trim();
    if (name) {
      this.toolNameSeen = true;
      this.toolName = name.slice(0, 64);
    }
    if (this.health === "stalled") {
      this.health = "open";
    }
  }

  /**
   * Check idle thresholds while open/stalled.
   * Returns first edge only: stalled once, then abort once.
   */
  tick(atMs?: number): TickOutcome {
    if (this.health !== "open" && this.health !== "stalled") return "ok";
    const t = atMs ?? this.nowFn();
    const idle = Math.max(0, t - this.lastActivityMs);
    if (this.abortThresholdMs != null && idle >= this.abortThresholdMs) {
      this.finishTerminal({
        terminalClass: "idle_timeout",
        providerMessage: "stream idle timeout",
        finishReasonPresent: false,
        atMs: t,
      });
      this.idleAbortRequested = true;
      return "abort";
    }
    if (this.health === "open" && idle >= this.stallThresholdMs) {
      this.health = "stalled";
      return "stalled";
    }
    return "ok";
  }

  /** Successful stream end (finish_reason / stop ok). */
  terminalSuccess(opts?: { finishReason?: string; atMs?: number }): StreamDiagnosis {
    const fr = String(opts?.finishReason || "").trim();
    return this.finishTerminal({
      terminalClass: "success",
      providerMessage: "",
      // Only true when a finish/stop reason string was actually observed.
      finishReasonPresent: Boolean(fr),
      atMs: opts?.atMs,
    });
  }

  /** Incomplete / idle / provider failure — diagnosis package required (L6). */
  terminalFailure(opts: {
    terminalClass?: StreamTerminalClass;
    providerMessage: string;
    finishReasonPresent?: boolean;
    atMs?: number;
  }): StreamDiagnosis {
    const msg = String(opts.providerMessage || "").trim();
    const cls =
      opts.terminalClass ||
      classifyStreamProviderMessage(msg) ||
      "other";
    return this.finishTerminal({
      terminalClass: cls === "success" ? "other" : cls,
      providerMessage: msg,
      finishReasonPresent: opts.finishReasonPresent === true,
      atMs: opts.atMs,
    });
  }

  snapshot(atMs?: number): StreamHealthSnapshot {
    const t = atMs ?? this.nowFn();
    const last = this.lastActivityMs > 0 ? this.lastActivityMs : 0;
    const idle =
      this.health === "closed" || this.health === "terminal" || last <= 0
        ? this.health === "terminal" && last > 0
          ? Math.max(0, t - last)
          : 0
        : Math.max(0, t - last);
    return {
      health: this.health,
      last_activity_at: last > 0 ? new Date(last).toISOString() : null,
      idle_ms: idle,
      chunk_count: this.chunkCount,
      kind_counts: { ...this.kindCounts },
      tool_name_seen: this.toolNameSeen,
      tool_name: this.toolName || undefined,
      terminal_class: this.terminalClass,
    };
  }

  /** Build diagnosis package from current counters (even mid-turn). */
  diagnosis(opts?: {
    terminalClass?: StreamTerminalClass;
    providerMessage?: string;
    finishReasonPresent?: boolean;
    atMs?: number;
  }): StreamDiagnosis {
    const t = opts?.atMs ?? this.nowFn();
    const last = this.lastActivityMs > 0 ? this.lastActivityMs : 0;
    const idle =
      last > 0
        ? Math.max(0, t - last)
        : this.openedAtMs > 0
          ? Math.max(0, t - this.openedAtMs)
          : 0;
    const cls =
      opts?.terminalClass ||
      this.terminalClass ||
      classifyStreamProviderMessage(opts?.providerMessage || this.providerMessage) ||
      "other";
    return {
      stream_terminal_class: cls,
      provider_message: String(opts?.providerMessage ?? this.providerMessage ?? "")
        .trim()
        .slice(0, 500),
      last_activity_at: last > 0 ? new Date(last).toISOString() : null,
      idle_ms: idle,
      chunk_count: this.chunkCount,
      kind_counts: { ...this.kindCounts },
      tool_name_seen: this.toolNameSeen,
      tool_name: this.toolName || undefined,
      finish_reason_present:
        opts?.finishReasonPresent !== undefined
          ? opts.finishReasonPresent
          : this.finishReasonPresent,
    };
  }

  private finishTerminal(opts: {
    terminalClass: StreamTerminalClass;
    providerMessage: string;
    finishReasonPresent: boolean;
    atMs?: number;
  }): StreamDiagnosis {
    const t = opts.atMs ?? this.nowFn();
    this.health = "terminal";
    this.terminalClass = opts.terminalClass;
    this.providerMessage = String(opts.providerMessage || "").trim().slice(0, 500);
    this.finishReasonPresent = opts.finishReasonPresent;
    if (this.lastActivityMs <= 0) this.lastActivityMs = this.openedAtMs || t;
    return this.diagnosis({
      terminalClass: opts.terminalClass,
      providerMessage: this.providerMessage,
      finishReasonPresent: opts.finishReasonPresent,
      atMs: t,
    });
  }
}

/** Runtime-authored stall detail (not free-text NLP; not #276 pending reseed). */
export function streamStallDetail(): string {
  return "模型流无进度，仍在等待";
}

/** Runtime-authored idle-timeout user message (same channel as incomplete finish). */
export function streamIdleTimeoutMessage(): string {
  return "stream idle timeout";
}
