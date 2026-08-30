/**
 * Spec #283 (I0.9) + Spec #354: Session owns runtime; Task is dispatch package only.
 *
 * Park the captain working runtime across Task package settle/error/interrupt.
 * Continue (same Participant Session + work mode) attaches the next user
 * message as the next turn on that parked runtime.
 *
 * #282 = mode continuity (Graph not Free). I0.9 / #354 = working-runtime continuity.
 * Park is memory-only within the live Node process (v1). Process death → honest
 * mode-correct reseed (never silent Free demotion when Graph).
 *
 * End policy (shared by Free finally, Graph stage finally, parked-continue):
 * - interrupt/abort → park
 * - Task package complete/error/incomplete → park (never dispose for package settle)
 * - explicit dispose whitelist only: case_close | session_delete | manual_end | expert_transfer
 *
 * L2 (#354): idle park TTL is not product Session death (default disabled).
 */

import type { Node4AgentSession } from "./run-node4-agent.js";
import type { TodoStore } from "../stores/todo.js";
import type { ToolRuntime } from "../types.js";
import {
  disposeBrowserSandboxForCase,
  disposeBrowserSandboxForSeat,
} from "./browser-sandbox.js";
// Note: sandbox rm only from disposeWorkingSession / disposeWorkingSessionsForCase
// (not applyCaptainEndDisposition) so Session Delete has a single awaited fan-in.

/**
 * Default idle park TTL. Spec #354 L2: do not reclaim Participant Session for
 * product idle reasons. `<= 0` means never expire (see `isParkExpired`).
 * Callers may still pass an explicit positive ttlMs for tests.
 */
export const DEFAULT_PARK_TTL_MS = 0;

export type WorkingWorkMode = "free" | "graph";

export type ParkedWorkingRuntime = {
  conversationId: string;
  expertId: string;
  workMode: WorkingWorkMode;
  graphId?: string;
  stageId?: string;
  /** Last task_id (accounting only; product identity is Session). */
  taskId: string;
  session: Node4AgentSession;
  todo: TodoStore;
  /** Structured credentials / accounts when present at park time. */
  accounts?: unknown;
  /** Live ToolRuntime (Free parent or Graph stage child) — rebind platform/task on attach. */
  runtime?: ToolRuntime;
  parkedAt: number;
  /** Tear down when park is dropped (TTL / mode mismatch / terminal). */
  dispose: () => void | Promise<void>;
  /**
   * pi-agent-core Agent.sessionId at park time (or next id after Reset reseed).
   * Spec #354 Reset = dispose Agent + mint new sessionId (pi /new style).
   */
  agentSessionId?: string;
  /** After Reset: next createBoundNode4Session must mint a brand-new Agent (not reattach). */
  needsAgentReseed?: boolean;
  /** Last scanned Case speech id (unread-others cursor). Cold / reseed starts empty. */
  speechCursor?: string;
};

export type CaptainEndDisposition =
  | { disposition: "park"; reason: "interrupted" | "incomplete" }
  | {
      disposition: "dispose";
      reason: "product_terminal" | "expert_transfer" | "settled" | "case_close" | "session_delete" | "manual_end";
    };

/** Explicit product dispose reasons (Spec #354 dispose whitelist). */
export type CaptainDisposeReason =
  | "case_close"
  | "session_delete"
  | "manual_end"
  | "expert_transfer";

const parks = new Map<string, ParkedWorkingRuntime>();

/**
 * Spec #354: pending product dispose while a burst is still live.
 * Finally must dispose (not park) when Session delete / Case close already requested.
 * Keys: exact Session key (`conv::expert`) or Case-wide (`conv` / `conv::*` via isPendingDispose).
 */
const pendingDisposeKeys = new Set<string>();
/** Case-wide pending dispose (all experts under conversation). */
const pendingDisposeCases = new Set<string>();
/**
 * Todo snapshots captured at force-dispose (mid-burst Session delete) so
 * session_dispose_ack can return open_todos even when the park map is already empty.
 */
const disposedTodoSnapshots = new Map<string, ReturnType<TodoStore["snapshot"]>>();

/**
 * Captain Session death: idle Workers go with the Captain.
 * Reset keeps the pool object registered so later parks still receive operator End.
 */
