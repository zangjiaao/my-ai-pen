/**
 * Spec #333 amended #427: task-end cleanup disposes idle pool only — not sticky browser.
 * Run: npx tsx src/runtime/task-resource-cleanup.test.ts
 */
import { runTaskResourceCleanup } from "./task-resource-cleanup.js";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
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

// --- idle pool disposeAll still runs ---
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
  assert(steps.join(",") === "idle", "idle only; browser skipped");
}

// --- idle pool failure does not throw ---
{
  await runTaskResourceCleanup({
    parentTaskId: "task-err",
    idlePool: {
      async disposeAll() {
        throw new Error("idle boom");
      },
    },
  });
  assert(true, "cleanup does not throw on idle failure");
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

console.log(JSON.stringify({ ok: true, cases: "task-cleanup-no-browser-dispose" }, null, 2));
console.log("RESULT: PASS — task resource cleanup (#427)");
