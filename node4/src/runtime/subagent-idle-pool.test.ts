/**
 * Worker registry unit tests (no LLM).
 * Run: npx tsx src/runtime/subagent-idle-pool.test.ts
 */
import assert from "node:assert/strict";
import {
  SubagentIdlePool,
  resolveIdlePoolEnabled,
  resolveIdlePoolOptions,
  getOrCreateIdlePool,
  checkAffinity,
  type IdleSubagentHandle,
} from "./subagent-idle-pool.js";

function fakeHandle(
  agentId: string,
  pathKey: string,
  lastUsedAt = Date.now(),
  extra?: Partial<IdleSubagentHandle>,
): IdleSubagentHandle {
  let disposed = false;
  return {
    agentId,
    pathKey,
    session: {
      prompt: async () => undefined,
      dispose: () => {
        disposed = true;
      },
    },
    workDir: `/tmp/idle-${agentId}`,
    segmentCounter: { tools: 0 },
    packagesCompleted: 1,
    createdAt: lastUsedAt,
    lastUsedAt,
    ...extra,
    // test helper
    ...( { isDisposed: () => disposed } as any ),
  };
}

// --- resolve flags ---
assert.equal(resolveIdlePoolEnabled({ NODE4_SUBAGENT_IDLE: undefined }), true);
assert.equal(resolveIdlePoolEnabled({ NODE4_SUBAGENT_IDLE: "0" }), false);

const opts = resolveIdlePoolOptions({
  NODE4_SUBAGENT_IDLE_MAX: "2",
  NODE4_SUBAGENT_IDLE_TTL_MS: "60000",
  NODE4_SUBAGENT_IDLE_MAX_PACKAGES: "3",
});
assert.equal(opts.maxIdle, 2);
assert.equal(opts.ttlMs, 60_000);
assert.equal(opts.maxPackages, 3);

// default TTL is OMP 420s
assert.equal(resolveIdlePoolOptions({}).ttlMs, 420_000);

// --- affinity ---
assert.equal(
  checkAffinity(
    { pathKey: "http://t/sqli", packagesCompleted: 1 },
    { pathKey: "http://t/sqli" },
    { maxPackages: 4, ttlMs: 60_000 },
  ),
  null,
);
assert.equal(
  checkAffinity(
    { pathKey: "http://t/sqli", packagesCompleted: 1 },
    { pathKey: "http://t/xss" },
    { maxPackages: 4, ttlMs: 60_000 },
  ),
  "path_mismatch",
);

// --- tryResume + exclusive ---
{
  const pool = new SubagentIdlePool({ maxIdle: 4, ttlMs: 60_000, maxPackages: 4 });
  const h = fakeHandle("sub_1", "http://t/sqli");
  pool.park(h);
  assert.equal(pool.size, 1);
  assert.equal(pool.tryTake("http://t/sqli"), undefined);

  const bad = pool.tryResume("sub_1", { pathKey: "http://t/xss" });
  assert.equal(bad.ok, false);
  assert.equal(pool.size, 1);

  const good = pool.tryResume("sub_1", { pathKey: "http://t/sqli" });
  assert.equal(good.ok, true);
  assert.equal(pool.size, 0);
  // timer cleared on take
  assert.equal(h.idleTimer, undefined);
}

// --- explicit release ---
{
  const pool = new SubagentIdlePool({ maxIdle: 4, ttlMs: 60_000, maxPackages: 4 });
  const h = fakeHandle("w1", "http://t/a");
  pool.park(h);
  assert.equal(await pool.release("w1"), true);
  assert.equal(pool.size, 0);
  assert.equal((h as any).isDisposed(), true);
  assert.equal(await pool.release("w1"), false);
}

// --- active TTL timer releases ---
{
  const pool = new SubagentIdlePool({ maxIdle: 4, ttlMs: 30, maxPackages: 4 });
  const h = fakeHandle("ttl", "http://t/ttl");
  pool.park(h);
  assert.equal(pool.size, 1);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(pool.size, 0, "TTL timer must hard-release");
  assert.equal((h as any).isDisposed(), true);
  const miss = pool.tryResume("ttl", { pathKey: "http://t/ttl" });
  assert.equal(miss.ok, false);
}

// --- listIdle ---
{
  const pool = new SubagentIdlePool({ maxIdle: 4, ttlMs: 60_000, maxPackages: 4 });
  pool.park(fakeHandle("a", "pa", Date.now() - 1000), Date.now() - 1000);
  pool.park(fakeHandle("b", "pb", Date.now()), Date.now());
  const list = pool.listIdle();
  assert.equal(list.length, 2);
  assert.ok(list.every((x) => x.agent_id && x.path_key));
  await pool.disposeAll();
}

// --- max packages ---
{
  const pool = new SubagentIdlePool({ maxIdle: 4, ttlMs: 60_000, maxPackages: 2 });
  const h = fakeHandle("full", "p");
  h.packagesCompleted = 2;
  pool.park(h);
  assert.equal(pool.size, 0);
}

// --- LRU release ---
{
  const pool = new SubagentIdlePool({ maxIdle: 2, ttlMs: 60_000, maxPackages: 4 });
  pool.park(fakeHandle("a", "pa", 1000), 1000);
  pool.park(fakeHandle("b", "pb", 2000), 2000);
  pool.park(fakeHandle("c", "pc", 3000), 3000);
  assert.equal(pool.size, 2);
  assert.equal(pool.tryResume("a", { pathKey: "pa" }, 3500).ok, false);
}

// --- disposeAll clears timers ---
{
  const pool = new SubagentIdlePool({ maxIdle: 4, ttlMs: 60_000, maxPackages: 4 });
  const h = fakeHandle("x", "px");
  pool.park(h);
  assert.ok(h.idleTimer);
  await pool.disposeAll();
  assert.equal(pool.size, 0);
  assert.equal(h.idleTimer, undefined);
}

// --- getOrCreate ---
{
  const life: { subagentIdlePool?: SubagentIdlePool } = {};
  assert.equal(getOrCreateIdlePool(life, { NODE4_SUBAGENT_IDLE: "0" }), undefined);
  assert.ok(getOrCreateIdlePool(life, { NODE4_SUBAGENT_IDLE: "1" }));
}

console.log("subagent-idle-pool.test.ts: ok");