async function teardownParkedCaptainResources(
  entry: {
    dispose: () => void | Promise<void>;
    runtime?: ToolRuntime;
  },
  options?: { unregisterPool?: boolean },
): Promise<void> {
  const pool = entry.runtime?.lifecycle?.subagentIdlePool;
  if (pool?.disposeAll) {
    try {
      await pool.disposeAll({ unregister: options?.unregisterPool !== false });
    } catch {
      /* best-effort */
    }
  }
  try {
    await Promise.resolve(entry.dispose());
  } catch {
    /* ignore */
  }
}

export function parkSessionKey(
  conversationId: string,
  expertId?: string | null,
): string {
  const c = String(conversationId || "").trim();
  const e = String(expertId || "").trim();
  if (!c) return "";
  return e ? `${c}::${e}` : c;
}

/** Mark Session for dispose-on-finally (Session delete while mid-burst). */
export function markPendingSessionDispose(
  conversationId: string,
  expertId?: string | null,
): void {
  const key = parkSessionKey(conversationId, expertId);
  if (key) pendingDisposeKeys.add(key);
}

/** Mark all Sessions under Case for dispose-on-finally (Case close). */
export function markPendingCaseDispose(conversationId: string): void {
  const c = String(conversationId || "").trim();
  if (c) pendingDisposeCases.add(c);
}

export function clearPendingSessionDispose(
  conversationId: string,
  expertId?: string | null,
): void {
  const key = parkSessionKey(conversationId, expertId);
  if (key) pendingDisposeKeys.delete(key);
}

export function clearPendingCaseDispose(conversationId: string): void {
  const c = String(conversationId || "").trim();
  if (c) pendingDisposeCases.delete(c);
}

export function isPendingDispose(
  conversationId: string,
  expertId?: string | null,
): boolean {
  const c = String(conversationId || "").trim();
  if (!c) return false;
  if (pendingDisposeCases.has(c)) return true;
  const key = parkSessionKey(conversationId, expertId);
  if (key && pendingDisposeKeys.has(key)) return true;
  // Bare conversation pending matches any expert under that Case (missing expert_id on delete).
  if (pendingDisposeKeys.has(c)) return true;
  return false;
}

export function clearPendingDisposeForTests(): void {
  pendingDisposeKeys.clear();
  pendingDisposeCases.clear();
  disposedTodoSnapshots.clear();
}

function stashDisposedTodos(
  conversationId: string,
  expertId: string | null | undefined,
  todo: TodoStore | undefined,
): void {
  if (!todo) return;
  let snap: ReturnType<TodoStore["snapshot"]> = [];
  try {
    snap = todo.snapshot();
  } catch {
    return;
  }
  const key = parkSessionKey(conversationId, expertId);
  if (key) disposedTodoSnapshots.set(key, snap);
  const c = String(conversationId || "").trim();
  // Also store under bare Case key for expert_id-less dispose lookups.
  if (c) disposedTodoSnapshots.set(c, snap);
}

function takeStashedTodos(
  conversationId: string,
  expertId?: string | null,
): ReturnType<TodoStore["snapshot"]> {
  const key = parkSessionKey(conversationId, expertId);
  if (key && disposedTodoSnapshots.has(key)) {
    const v = disposedTodoSnapshots.get(key) || [];
    disposedTodoSnapshots.delete(key);
    return v;
  }
  const c = String(conversationId || "").trim();
  if (c && disposedTodoSnapshots.has(c)) {
    const v = disposedTodoSnapshots.get(c) || [];
    disposedTodoSnapshots.delete(c);
    return v;
  }
  return [];
}

export function isParkExpired(
  entry: { parkedAt: number },
  now: number,
  ttlMs: number = DEFAULT_PARK_TTL_MS,
): boolean {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) return false;
  return now - entry.parkedAt > ttlMs;
}

/**
 * Unified captain end disposition — one policy for Free finally, Graph stage finally,
 * and parked-continue finally (Issue 4: avoid dual end policies).
 *
 * Spec #354: Task package settle is never Session dispose. Dispose only via
 * explicit whitelist (case_close / session_delete / manual_end / expert_transfer).
 *
 * - aborted → park (interrupt)
 * - explicit disposeReason / expertTransfer → dispose
 * - productTerminal (legacy flag) → still park unless disposeReason set
 * - otherwise package incomplete/complete/error → park
 */
