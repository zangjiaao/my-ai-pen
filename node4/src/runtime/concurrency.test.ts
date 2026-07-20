/**
 * Run: npx tsx src/runtime/concurrency.test.ts
 */
import assert from "node:assert/strict";
import {
  createMutex,
  mapWithConcurrencyLimit,
  resolveSubagentConcurrency,
  MAX_SUBAGENT_BATCH,
} from "./concurrency.js";

// concurrency order + limit
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

assert.equal(resolveSubagentConcurrency({}), 3);
assert.equal(resolveSubagentConcurrency({ NODE4_SUBAGENT_CONCURRENCY: "2" }), 2);
assert.equal(resolveSubagentConcurrency({ NODE4_SUBAGENT_CONCURRENCY: "99" }), 8);
assert.equal(MAX_SUBAGENT_BATCH, 5);

console.log("concurrency.test.ts: ok");
