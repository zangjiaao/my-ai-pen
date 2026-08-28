/**
 * OMP-style idle subagent worker registry.
 *
 * Keep-alive: after a package the worker stays idle (live session) for
 * explicit resume_agent_id + same-path affinity.
 *
 * Bounded release (prevents unbounded AgentSession growth):
 * - Active idle TTL timer → hard release (dispose + drop) — OMP default 420s
 * - maxIdle LRU release
 * - maxPackages → refuse re-park / release
 * - explicit release(agent_id)
 * - Session dispose (Case close / Session delete / Reset / expert transfer) — not Task end
 * - operator End (`worker_release`)
 *
 * Disable: NODE4_SUBAGENT_IDLE=0.
 */

import type { PanelAgentTracker } from "./panel-agents.js";

export type WorkerAffinity = {
  pathKey: string;
  nodeType?: string;
  skillId?: string;
};

export type IdleSubagentHandle = {
  /** Stable worker id returned to Main as agent_id (usually host subagent id). */
  agentId: string;
  pathKey: string;
  nodeType?: string;
  skillId?: string;
  /** Live pi AgentSession (must not be disposed while idle). */
  session: {
    prompt: (text: string, opts?: { source?: string }) => Promise<unknown>;
    abort?: () => unknown;
    dispose?: () => unknown;
  };
  /** Child workDir bound to the session cwd / cookies / tool-output. */
  workDir: string;
  segmentCounter: { tools: number };
  packagesCompleted: number;
  createdAt: number;
  lastUsedAt: number;
  /** Detach package-scoped abort listener if any. */
  clearAbort?: () => void;
  /** Active idle TTL timer handle (cleared on take / release). */
  idleTimer?: ReturnType<typeof setTimeout>;
  /**
   * Spec #308: child ToolRuntime kept so warm packages can update workerAudit
   * package_turn_id (tool/process bridges close over this object).
   */
  childRuntime?: import("../types.js").ToolRuntime;
  /** Spec #308: dispose Worker process stream on hard release. */
  disposeWorkerAudit?: () => Promise<void>;
  /**
   * Spec #487: child pi usage ledger + event subscription.
   * Park retains it (cumulative warm resume). Hard release disposes it.
   */
  usageMeter?: {
    snapshot: () => import("./llm-usage.js").LlmUsageSnapshot;
    dispose: () => void;
  };
  /**
   * Set when `release()` abort+disposes this handle (operator End, TTL, abort).
   * `park()` must refuse so a finished package cannot revive a zombie session.
   */
  hardReleased?: boolean;
};

export type IdleWorkerSnapshot = {
  agent_id: string;
  path_key: string;
  node_type?: string;
  skill_id?: string;
  packages_completed: number;
  idle_ms: number;
  work_dir: string;
};

export type ResumeResult =
  | { ok: true; handle: IdleSubagentHandle }
  | { ok: false; reason: ResumeRejectReason };

export type ResumeRejectReason =
  | "disabled"
  | "missing_agent_id"
  | "not_found"
  | "expired"
  | "max_packages"
  | "path_mismatch"
  | "skill_mismatch"
  | "empty_path";

export type SubagentIdlePoolOptions = {
  /** Max idle workers (LRU release). Default 8. */
  maxIdle?: number;
  /**
   * Idle TTL ms; active timer hard-releases the worker (dispose session).
   * Default 420_000 (OMP task.agentIdleTtlMs).
   */
  ttlMs?: number;
  /** Max packages per warm worker before force-release. Default 4. */
  maxPackages?: number;
};

/** OMP-aligned default idle TTL (7 minutes). */
const DEFAULT_MAX_IDLE = 8;
const DEFAULT_TTL_MS = 420_000;
const DEFAULT_MAX_PACKAGES = 4;

export function resolveIdlePoolEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = String(env.NODE4_SUBAGENT_IDLE ?? "1").trim().toLowerCase();
  return v !== "0" && v !== "false" && v !== "off" && v !== "no";
}