export function decideCaptainEndDisposition(input: {
  aborted: boolean;
  /**
   * @deprecated Spec #354 — package "completed" must not dispose captain.
   * Kept for call-site compatibility; ignored unless disposeReason is set.
   */
  productTerminal?: boolean;
  /** Explicit Expert transfer ends Session park chain. */
  expertTransfer?: boolean;
  /** Spec #354 dispose whitelist — only these dispose the captain. */
  disposeReason?: CaptainDisposeReason;
}): CaptainEndDisposition {
  if (input.expertTransfer || input.disposeReason === "expert_transfer") {
    return { disposition: "dispose", reason: "expert_transfer" };
  }
  if (input.disposeReason === "case_close") {
    return { disposition: "dispose", reason: "case_close" };
  }
  if (input.disposeReason === "session_delete") {
    return { disposition: "dispose", reason: "session_delete" };
  }
  if (input.disposeReason === "manual_end") {
    return { disposition: "dispose", reason: "manual_end" };
  }
  if (input.aborted) {
    return { disposition: "park", reason: "interrupted" };
  }
  // Spec #354: productTerminal alone no longer disposes (Task ≠ Session death).
  return { disposition: "park", reason: "incomplete" };
}

/**
 * Free/Graph finally helper: abort or package settle → park (Spec #354).
 * Explicit dispose only when disposeReason / expertTransfer is set.
 */
export function decideParkOnEnd(input: {
  aborted: boolean;
  expertTransfer?: boolean;
  disposeReason?: CaptainDisposeReason;
}): CaptainEndDisposition {
  return decideCaptainEndDisposition({
    aborted: input.aborted,
    expertTransfer: input.expertTransfer,
    disposeReason: input.disposeReason,
  });
}

/**
 * Pure: whether continue should attach a parked runtime or reseed.
 * C1 free-in-envelope must not consume a Graph park as if incomplete resume.
 */
export function decideAttachOnContinue(input: {
  hasPark: boolean;
  parkExpired: boolean;
  parkWorkMode?: WorkingWorkMode;
  /** Session work mode for this continue (structured envelope / path). */
  sessionWorkMode: WorkingWorkMode;
  /** Post-complete C1 free-in-envelope — never attach Graph park as resume. */
  continueInEnvelope?: boolean;
}):
  | { action: "attach" }
  | {
      action: "reseed";
      reason: "miss" | "ttl_expired" | "mode_mismatch" | "c1_continue";
    } {
  if (input.continueInEnvelope) {
    return { action: "reseed", reason: "c1_continue" };
  }
  if (!input.hasPark) {
    return { action: "reseed", reason: "miss" };
  }
  if (input.parkExpired) {
    return { action: "reseed", reason: "ttl_expired" };
  }
  if (
    input.parkWorkMode &&
    input.parkWorkMode !== input.sessionWorkMode
  ) {
    return { action: "reseed", reason: "mode_mismatch" };
  }
  return { action: "attach" };
}

/** Park a captain working runtime (replaces any prior park for the same Session key). */
export function parkWorkingSession(entry: ParkedWorkingRuntime): string {
  const key = parkSessionKey(entry.conversationId, entry.expertId);
  if (!key) return "";
  const prev = parks.get(key);
  if (prev && prev !== entry) {
    void Promise.resolve(prev.dispose()).catch(() => {});
  }
  parks.set(key, { ...entry, parkedAt: entry.parkedAt || Date.now() });
  return key;
}

/**
 * Apply shared end disposition: park or dispose the captain handle.
 * Used by Free finally, Graph stage finally, and parked-continue finally.
 */
