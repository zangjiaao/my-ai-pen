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
  /**
   * Max wait for browser dispose (docker close+rm under parent lock).
   * Default 60s so task finally cannot hang forever on a stuck daemon.
   */
  browserDisposeTimeoutMs?: number;
};

/** Default bound: agent-browser close (30s) + docker rm (30s) under lock. */
export const DEFAULT_BROWSER_DISPOSE_TIMEOUT_MS = 60_000;

async function withTimeout(promise: Promise<void>, ms: number, label: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Dispose task-scoped resources: idle subagent pool then browser sandbox.
 * Each step is best-effort (errors swallowed) so one failure does not block the other.
 * Browser dispose is deadline-bounded (review residual on task-end latency).
 */
export async function runTaskResourceCleanup(input: TaskResourceCleanupInput): Promise<void> {
  const parentTaskId = String(input.parentTaskId || "").trim();
  const disposeTimeout =
    input.browserDisposeTimeoutMs != null && input.browserDisposeTimeoutMs > 0
      ? Math.floor(input.browserDisposeTimeoutMs)
      : DEFAULT_BROWSER_DISPOSE_TIMEOUT_MS;

  if (input.idlePool?.disposeAll) {
    try {
      await input.idlePool.disposeAll();
    } catch {
      /* best-effort */
    }
  }

  if (!parentTaskId) return;

  try {
    const dispose = input.browserSandbox?.dispose
      ? input.browserSandbox.dispose(parentTaskId)
      : disposeBrowserSandbox(parentTaskId);
    await withTimeout(dispose, disposeTimeout, "browser sandbox dispose");
  } catch {
    /* best-effort — orphans reaped by lease/janitor */
  }
}
