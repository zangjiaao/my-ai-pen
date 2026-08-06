/**
 * Lightweight concurrency helpers (OMP-inspired, smaller surface).
 * Soft package failures should return results, not throw.
 *
 * Spec #302 (Grok-like subagent limits):
 * - NODE4_SUBAGENT_CONCURRENCY = scheduler pool size only (queue, never reject).
 * - NODE4_SUBAGENT_TASK_BUDGET = per-task cumulative admitted packages.
 * - MAX_SUBAGENT_BATCH = abuse/DoS safety ceiling only.
 * - No hard path-dispatch kill (same path may fan out freely under budget).
 */

export type MapConcurrencyResult<R> = {
  results: (R | undefined)[];
  aborted: boolean;
};

/**
 * Worker-pool map. Preserves input order.
 * Per-item errors: if `fn` throws, result is undefined at that index and siblings continue (no fail-fast).
 * AbortSignal: stop scheduling new work; in-flight complete.
 * Items beyond the concurrency window **queue** until a slot frees — never discarded by this helper.
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
 * Subagent batch concurrency — pure scheduling pool size.
 * Packages beyond the window queue; must not reject/discard solely because the pool is full.
 * Default 8; clamp 1–16. Env: NODE4_SUBAGENT_CONCURRENCY.
 */
export function resolveSubagentConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.NODE4_SUBAGENT_CONCURRENCY;
  if (raw == null || String(raw).trim() === "") return 8;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 8;
  return Math.max(1, Math.min(16, Math.floor(n)));
}

/**
 * Safety ceiling only (abuse/DoS) on packages[] length in one tool call.
 * Not a normal "agent may only plan N workers" product cap.
 * Hard error if exceeded.
 */
export const MAX_SUBAGENT_BATCH = 32;

/** Default per-task cumulative admitted package budget (Grok workflow order of magnitude). */
export const DEFAULT_SUBAGENT_TASK_BUDGET = 128;

/** Hard clamp for NODE4_SUBAGENT_TASK_BUDGET (Grok-like max). */
export const MAX_SUBAGENT_TASK_BUDGET = 1024;

/**
 * Per-task cumulative package spawn budget.
 * Counts packages **admitted** after validation (spawn or queue). Default 128; clamp 1–1024.
 * Env: NODE4_SUBAGENT_TASK_BUDGET.
 */
export function resolveSubagentTaskBudget(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.NODE4_SUBAGENT_TASK_BUDGET;
  if (raw == null || String(raw).trim() === "") return DEFAULT_SUBAGENT_TASK_BUDGET;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_SUBAGENT_TASK_BUDGET;
  return Math.max(1, Math.min(MAX_SUBAGENT_TASK_BUDGET, Math.floor(n)));
}

/**
 * Admit one package against the per-task budget.
 * Call only after package validation succeeds (schema, nest, goal, prior-avoid, etc.).
 * On exhaustion returns a clear error string for the tool layer.
 */
export function tryAdmitSubagentPackage(lifecycle: {
  subagentPackagesAdmitted?: number;
}): { ok: true; used: number; budget: number } | { ok: false; error: string; used: number; budget: number } {
  const budget = resolveSubagentTaskBudget();
  const used = Math.max(0, Math.floor(Number(lifecycle.subagentPackagesAdmitted ?? 0)) || 0);
  if (used >= budget) {
    return {
      ok: false,
      used,
      budget,
      error:
        `error: subagent task budget exhausted (${used}/${budget} packages admitted this task). ` +
        `Finish/report with current evidence or raise NODE4_SUBAGENT_TASK_BUDGET (max ${MAX_SUBAGENT_TASK_BUDGET}). ` +
        `Already-running or finished packages remain honest partial — do not re-spawn blindly.`,
    };
  }
  lifecycle.subagentPackagesAdmitted = used + 1;
  return { ok: true, used: used + 1, budget };
}

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