export function applyCaptainEndDisposition(options: {
  decision: CaptainEndDisposition;
  entry: Omit<ParkedWorkingRuntime, "parkedAt"> & { parkedAt?: number };
}): { parked: boolean; disposed: boolean } {
  // Spec #354: Session delete / Case close while mid-burst → dispose, never re-park.
  const forceDispose = isPendingDispose(
    options.entry.conversationId,
    options.entry.expertId,
  );
  const decision = forceDispose
    ? ({
        disposition: "dispose",
        reason: pendingDisposeCases.has(String(options.entry.conversationId || "").trim())
          ? "case_close"
          : "session_delete",
      } as CaptainEndDisposition)
    : options.decision;

  if (decision.disposition === "park") {
    const agentSessionId =
      String(options.entry.agentSessionId || options.entry.session?.sessionId || "").trim() ||
      undefined;
    parkWorkingSession({
      ...options.entry,
      parkedAt: options.entry.parkedAt ?? Date.now(),
      agentSessionId,
    });
    return { parked: true, disposed: false };
  }
  // Ensure we do not leave a prior park for this Session.
  const key = parkSessionKey(options.entry.conversationId, options.entry.expertId);
  if (key) parks.delete(key);
  // Capture Todo before dispose so Session Delete ack can hold the map (mid-burst).
  if (forceDispose || decision.disposition === "dispose") {
    stashDisposedTodos(
      options.entry.conversationId,
      options.entry.expertId,
      options.entry.todo,
    );
  }
  void teardownParkedCaptainResources(options.entry).catch(() => {});
  // Sticky pen-sandbox rm is owned solely by disposeWorkingSession / ForCase
  // (awaited single fan-in) — not fire-and-forget here (review: double-rm race).
  // Clear Session-key pending always after force/explicit dispose.
  clearPendingSessionDispose(options.entry.conversationId, options.entry.expertId);
  // Spec #354 L1: case-wide pending must not stick after the mid-burst finally
  // that force-disposed (busy is one-per-Case; next package must re-park normally).
  if (forceDispose || decision.reason === "case_close") {
    clearPendingCaseDispose(options.entry.conversationId);
  }
  return { parked: false, disposed: true };
}

export function peekParkedSession(
  conversationId: string,
  expertId?: string | null,
): ParkedWorkingRuntime | undefined {
  const key = parkSessionKey(conversationId, expertId);
  if (!key) return undefined;
  return parks.get(key);
}

/** HTTP Surface 纳入: refresh parked captain TaskEnvelope Scope without attach. */
export function applyScopeToParkedRuntimes(
  conversationId: string,
  apply: (task: { scope?: Record<string, unknown> }) => void,
): number {
  const cid = String(conversationId || "").trim();
  if (!cid) return 0;
  let n = 0;
  for (const entry of parks.values()) {
    if (String(entry.conversationId || "").trim() !== cid) continue;
    if (!entry.runtime?.task) continue;
    apply(entry.runtime.task);
    n += 1;
  }
  return n;
}

/**
 * Take parked runtime for attach (removes from park map).
 * Caller owns dispose / re-park. Expired entries are disposed and treated as miss.
 */
export function takeParkedSession(
  conversationId: string,
  expertId?: string | null,
  options?: { now?: number; ttlMs?: number },
):
  | { ok: true; entry: ParkedWorkingRuntime }
  | { ok: false; reason: "miss" | "ttl_expired" } {
  const key = parkSessionKey(conversationId, expertId);
  if (!key) return { ok: false, reason: "miss" };
  const entry = parks.get(key);
  if (!entry) return { ok: false, reason: "miss" };
  const now = options?.now ?? Date.now();
  const ttlMs = options?.ttlMs ?? DEFAULT_PARK_TTL_MS;
  if (isParkExpired(entry, now, ttlMs)) {
    parks.delete(key);
    void teardownParkedCaptainResources(entry).catch(() => {});
    return { ok: false, reason: "ttl_expired" };
  }
  parks.delete(key);
  return { ok: true, entry };
}

/** Drop park without attach (mode mismatch cleanup, C1, tests). */
export async function dropParkedSession(
  conversationId: string,
  expertId?: string | null,
): Promise<boolean> {
  const key = parkSessionKey(conversationId, expertId);
  if (!key) return false;
  const entry = parks.get(key);
  if (!entry) return false;
  parks.delete(key);
  await teardownParkedCaptainResources(entry);
  return true;
}

/**
 * Resolve attach vs reseed for a continue turn, consuming park on attach.
 * On reseed after mode_mismatch/ttl/c1, park is dropped (Free and Graph).
 */
