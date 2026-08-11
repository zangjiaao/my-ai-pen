/**
 * Spec #333: centralized end-of-task resource teardown.
 * Mirrors subagent idle-pool dispose + runtime-owned browser sandbox dispose.
 * Agent tools must not own infrastructure lifecycle.
 */
import { disposeBrowserSandbox } from "./browser-sandbox.js";

export type TaskBrowserSandboxHandle = {
  dispose(parentTaskId: string): Promise<void>;
};

export type TaskIdlePoolHandle = {
  disposeAll(): Promise<void>;
};

export type TaskResourceCleanupInput = {
  /** Parent task id (platform work unit) — browser sandbox key. */
  parentTaskId: string;
  /** OMP idle subagent pool (optional). */
  idlePool?: TaskIdlePoolHandle | null;
  /**
   * Injectable browser sandbox dispose (tests / alternate runtime).
   * When omitted, uses process-default disposeBrowserSandbox.
   */
  browserSandbox?: TaskBrowserSandboxHandle | null;
};

/**
 * Dispose task-scoped resources: idle subagent pool then browser sandbox.
 * Each step is best-effort (errors swallowed) so one failure does not block the other.
 */
export async function runTaskResourceCleanup(input: TaskResourceCleanupInput): Promise<void> {
  const parentTaskId = String(input.parentTaskId || "").trim();

  if (input.idlePool?.disposeAll) {
    try {
      await input.idlePool.disposeAll();
    } catch {
      /* best-effort */
    }
  }

  if (!parentTaskId) return;

  try {
    if (input.browserSandbox?.dispose) {
      await input.browserSandbox.dispose(parentTaskId);
    } else {
      await disposeBrowserSandbox(parentTaskId);
    }
  } catch {
    /* best-effort */
  }
}
