/**
 * Spec #333: task-end resource cleanup (idle pool + browser sandbox).
 * Run: npx tsx src/runtime/task-resource-cleanup.test.ts
 */
import { runTaskResourceCleanup } from "./task-resource-cleanup.js";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

// --- browser dispose called for parent task ---
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
  assert(disposed.length === 1 && disposed[0] === "task-end-1", "browser dispose on task end");
}

// --- abort path same cleanup ---
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
  assert(disposed[0] === "task-abort-1", "browser dispose on abort cleanup");
}

// --- idle pool disposeAll + browser dispose both run ---
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
  assert(steps.join(",") === "idle,browser:task-both", "idle then browser");
}

// --- idle pool failure does not block browser dispose ---
{
  const disposed: string[] = [];
  await runTaskResourceCleanup({
    parentTaskId: "task-err",
    idlePool: {
      async disposeAll() {
        throw new Error("idle boom");
      },
    },
    browserSandbox: {
      async dispose(id) {
        disposed.push(id);
      },
    },
  });
  assert(disposed[0] === "task-err", "browser still disposed after idle failure");
}

// --- browser dispose failure is swallowed (no throw) ---
{
  await runTaskResourceCleanup({
    parentTaskId: "task-browser-fail",
    browserSandbox: {
      async dispose() {
        throw new Error("browser boom");
      },
    },
  });
  assert(true, "cleanup does not throw");
}

// --- empty parentTaskId skips browser dispose ---
{
  let called = false;
  await runTaskResourceCleanup({
    parentTaskId: "  ",
    browserSandbox: {
      async dispose() {
        called = true;
      },
    },
  });
  assert(!called, "blank parentTaskId skips browser");
}

// --- browser dispose timeout is best-effort (does not hang forever) ---
{
  let started = false;
  const t0 = Date.now();
  await runTaskResourceCleanup({
    parentTaskId: "task-timeout",
    browserDisposeTimeoutMs: 50,
    browserSandbox: {
      async dispose() {
        started = true;
        await new Promise((r) => setTimeout(r, 5_000));
      },
    },
  });
  const elapsed = Date.now() - t0;
  assert(started, "dispose started");
  assert(elapsed < 2_000, `dispose timed out without hanging (${elapsed}ms)`);
}

console.log(JSON.stringify({ ok: true, cases: "task-resource-cleanup" }, null, 2));
console.log("RESULT: PASS — task resource cleanup (#333)");