export function resolveWorkingSessionContinue(input: {
  conversationId: string;
  expertId?: string | null;
  sessionWorkMode: WorkingWorkMode;
  continueInEnvelope?: boolean;
  now?: number;
  ttlMs?: number;
}):
  | { action: "attach"; entry: ParkedWorkingRuntime }
  | {
      action: "reseed";
      reason: "miss" | "ttl_expired" | "mode_mismatch" | "c1_continue";
    } {
  const now = input.now ?? Date.now();
  const ttlMs = input.ttlMs ?? DEFAULT_PARK_TTL_MS;
  const peeked = peekParkedSession(input.conversationId, input.expertId);
  const decision = decideAttachOnContinue({
    hasPark: Boolean(peeked),
    parkExpired: peeked ? isParkExpired(peeked, now, ttlMs) : false,
    parkWorkMode: peeked?.workMode,
    sessionWorkMode: input.sessionWorkMode,
    continueInEnvelope: input.continueInEnvelope,
  });
  if (decision.action === "reseed") {
    if (
      peeked &&
      (decision.reason === "ttl_expired" ||
        decision.reason === "mode_mismatch" ||
        decision.reason === "c1_continue")
    ) {
      // Drop any leftover park on C1 / TTL / mismatch (predictable; no surprise Free attach after C1).
      void dropParkedSession(input.conversationId, input.expertId);
    }
    return decision;
  }
  const taken = takeParkedSession(input.conversationId, input.expertId, {
    now,
    ttlMs,
  });
  if (!taken.ok) {
    return { action: "reseed", reason: taken.reason };
  }
  return { action: "attach", entry: taken.entry };
}

/** History observable: session still has prior messages after park. */
export function parkedSessionHasHistory(entry: ParkedWorkingRuntime): boolean {
  const msgs = entry.session?.messages;
  return Array.isArray(msgs) && msgs.length > 0;
}

/** Todo observable: not wiped solely by park/continue. */
export function parkedTodoNonEmpty(entry: ParkedWorkingRuntime): boolean {
  try {
    return entry.todo.snapshot().some((p) => p.tasks.length > 0);
  } catch {
    return false;
  }
}

/**
 * Harness status for a parked-continue turn.
 * Graph never product-completes from the mini-runner alone (stage/run gates live in Hard Graph).
 * Free completes only when no open todos remain (mid-work Free stays incomplete → re-park).
 */
export function harnessStatusAfterParkedContinue(input: {
  aborted: boolean;
  workMode: WorkingWorkMode;
  openTodoCount: number;
}): "completed" | "incomplete" {
  if (input.aborted) return "incomplete";
  if (input.workMode === "graph") return "incomplete";
  if (input.openTodoCount > 0) return "incomplete";
  return "completed";
}

/**
 * Spec #354 L1/L10: dispose one Participant Session park (Session delete).
 * Returns open todo snapshot items for Case pending-handoff holding.
 * When expertId is empty, disposes all parks under the Case (prefix match).
 * Also returns mid-burst force-dispose stashed todos when park is already gone.
 */
export async function disposeWorkingSession(
  conversationId: string,
  expertId?: string | null,
): Promise<{ disposed: boolean; openTodos: ReturnType<TodoStore["snapshot"]> }> {
  const c = String(conversationId || "").trim();
  const e = String(expertId || "").trim();
  if (!c) return { disposed: false, openTodos: [] };

  // Missing expert_id: dispose every park under this Case (safe product default).
  if (!e) {
    const caseOut = await disposeWorkingSessionsForCase(c);
    const stashed = takeStashedTodos(c, undefined);
    return {
      disposed: caseOut.disposed > 0 || stashed.length > 0,
      openTodos: stashed,
    };
  }

  const key = parkSessionKey(c, e);
  const entry = key ? parks.get(key) : undefined;
  if (!entry) {
    // Spec #429: still rm sticky sandbox even if captain park already gone.
    await disposeBrowserSandboxForSeat(c, e).catch(() => {});
    const stashed = takeStashedTodos(c, e);
    return { disposed: stashed.length > 0, openTodos: stashed };
  }
  parks.delete(key);
  let openTodos: ReturnType<TodoStore["snapshot"]> = [];
  try {
    openTodos = entry.todo.snapshot();
  } catch {
    openTodos = [];
  }
  await teardownParkedCaptainResources(entry);
  // Spec #429: Session Delete → rm sticky pen-sandbox for this seat.
  await disposeBrowserSandboxForSeat(c, e).catch(() => {});
  // Prefer live park snapshot; drop any stale stash for this key.
  disposedTodoSnapshots.delete(key);
  disposedTodoSnapshots.delete(c);
  return { disposed: true, openTodos };
}

