/**
 * Lightweight concurrency helpers (OMP-inspired, smaller surface).
 * Soft package failures should return results, not throw.
 */

export type MapConcurrencyResult<R> = {
  results: (R | undefined)[];
  aborted: boolean;
};

/**
 * Worker-pool map. Preserves input order.
 * Per-item errors: if `fn` throws, result is undefined at that index and siblings continue (no fail-fast).
 * AbortSignal: stop scheduling new work; in-flight complete.
 */
export async function mapWithConcurrencyLimit<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<MapConcurrencyResult<R>> {
  const n = items.length;
  if (n === 0) return { results: [], aborted: false };

  const limit = Math.max(1, Math.min(Math.floor(concurrency) || 1, n));
  const results: (R | undefined)[] = new Array(n);
  let next = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      if (signal?.aborted) return;
      const index = next++;
      if (index >= n) return;
      try {
        results[index] = await fn(items[index]!, index);
      } catch {
        results[index] = undefined;
      }
    }
  };

  await Promise.all(Array.from({ length: limit }, () => worker()));
  return { results, aborted: Boolean(signal?.aborted) };
}

/**
 * Default subagent batch concurrency for pentest.
 * Orthogonal modules should cold-fan-out (OMP-style wall-clock win).
 * Cap 16 (OMP default 32 — we stay conservative).
 */
export function resolveSubagentConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.NODE4_SUBAGENT_CONCURRENCY;
  if (raw == null || String(raw).trim() === "") return 8;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 8;
  return Math.max(1, Math.min(16, Math.floor(n)));
}

/**
 * Safety ceiling only (abuse/DoS). Not a product quality gate —
 * concurrent fan-out is bounded by NODE4_SUBAGENT_CONCURRENCY instead.
 */
export const MAX_SUBAGENT_BATCH = 32;

/** Max dispatches per pathname per task (re-dispatch budget). */
export const MAX_PATH_DISPATCHES = 2;

/** Simple promise chain mutex for serializing short critical sections. */
export function createMutex(): <T>(fn: () => Promise<T>) => Promise<T> {
  let chain: Promise<unknown> = Promise.resolve();
  return function withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = chain.then(() => fn());
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}
