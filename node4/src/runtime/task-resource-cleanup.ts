/**
 * End-of-work-burst resource teardown (Spec #333 amended by #426 / #427).
 *
 * - Still disposes subagent idle pool (package-scoped).
 * - Does **not** dispose Session-sticky pen-sandbox (browser) — that lives until
 *   Session Delete / Case close / transfer (Spec #421).
 */
export type TaskIdlePoolHandle = {
  disposeAll(): Promise<void>;
};

/**
 * @deprecated Sticky browser is not disposed on task end. Field ignored if present.
 */
export type TaskBrowserSandboxHandle = {
  dispose(parentTaskId: string): Promise<void>;
};

export type TaskResourceCleanupInput = {
  /**
   * @deprecated Not used for browser dispose after Spec #427.
   * Kept so call sites can still pass parentTaskId without type break.
   */
  parentTaskId?: string;
  /** OMP idle subagent pool (optional). */
  idlePool?: TaskIdlePoolHandle | null;
  /**
   * @deprecated Ignored — sticky pen-sandbox is not torn down at task end.
   */
  browserSandbox?: TaskBrowserSandboxHandle | null;
  /**
   * @deprecated No browser dispose on task end.
   */
  browserDisposeTimeoutMs?: number;
};

/**
 * Dispose package-scoped resources only (idle subagent pool).
 * Browser sticky env is intentionally left running.
 */
export async function runTaskResourceCleanup(input: TaskResourceCleanupInput): Promise<void> {
  if (input.idlePool?.disposeAll) {
    try {
      await input.idlePool.disposeAll();
    } catch {
      /* best-effort */
    }
  }
  // Spec #427: do not disposeBrowserSandbox on task end / interrupt.
}
