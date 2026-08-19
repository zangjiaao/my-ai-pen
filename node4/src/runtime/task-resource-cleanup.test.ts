/**
 * Spec #333 amended #427 / #354: task-end cleanup disposes neither sticky browser
 * nor idle Workers (Workers park with Captain).
 * Run: npx tsx src/runtime/task-resource-cleanup.test.ts
 */
import { runTaskResourceCleanup } from "./task-resource-cleanup.js";
import { SubagentIdlePool, type IdleSubagentHandle } from "./subagent-idle-pool.js";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

function fakeHandle(agentId: string, pathKey: string): IdleSubagentHandle {
  return {
    agentId,
    pathKey,
    session: {
      prompt: async () => undefined,
      dispose: () => {},
    },
    workDir: `/tmp/idle-${agentId}`,
    segmentCounter: { tools: 0 },
    packagesCompleted: 1,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
  };
}

// --- browser dispose NOT called on task end ---
{
  const disposed: string[] = [];
  await runTaskResourceCleanup({
    parentTaskId: "task-end-1",
    browserSandbox: {
      async dispose(id) {
        disposed.push(id);
      },
    },
  });
  assert(disposed.length === 0, "sticky browser not disposed on task end");
}

// --- abort path also does not dispose browser ---
{
  const disposed: string[] = [];
  await runTaskResourceCleanup({
    parentTaskId: "task-abort-1",
    browserSandbox: {
      async dispose(id) {
        disposed.push(id);
      },
    },
  });
  assert(disposed.length === 0, "no browser dispose on abort cleanup");
}

// --- idle pool disposeAll does NOT run on burst cleanup ---
{
  const steps: string[] = [];
  await runTaskResourceCleanup({
    parentTaskId: "task-both",
    idlePool: {
      async disposeAll() {
        steps.push("idle");
      },
    },
    browserSandbox: {
      async dispose(id) {
        steps.push(`browser:${id}`);
      },
    },
  });
  assert(steps.join(",") === "", "idle + browser skipped on burst end");
}

// --- parked idle worker still resumable after burst cleanup ---
{
  const pool = new SubagentIdlePool({ maxIdle: 4, ttlMs: 60_000, maxPackages: 4 });
  pool.park(fakeHandle("w1", "http://t/p"));
  await runTaskResourceCleanup({
    parentTaskId: "task-keep-idle",
    idlePool: pool,
  });
  const resume = pool.tryResume("w1", { pathKey: "http://t/p" });
  assert(resume.ok === true, "burst cleanup must not drop idle Workers");
  await pool.disposeAll();
}

// --- empty parentTaskId still ok ---
{
  await runTaskResourceCleanup({
    parentTaskId: "  ",
  });
  assert(true, "empty parent ok");
}

// --- no inputs ok ---
{
  await runTaskResourceCleanup({});
  assert(true, "empty input ok");
}

console.log(JSON.stringify({ ok: true, cases: "task-cleanup-no-idle-or-browser-dispose" }, null, 2));
console.log("RESULT: PASS — task resource cleanup (#427/#354)");
