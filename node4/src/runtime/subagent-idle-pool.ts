/**
 * OMP-style idle subagent pool: keep LLM sessions warm after a package so
 * same-path re-dispatch re-prompts instead of cold createAgentSession.
 *
 * Keyed by pathKey (pathname). Exclusive take — concurrent packages on the
 * same path still cold-start the second one.
 */

export type IdleSubagentHandle = {
  pathKey: string;
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

export type SubagentIdlePoolOptions = {
  /** Max parked sessions (LRU dispose). Default 4. */
  maxIdle?: number;
  /** Idle TTL ms; expired slots disposed on access. Default 15 min. */
  ttlMs?: number;
  /** Max packages per warm session before force-dispose. Default 4. */
  maxPackages?: number;
};

const DEFAULT_MAX_IDLE = 4;
const DEFAULT_TTL_MS = 15 * 60 * 1000;
const DEFAULT_MAX_PACKAGES = 4;

export function resolveIdlePoolEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = String(env.NODE4_SUBAGENT_IDLE ?? "1").trim().toLowerCase();
  return v !== "0" && v !== "false" && v !== "off" && v !== "no";
}

export function resolveIdlePoolOptions(env: NodeJS.ProcessEnv = process.env): Required<SubagentIdlePoolOptions> {
  const maxIdle = clampInt(env.NODE4_SUBAGENT_IDLE_MAX, DEFAULT_MAX_IDLE, 1, 16);
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
 * In-memory idle registry for one parent task lifecycle.
 */
export class SubagentIdlePool {
  private readonly byPath = new Map<string, IdleSubagentHandle>();
  private readonly opts: Required<SubagentIdlePoolOptions>;

  constructor(opts?: SubagentIdlePoolOptions) {
    this.opts = {
      maxIdle: opts?.maxIdle ?? DEFAULT_MAX_IDLE,
      ttlMs: opts?.ttlMs ?? DEFAULT_TTL_MS,
      maxPackages: opts?.maxPackages ?? DEFAULT_MAX_PACKAGES,
    };
  }

  get size(): number {
    return this.byPath.size;
  }

  get options(): Required<SubagentIdlePoolOptions> {
    return this.opts;
  }

  /** Snapshot path keys currently parked (for tests / telemetry). */
  keys(): string[] {
    return [...this.byPath.keys()];
  }

  /**
   * Exclusive take: removes from pool so concurrent packages cannot share one session.
   * Returns undefined if miss, expired, or over maxPackages (expired disposed).
   */
  tryTake(pathKey: string, now = Date.now()): IdleSubagentHandle | undefined {
    const key = String(pathKey || "").trim();
    if (!key) return undefined;
    const handle = this.byPath.get(key);
    if (!handle) return undefined;
    this.byPath.delete(key);

    if (now - handle.lastUsedAt > this.opts.ttlMs) {
      void safeDispose(handle);
      return undefined;
    }
    if (handle.packagesCompleted >= this.opts.maxPackages) {
      void safeDispose(handle);
      return undefined;
    }
    return handle;
  }

  /**
   * Park a finished session for later same-path reuse.
   * Evicts LRU when over maxIdle. No-ops empty pathKey.
   */
  park(handle: IdleSubagentHandle, now = Date.now()): void {
    const key = String(handle.pathKey || "").trim();
    if (!key) {
      void safeDispose(handle);
      return;
    }
    if (handle.packagesCompleted >= this.opts.maxPackages) {
      void safeDispose(handle);
      return;
    }

    // Replace existing idle for same path (dispose old).
    const prev = this.byPath.get(key);
    if (prev && prev !== handle) {
      this.byPath.delete(key);
      void safeDispose(prev);
    }

    handle.pathKey = key;
    handle.lastUsedAt = now;
    handle.clearAbort?.();
    handle.clearAbort = undefined;
    this.byPath.set(key, handle);

    while (this.byPath.size > this.opts.maxIdle) {
      const lruKey = this.findLruKey();
      if (!lruKey) break;
      const evicted = this.byPath.get(lruKey);
      this.byPath.delete(lruKey);
      if (evicted) void safeDispose(evicted);
    }
  }

  /** Drop expired without take (periodic / before batch). */
  evictExpired(now = Date.now()): number {
    let n = 0;
    for (const [key, handle] of [...this.byPath.entries()]) {
      if (now - handle.lastUsedAt > this.opts.ttlMs) {
        this.byPath.delete(key);
        void safeDispose(handle);
        n++;
      }
    }
    return n;
  }

  /** Dispose all parked sessions (task end / abort). */
  async disposeAll(): Promise<void> {
    const all = [...this.byPath.values()];
    this.byPath.clear();
    await Promise.all(all.map((h) => safeDispose(h)));
  }

  private findLruKey(): string | undefined {
    let best: string | undefined;
    let bestTs = Infinity;
    for (const [key, h] of this.byPath) {
      if (h.lastUsedAt < bestTs) {
        bestTs = h.lastUsedAt;
        best = key;
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
