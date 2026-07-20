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
 * - disposeAll on task end / abort
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
    clearIdleTimer(handle);
    this.byId.set(id, handle);
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
   * Hard remove (OMP release): clear timer, dispose session, drop id.
   * Returns true if the worker was present.
   */
  async release(agentId: string): Promise<boolean> {
    const id = String(agentId || "").trim();
    if (!id) return false;
    const handle = this.byId.get(id);
    if (!handle) return false;
    this.byId.delete(id);
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

  /** Dispose all idle workers (task end / abort). */
  async disposeAll(): Promise<void> {
    const ids = [...this.byId.keys()];
    await Promise.all(ids.map((id) => this.release(id)));
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
  lifecycle: { subagentIdlePool?: SubagentIdlePool },
  env: NodeJS.ProcessEnv = process.env,
): SubagentIdlePool | undefined {
  if (!resolveIdlePoolEnabled(env)) return undefined;
  if (!lifecycle.subagentIdlePool) {
    lifecycle.subagentIdlePool = new SubagentIdlePool(resolveIdlePoolOptions(env));
  }
  return lifecycle.subagentIdlePool;
}
