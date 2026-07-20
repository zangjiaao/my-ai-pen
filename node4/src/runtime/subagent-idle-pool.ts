/**
 * OMP-style idle subagent worker registry.
 *
 * Workers stay warm after a package (keep-alive) and are resumed only by
 * **explicit agent_id** with an **affinity gate** (same pathKey required).
 * Orthogonal paths always cold-start — no automatic pathKey grab.
 *
 * Disable: NODE4_SUBAGENT_IDLE=0.
 */

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
  /** Live pi AgentSession (must not be disposed while parked). */
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
  /** Max parked workers (LRU dispose). Default 8. */
  maxIdle?: number;
  /** Idle TTL ms; expired slots disposed on access. Default 15 min. */
  ttlMs?: number;
  /** Max packages per warm worker before force-dispose. Default 4. */
  maxPackages?: number;
};

const DEFAULT_MAX_IDLE = 8;
const DEFAULT_TTL_MS = 15 * 60 * 1000;
const DEFAULT_MAX_PACKAGES = 4;

export function resolveIdlePoolEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = String(env.NODE4_SUBAGENT_IDLE ?? "1").trim().toLowerCase();
  return v !== "0" && v !== "false" && v !== "off" && v !== "no";
}

export function resolveIdlePoolOptions(env: NodeJS.ProcessEnv = process.env): Required<SubagentIdlePoolOptions> {
  const maxIdle = clampInt(env.NODE4_SUBAGENT_IDLE_MAX, DEFAULT_MAX_IDLE, 1, 32);
  const ttlMs = clampInt(env.NODE4_SUBAGENT_IDLE_TTL_MS, DEFAULT_TTL_MS, 30_000, 3_600_000);
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
  try {
    handle.clearAbort?.();
  } catch {
    /* ignore */
  }
  try {
    await Promise.resolve(handle.session.dispose?.());
  } catch {
    /* ignore */
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
 * In-memory worker registry for one parent task lifecycle.
 * Keyed by agentId (not pathKey).
 */
export class SubagentIdlePool {
  private readonly byId = new Map<string, IdleSubagentHandle>();
  private readonly opts: Required<SubagentIdlePoolOptions>;

  constructor(opts?: SubagentIdlePoolOptions) {
    this.opts = {
      maxIdle: opts?.maxIdle ?? DEFAULT_MAX_IDLE,
      ttlMs: opts?.ttlMs ?? DEFAULT_TTL_MS,
      maxPackages: opts?.maxPackages ?? DEFAULT_MAX_PACKAGES,
    };
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

  /**
   * Non-mutating affinity probe (does not exclusive-take).
   * Used by the tool layer before choosing spawn subagentId.
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
   * Exclusive resume: removes from pool so concurrent callers cannot share.
   * Affinity gate enforced. On reject, handle stays parked (except expired/max → disposed).
   */
  tryResume(agentId: string, affinity: WorkerAffinity, now = Date.now()): ResumeResult {
    const id = String(agentId || "").trim();
    if (!id) return { ok: false, reason: "missing_agent_id" };
    const handle = this.byId.get(id);
    if (!handle) return { ok: false, reason: "not_found" };

    const reason = checkAffinity(handle, affinity, this.opts, now, handle.lastUsedAt);
    if (reason === "expired" || reason === "max_packages") {
      this.byId.delete(id);
      void safeDispose(handle);
      return { ok: false, reason };
    }
    if (reason) return { ok: false, reason };

    this.byId.delete(id);
    return { ok: true, handle };
  }

  /**
   * @deprecated Use tryResume(agentId, affinity). Kept for tests that used pathKey take —
   * now no-ops path-only grab (always miss) to avoid silent pollution.
   */
  tryTake(_pathKey: string, _now = Date.now()): IdleSubagentHandle | undefined {
    return undefined;
  }

  /**
   * Park a finished worker for later explicit resume.
   * Evicts LRU when over maxIdle.
   */
  park(handle: IdleSubagentHandle, now = Date.now()): void {
    const id = String(handle.agentId || "").trim();
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
    this.byId.set(id, handle);

    while (this.byId.size > this.opts.maxIdle) {
      const lruId = this.findLruId();
      if (!lruId) break;
      const evicted = this.byId.get(lruId);
      this.byId.delete(lruId);
      if (evicted) void safeDispose(evicted);
    }
  }

  /** Drop expired without take. */
  evictExpired(now = Date.now()): number {
    let n = 0;
    for (const [id, handle] of [...this.byId.entries()]) {
      if (now - handle.lastUsedAt > this.opts.ttlMs) {
        this.byId.delete(id);
        void safeDispose(handle);
        n++;
      }
    }
    return n;
  }

  /** Dispose all parked workers (task end / abort). */
  async disposeAll(): Promise<void> {
    const all = [...this.byId.values()];
    this.byId.clear();
    await Promise.all(all.map((h) => safeDispose(h)));
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
  lifecycle: { subagentIdlePool?: SubagentIdlePool },
  env: NodeJS.ProcessEnv = process.env,
): SubagentIdlePool | undefined {
  if (!resolveIdlePoolEnabled(env)) return undefined;
  if (!lifecycle.subagentIdlePool) {
    lifecycle.subagentIdlePool = new SubagentIdlePool(resolveIdlePoolOptions(env));
  }
  return lifecycle.subagentIdlePool;
}
