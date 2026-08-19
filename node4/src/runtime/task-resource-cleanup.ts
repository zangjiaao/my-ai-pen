/**
 * End-of-work-burst resource teardown (Spec #333 amended by #426 / #427 / #354).
 *
 * - Does **not** dispose the subagent idle pool — Workers park with the Captain
 *   across Task settle/error/interrupt so continue can `resume_agent_id`.
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
  /** OMP idle subagent pool — ignored; Workers park with Captain (Spec #354). */
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
 * Burst-end cleanup: sticky browser and idle Workers both survive.
 * Idle pool is torn down with Captain Session dispose, not here.
 */
export async function runTaskResourceCleanup(_input: TaskResourceCleanupInput): Promise<void> {
  // Spec #427: do not disposeBrowserSandbox on task end / interrupt.
  // Spec #354: do not disposeAll idle Workers on task end — continue resumes them.
}