/**
 * Spec #354 L1 / Case close protocol: release all captains for a CaseID.
 */
export async function disposeWorkingSessionsForCase(
  conversationId: string,
): Promise<{ disposed: number; keys: string[] }> {
  const c = String(conversationId || "").trim();
  if (!c) return { disposed: 0, keys: [] };
  const prefix = `${c}::`;
  const keys: string[] = [];
  for (const key of [...parks.keys()]) {
    if (key === c || key.startsWith(prefix)) {
      keys.push(key);
    }
  }
  for (const key of keys) {
    const entry = parks.get(key);
    if (!entry) continue;
    parks.delete(key);
    stashDisposedTodos(entry.conversationId, entry.expertId, entry.todo);
    await teardownParkedCaptainResources(entry);
  }
  // Spec #429: Case close → rm all sticky pen-sandboxes under conversation.
  await disposeBrowserSandboxForCase(c).catch(() => {});
  return { disposed: keys.length, keys };
}

/**
 * Spec #354 L9: Session Reset — dispose pi-agent-core Agent instance, keep Todo.
 *
 * Aligns with pi coding-agent `/new` (handleClearCommand → runtimeHost.newSession):
 * teardown current Agent, mint a new Agent.sessionId; next attach constructs a
 * fresh Agent (not reattach old transcript). Incomplete TodoStore is preserved.
 */
export async function resetWorkingSessionMemory(
  conversationId: string,
  expertId?: string | null,
): Promise<{ ok: boolean; openTodoCount: number; reason?: string; agentSessionId?: string }> {
  const entry = peekParkedSession(conversationId, expertId);
  if (!entry) {
    return { ok: false, openTodoCount: 0, reason: "miss" };
  }
  let openTodoCount = 0;
  try {
    openTodoCount = entry.todo.openCount();
  } catch {
    openTodoCount = 0;
  }
  // Dispose the live pi-agent-core instance (abort + Agent.reset + clear queues)
  // and idle Workers. Keep the pool object registered for the next Agent.
  await teardownParkedCaptainResources(entry, { unregisterPool: false });
  // New pi Agent identity for reseed (like SessionManager.newSession minting a new id).
  const nextAgentSessionId =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `n4-reset-${Date.now().toString(36)}`;
  // Re-park with a no-op session shell so Todo survives; next attach builds a new Agent.
  const shell: Node4AgentSession = {
    prompt: async () => {},
    abort: () => {},
    dispose: () => {},
    reset: () => {},
    subscribe: () => () => {},
    steer: () => {},
    followUp: () => {},
    get messages() {
      return [];
    },
    get sessionId() {
      return nextAgentSessionId;
    },
  };
  parkWorkingSession({
    ...entry,
    session: shell,
    dispose: () => {},
    parkedAt: Date.now(),
    agentSessionId: nextAgentSessionId,
    needsAgentReseed: true,
  });
  // Legacy flag still checked by parkNeedsAgentReseed for older tests.
  (shell as { __memoryReset?: boolean }).__memoryReset = true;
  return { ok: true, openTodoCount, agentSessionId: nextAgentSessionId };
}

/** True when park session is a post-Reset shell (needs Agent reseed on attach). */
export function parkNeedsAgentReseed(entry: ParkedWorkingRuntime): boolean {
  if (entry.needsAgentReseed) return true;
  const msgs = entry.session?.messages;
  if (!Array.isArray(msgs) || msgs.length > 0) return false;
  return Boolean((entry.session as { __memoryReset?: boolean } | undefined)?.__memoryReset);
}

export function clearWorkingSessionParksForTests(): void {
  for (const entry of parks.values()) {
    void teardownParkedCaptainResources(entry).catch(() => {});
  }
  parks.clear();
  clearPendingDisposeForTests();
}

export function countParkedSessionsForTests(): number {
  return parks.size;
}