export function resolveIdlePoolOptions(env: NodeJS.ProcessEnv = process.env): Required<SubagentIdlePoolOptions> {
  const maxIdle = clampInt(env.NODE4_SUBAGENT_IDLE_MAX, DEFAULT_MAX_IDLE, 1, 32);
  const ttlMs = clampInt(env.NODE4_SUBAGENT_IDLE_TTL_MS, DEFAULT_TTL_MS, 5_000, 3_600_000);
  const maxPackages = clampInt(env.NODE4_SUBAGENT_IDLE_MAX_PACKAGES, DEFAULT_MAX_PACKAGES, 1, 20);
  return { maxIdle, ttlMs, maxPackages };
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw == null || String(raw).trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

async function safeDispose(handle: IdleSubagentHandle): Promise<void> {
  clearIdleTimer(handle);
  try {
    handle.clearAbort?.();
  } catch {
    /* ignore */
  }
  try {
    handle.usageMeter?.dispose();
    await Promise.resolve(handle.session.abort?.());
  } catch {
    /* ignore */
  }
  try {
    await Promise.resolve(handle.disposeWorkerAudit?.());
  } catch {
    /* ignore */
  }
  try {
    await Promise.resolve(handle.session.dispose?.());
  } catch {
    /* ignore */
  }
}

function clearIdleTimer(handle: IdleSubagentHandle): void {
  if (handle.idleTimer) {
    clearTimeout(handle.idleTimer);
    handle.idleTimer = undefined;
  }
}

/**
 * Affinity gate: same path required; skill mismatch when both set rejects.
 * node_type may change on same path (e.g. gap re-dispatch).
 */
export function checkAffinity(
  handle: Pick<IdleSubagentHandle, "pathKey" | "skillId" | "packagesCompleted">,
  affinity: WorkerAffinity,
  opts: { maxPackages: number; ttlMs: number },
  now = Date.now(),
  lastUsedAt?: number,
): ResumeRejectReason | null {
  const want = String(affinity.pathKey || "").trim();
  const have = String(handle.pathKey || "").trim();
  if (!want || !have) return "empty_path";
  if (want !== have) return "path_mismatch";
  const wantSkill = String(affinity.skillId || "").trim();
  const haveSkill = String(handle.skillId || "").trim();
  if (wantSkill && haveSkill && wantSkill !== haveSkill) return "skill_mismatch";
  if (handle.packagesCompleted >= opts.maxPackages) return "max_packages";
  if (lastUsedAt != null && now - lastUsedAt > opts.ttlMs) return "expired";
  return null;
}

/**
 * In-memory worker registry for one parent Session (parks across Task bursts).
 * Keyed by agentId (not pathKey).
 *
 * Spec #491: pools register globally so operator End can release idle *or* live
 * workers without walking parked captains. Lookup is Case-scoped (`conversationId`).
 */
const REGISTERED_POOLS = new Set<SubagentIdlePool>();

export class SubagentIdlePool {
  private readonly byId = new Map<string, IdleSubagentHandle>();
  /** In-flight packages (taken from idle / cold spawn not yet parked). */
  private readonly live = new Map<string, IdleSubagentHandle>();
  /**
   * Operator End / op=release arrived after the collab row exists but before
   * `noteLive`. Consume on noteLive/park so the package cannot re-idle.
   */
  private readonly pendingEnds = new Set<string>();
  private readonly opts: Required<SubagentIdlePoolOptions>;
  private panel: PanelAgentTracker | undefined;
  /** Case this pool belongs to. Empty until bound; End must pass the same id. */
  conversationId = "";

  constructor(opts?: SubagentIdlePoolOptions, panel?: PanelAgentTracker, conversationId?: string) {
    this.opts = {
      maxIdle: opts?.maxIdle ?? DEFAULT_MAX_IDLE,
      ttlMs: opts?.ttlMs ?? DEFAULT_TTL_MS,
      maxPackages: opts?.maxPackages ?? DEFAULT_MAX_PACKAGES,
    };
    this.panel = panel;
    this.conversationId = String(conversationId || "").trim();
    REGISTERED_POOLS.add(this);
  }

  bindPanel(panel: PanelAgentTracker | undefined): void {
    if (panel) this.panel = panel;
  }

  bindConversation(conversationId: string | undefined): void {
    const id = String(conversationId || "").trim();
    if (!id || this.conversationId) return;
    this.conversationId = id;
  }

  get size(): number {
    return this.byId.size;
  }

  get options(): Required<SubagentIdlePoolOptions> {
    return this.opts;
  }

  /** Snapshot idle agent ids (for tests / telemetry). */
  ids(): string[] {
    return [...this.byId.keys()];
  }

  /** OMP-style roster for Main (no secrets). */
  listIdle(now = Date.now()): IdleWorkerSnapshot[] {
    const out: IdleWorkerSnapshot[] = [];
    for (const h of this.byId.values()) {
      out.push({
        agent_id: h.agentId,
        path_key: h.pathKey,
        node_type: h.nodeType,
        skill_id: h.skillId,
        packages_completed: h.packagesCompleted,
        idle_ms: Math.max(0, now - h.lastUsedAt),
        work_dir: h.workDir,
      });
    }
    return out.sort((a, b) => a.idle_ms - b.idle_ms);
  }

  /**
   * Non-mutating affinity probe (does not exclusive-take).
   */
  checkResume(agentId: string, affinity: WorkerAffinity, now = Date.now()): ResumeResult {
    const id = String(agentId || "").trim();
    if (!id) return { ok: false, reason: "missing_agent_id" };
    const handle = this.byId.get(id);
    if (!handle) return { ok: false, reason: "not_found" };
    const reason = checkAffinity(handle, affinity, this.opts, now, handle.lastUsedAt);
    if (reason) return { ok: false, reason };
    return { ok: true, handle };
  }

  /**
   * Exclusive resume: removes from pool, clears TTL timer.
   * Affinity gate enforced. Expired/max → release.
   */
  tryResume(agentId: string, affinity: WorkerAffinity, now = Date.now()): ResumeResult {
    const id = String(agentId || "").trim();
    if (!id) return { ok: false, reason: "missing_agent_id" };
    const handle = this.byId.get(id);
    if (!handle) return { ok: false, reason: "not_found" };

    const reason = checkAffinity(handle, affinity, this.opts, now, handle.lastUsedAt);
    if (reason === "expired" || reason === "max_packages") {
      void this.release(id);
      return { ok: false, reason };
    }
    if (reason) return { ok: false, reason };

    this.byId.delete(id);
    clearIdleTimer(handle);
    this.live.set(id, handle);
    return { ok: true, handle };
  }

  /**
   * @deprecated pathKey auto-take disabled (pollution).
   */
  tryTake(_pathKey: string, _now = Date.now()): IdleSubagentHandle | undefined {
    return undefined;
  }

  /**
   * Park a finished worker for later explicit resume.
   * Arms idle TTL timer (OMP). Evicts LRU when over maxIdle.
   * Over maxPackages → hard release instead of park.
   */
  park(handle: IdleSubagentHandle, now = Date.now()): void {
    if (handle.hardReleased) return;
    const id = String(handle.agentId || "").trim();
    if (id && this.pendingEnds.has(id)) {
      void this.consumePendingEnd(id, handle);
      return;
    }
    const key = String(handle.pathKey || "").trim();
    if (!id || !key) {
      void safeDispose(handle);
      return;
    }
    if (handle.packagesCompleted >= this.opts.maxPackages) {
      void safeDispose(handle);
      return;
    }

    const prev = this.byId.get(id);
    if (prev && prev !== handle) {
      this.byId.delete(id);
      void safeDispose(prev);
    }

    handle.agentId = id;
    handle.pathKey = key;
    handle.lastUsedAt = now;
    handle.clearAbort?.();
    handle.clearAbort = undefined;
    clearIdleTimer(handle);
    this.live.delete(id);
    this.byId.set(id, handle);
    REGISTERED_POOLS.add(this);
    this.armIdleTimer(handle);

    while (this.byId.size > this.opts.maxIdle) {
      const lruId = this.findLruId();
      if (!lruId || lruId === id) {
        // Prefer evicting someone else; if only self, still enforce cap by releasing self.
        if (lruId === id && this.byId.size > this.opts.maxIdle) {
          void this.release(id);
        }
        break;
      }
      void this.release(lruId);
    }
  }

  /**
   * Track an in-flight Worker so operator End can abort it (Spec #491).
   * @returns false when operator End already claimed this id — caller must not
   * prompt or emit package start; the handle is abort+disposed.
   */
  async noteLive(handle: IdleSubagentHandle): Promise<boolean> {
    const id = String(handle.agentId || "").trim();
    if (!id) return false;
    if (handle.hardReleased) return false;
    if (await this.consumePendingEnd(id, handle)) return false;
    this.live.set(id, handle);
    return true;
  }

  /**
   * Hard remove (OMP release): clear timer, abort+dispose session, drop id.
   * Works for idle park *or* in-flight live handles.
   * Returns true if the worker was present.
   *
   * `dropFromPanel` is for operator End / Agent `op=release`: keep the collab
   * row and stamp status `released` (grey light). Abort, TTL, LRU, and task
   * disposeAll leave completed/failed status as-is.
   */
  async release(agentId: string, opts?: { dropFromPanel?: boolean }): Promise<boolean> {
    const id = String(agentId || "").trim();
    if (!id) return false;
    const idle = this.byId.get(id);
    if (idle) {
      idle.hardReleased = true;
      this.byId.delete(id);
      this.live.delete(id);
      await safeDispose(idle);
      if (opts?.dropFromPanel) this.panel?.noteSubagentReleased(id);
      return true;
    }
    const live = this.live.get(id);
    if (live) {
      live.hardReleased = true;
      this.live.delete(id);
      await safeDispose(live);
      if (opts?.dropFromPanel) this.panel?.noteSubagentReleased(id);
      return true;
    }
    if (opts?.dropFromPanel) {
      const dropped = this.panel?.noteSubagentReleased(id) ?? false;
      if (dropped) {
        this.pendingEnds.add(id);
        return true;
      }
    }
    return false;
  }

  /** End-before-live: mark, abort, dispose; caller must not start the package. */
  private async consumePendingEnd(id: string, handle: IdleSubagentHandle): Promise<boolean> {
    if (!this.pendingEnds.delete(id)) return false;
    handle.hardReleased = true;
    await safeDispose(handle);
    return true;
  }

  /** Drop expired without waiting for timer (best-effort sync). */
  evictExpired(now = Date.now()): number {
    let n = 0;
    for (const [id, handle] of [...this.byId.entries()]) {
      if (now - handle.lastUsedAt > this.opts.ttlMs) {
        void this.release(id);
        n++;
      }
    }
    return n;
  }

  /** Dispose idle + live workers. Session teardown may unregister this pool. */
  async disposeAll(options?: { unregister?: boolean }): Promise<void> {
    const ids = [...this.byId.keys()];
    const liveIds = [...this.live.keys()];
    await Promise.all([...ids, ...liveIds].map((id) => this.release(id)));
    this.pendingEnds.clear();
    if (options?.unregister !== false) {
      REGISTERED_POOLS.delete(this);
    }
  }

  private armIdleTimer(handle: IdleSubagentHandle): void {
    if (this.opts.ttlMs <= 0) return;
    clearIdleTimer(handle);
    const id = handle.agentId;
    const timer = setTimeout(() => {
      // Only release if still the same parked entry.
      const cur = this.byId.get(id);
      if (cur === handle) {
        void this.release(id);
      }
    }, this.opts.ttlMs);
    timer.unref?.();
    handle.idleTimer = timer;
  }

  private findLruId(): string | undefined {
    let best: string | undefined;
    let bestTs = Infinity;
    for (const [id, h] of this.byId) {
      if (h.lastUsedAt < bestTs) {
        bestTs = h.lastUsedAt;
        best = id;
      }
    }
    return best;
  }
}

/** Lazy attach pool on parent lifecycle. */
export function getOrCreateIdlePool(
  lifecycle: { subagentIdlePool?: SubagentIdlePool; panelAgents?: PanelAgentTracker },
  env: NodeJS.ProcessEnv = process.env,
  conversationId?: string,
): SubagentIdlePool | undefined {
  if (!resolveIdlePoolEnabled(env)) return undefined;
  if (!lifecycle.subagentIdlePool) {
    lifecycle.subagentIdlePool = new SubagentIdlePool(
      resolveIdlePoolOptions(env),
      lifecycle.panelAgents,
      conversationId,
    );
  } else {
    REGISTERED_POOLS.add(lifecycle.subagentIdlePool);
    if (lifecycle.panelAgents) {
      lifecycle.subagentIdlePool.bindPanel(lifecycle.panelAgents);
    }
    lifecycle.subagentIdlePool.bindConversation(conversationId);
  }
  return lifecycle.subagentIdlePool;
}

/**
 * Spec #491: operator End — dispose idle or live Worker; collab row stays released.
 * Requires `conversationId` so one Case cannot abort another tenant's Worker
 * on a shared Node process.
 */
export async function releaseWorkerById(agentId: string, conversationId?: string): Promise<boolean> {
  const id = String(agentId || "").trim();
  const conv = String(conversationId || "").trim();
  if (!id || !conv) return false;
  let found = false;
  for (const pool of REGISTERED_POOLS) {
    if (pool.conversationId !== conv) continue;
    if (await pool.release(id, { dropFromPanel: true })) found = true;
  }
  return found;
}

/** Test helper: drop constructor registrations. */
export function clearRegisteredIdlePoolsForTests(): void {
  REGISTERED_POOLS.clear();
}
