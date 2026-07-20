/**
 * Idle pool unit tests (no LLM).
 * Run: npx tsx src/runtime/subagent-idle-pool.test.ts
 */
import assert from "node:assert/strict";
import {
  SubagentIdlePool,
  resolveIdlePoolEnabled,
  resolveIdlePoolOptions,
  getOrCreateIdlePool,
  type IdleSubagentHandle,
} from "./subagent-idle-pool.js";

function fakeHandle(pathKey: string, lastUsedAt = Date.now()): IdleSubagentHandle {
  let disposed = false;
  return {
    pathKey,
    session: {
      prompt: async () => undefined,
      dispose: () => {
        disposed = true;
      },
    },
    workDir: `/tmp/idle-${pathKey}`,
    segmentCounter: { tools: 0 },
    packagesCompleted: 1,
    createdAt: lastUsedAt,
    lastUsedAt,
    // expose for asserts
    ...( { _disposed: () => disposed } as any ),
  };
}

// --- resolve flags ---
assert.equal(resolveIdlePoolEnabled({ NODE4_SUBAGENT_IDLE: undefined }), true);
assert.equal(resolveIdlePoolEnabled({ NODE4_SUBAGENT_IDLE: "0" }), false);
assert.equal(resolveIdlePoolEnabled({ NODE4_SUBAGENT_IDLE: "false" }), false);
assert.equal(resolveIdlePoolEnabled({ NODE4_SUBAGENT_IDLE: "1" }), true);

const opts = resolveIdlePoolOptions({
  NODE4_SUBAGENT_IDLE_MAX: "2",
  NODE4_SUBAGENT_IDLE_TTL_MS: "60000",
  NODE4_SUBAGENT_IDLE_MAX_PACKAGES: "3",
});
assert.equal(opts.maxIdle, 2);
assert.equal(opts.ttlMs, 60_000);
assert.equal(opts.maxPackages, 3);

// --- take / park ---
{
  const pool = new SubagentIdlePool({ maxIdle: 4, ttlMs: 60_000, maxPackages: 4 });
  const h = fakeHandle("http://t/sqli");
  pool.park(h);
  assert.equal(pool.size, 1);
  const got = pool.tryTake("http://t/sqli");
  assert.ok(got);
  assert.equal(got, h);
  assert.equal(pool.size, 0);
  assert.equal(pool.tryTake("http://t/sqli"), undefined);
}

// --- exclusive: second take misses ---
{
  const pool = new SubagentIdlePool({ maxIdle: 4, ttlMs: 60_000, maxPackages: 4 });
  pool.park(fakeHandle("p1"));
  const a = pool.tryTake("p1");
  const b = pool.tryTake("p1");
  assert.ok(a);
  assert.equal(b, undefined);
}

// --- TTL expiry ---
{
  const pool = new SubagentIdlePool({ maxIdle: 4, ttlMs: 1000, maxPackages: 4 });
  const t0 = 1_000_000;
  const h = fakeHandle("old", t0);
  pool.park(h, t0);
  const got = pool.tryTake("old", t0 + 5000);
  assert.equal(got, undefined, "expired idle must not return");
}

// --- max packages ---
{
  const pool = new SubagentIdlePool({ maxIdle: 4, ttlMs: 60_000, maxPackages: 2 });
  const h = fakeHandle("full");
  h.packagesCompleted = 2;
  pool.park(h);
  assert.equal(pool.size, 0, "over maxPackages must not park");
}

// --- LRU eviction ---
{
  const pool = new SubagentIdlePool({ maxIdle: 2, ttlMs: 60_000, maxPackages: 4 });
  const a = fakeHandle("a", 1000);
  const b = fakeHandle("b", 2000);
  const c = fakeHandle("c", 3000);
  pool.park(a, 1000);
  pool.park(b, 2000);
  pool.park(c, 3000);
  assert.equal(pool.size, 2);
  // Pass synthetic "now" so TTL does not treat epoch-ish lastUsedAt as expired.
  assert.equal(pool.tryTake("a", 3500), undefined, "LRU a disposed");
  const warm = pool.tryTake("b", 3500) ?? pool.tryTake("c", 3500);
  assert.ok(warm, "b or c should remain");
}

// --- disposeAll ---
{
  const pool = new SubagentIdlePool({ maxIdle: 4, ttlMs: 60_000, maxPackages: 4 });
  pool.park(fakeHandle("x"));
  pool.park(fakeHandle("y"));
  await pool.disposeAll();
  assert.equal(pool.size, 0);
}

// --- getOrCreate respects disable ---
{
  const life: { subagentIdlePool?: SubagentIdlePool } = {};
  assert.equal(getOrCreateIdlePool(life, { NODE4_SUBAGENT_IDLE: "0" }), undefined);
  const p = getOrCreateIdlePool(life, { NODE4_SUBAGENT_IDLE: "1" });
  assert.ok(p);
  assert.equal(getOrCreateIdlePool(life, { NODE4_SUBAGENT_IDLE: "1" }), p);
}

console.log("subagent-idle-pool.test.ts: ok");
