/**
 * Run: npx tsx src/runtime/concurrency.test.ts
 */
import assert from "node:assert/strict";
import {
  createMutex,
  mapWithConcurrencyLimit,
  resolveSubagentConcurrency,
  resolveSubagentTaskBudget,
  tryAdmitSubagentPackage,
  MAX_SUBAGENT_BATCH,
  DEFAULT_SUBAGENT_TASK_BUDGET,
  MAX_SUBAGENT_TASK_BUDGET,
} from "./concurrency.js";

// concurrency order + limit — queue, never drop
{
  const active: number[] = [];
  let maxActive = 0;
  const items = [1, 2, 3, 4, 5];
  const { results } = await mapWithConcurrencyLimit(items, 2, async (n) => {
    active.push(n);
    maxActive = Math.max(maxActive, active.length);
    await new Promise((r) => setTimeout(r, 20));
    active.splice(active.indexOf(n), 1);
    return n * 10;
  });
  assert.deepEqual(results, [10, 20, 30, 40, 50]);
  assert.ok(maxActive <= 2, `maxActive=${maxActive}`);
  assert.equal(results.filter((r) => r !== undefined).length, 5);
}

// soft throw → undefined slot, siblings continue
{
  const { results } = await mapWithConcurrencyLimit([1, 2, 3], 3, async (n) => {
    if (n === 2) throw new Error("boom");
    return n;
  });
  assert.equal(results[0], 1);
  assert.equal(results[1], undefined);
  assert.equal(results[2], 3);
}

// mutex serializes
{
  const lock = createMutex();
  const order: number[] = [];
  await Promise.all([
    lock(async () => {
      order.push(1);
      await new Promise((r) => setTimeout(r, 30));
      order.push(2);
    }),
    lock(async () => {
      order.push(3);
    }),
  ]);
  assert.deepEqual(order, [1, 2, 3]);
}

assert.equal(resolveSubagentConcurrency({}), 8);
assert.equal(resolveSubagentConcurrency({ NODE4_SUBAGENT_CONCURRENCY: "2" }), 2);
assert.equal(resolveSubagentConcurrency({ NODE4_SUBAGENT_CONCURRENCY: "99" }), 16);
assert.equal(MAX_SUBAGENT_BATCH, 32);

// Spec #302 task budget
assert.equal(resolveSubagentTaskBudget({}), DEFAULT_SUBAGENT_TASK_BUDGET);
assert.equal(resolveSubagentTaskBudget({ NODE4_SUBAGENT_TASK_BUDGET: "3" }), 3);
assert.equal(resolveSubagentTaskBudget({ NODE4_SUBAGENT_TASK_BUDGET: "9999" }), MAX_SUBAGENT_TASK_BUDGET);
assert.equal(resolveSubagentTaskBudget({ NODE4_SUBAGENT_TASK_BUDGET: "0" }), 1);
assert.equal(resolveSubagentTaskBudget({ NODE4_SUBAGENT_TASK_BUDGET: "nope" }), DEFAULT_SUBAGENT_TASK_BUDGET);

{
  const prev = process.env.NODE4_SUBAGENT_TASK_BUDGET;
  process.env.NODE4_SUBAGENT_TASK_BUDGET = "3";
  try {
    const life: { subagentPackagesAdmitted?: number } = {};
    assert.equal(tryAdmitSubagentPackage(life).ok, true);
    assert.equal(tryAdmitSubagentPackage(life).ok, true);
    assert.equal(tryAdmitSubagentPackage(life).ok, true);
    const fourth = tryAdmitSubagentPackage(life);
    assert.equal(fourth.ok, false);
    if (!fourth.ok) {
      assert.match(fourth.error, /task budget exhausted/);
      assert.equal(fourth.used, 3);
      assert.equal(fourth.budget, 3);
    }
    assert.equal(life.subagentPackagesAdmitted, 3);
  } finally {
    if (prev === undefined) delete process.env.NODE4_SUBAGENT_TASK_BUDGET;
    else process.env.NODE4_SUBAGENT_TASK_BUDGET = prev;
  }
}

console.log("concurrency.test.ts: ok");
