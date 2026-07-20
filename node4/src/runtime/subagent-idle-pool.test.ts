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
  return {
    agentId,
    pathKey,
    session: {
      prompt: async () => undefined,
      dispose: () => undefined,
    },
    workDir: `/tmp/idle-${agentId}`,
    segmentCounter: { tools: 0 },
    packagesCompleted: 1,
    createdAt: lastUsedAt,
    lastUsedAt,
    ...extra,
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

// --- affinity: same path ok ---
assert.equal(
  checkAffinity(
    { pathKey: "http://t/sqli", packagesCompleted: 1 },
    { pathKey: "http://t/sqli" },
    { maxPackages: 4, ttlMs: 60_000 },
  ),
  null,
);
// path mismatch
assert.equal(
  checkAffinity(
    { pathKey: "http://t/sqli", packagesCompleted: 1 },
    { pathKey: "http://t/xss" },
    { maxPackages: 4, ttlMs: 60_000 },
  ),
  "path_mismatch",
);
// skill mismatch when both set
assert.equal(
  checkAffinity(
    { pathKey: "http://t/sqli", skillId: "sqli", packagesCompleted: 1 },
    { pathKey: "http://t/sqli", skillId: "xss" },
    { maxPackages: 4, ttlMs: 60_000 },
  ),
  "skill_mismatch",
);
// skill only on one side ok
assert.equal(
  checkAffinity(
    { pathKey: "http://t/sqli", skillId: "sqli", packagesCompleted: 1 },
    { pathKey: "http://t/sqli" },
    { maxPackages: 4, ttlMs: 60_000 },
  ),
  null,
);

// --- tryResume by agent_id + affinity ---
{
  const pool = new SubagentIdlePool({ maxIdle: 4, ttlMs: 60_000, maxPackages: 4 });
  const h = fakeHandle("sub_1", "http://t/sqli");
  pool.park(h);
  assert.equal(pool.size, 1);

  // auto path take disabled
  assert.equal(pool.tryTake("http://t/sqli"), undefined);
  assert.equal(pool.size, 1);

  const bad = pool.tryResume("sub_1", { pathKey: "http://t/xss" });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.reason, "path_mismatch");
  assert.equal(pool.size, 1, "failed affinity must leave worker parked");

  const good = pool.tryResume("sub_1", { pathKey: "http://t/sqli" });
  assert.equal(good.ok, true);
  if (good.ok) assert.equal(good.handle, h);
  assert.equal(pool.size, 0);

  const miss = pool.tryResume("sub_1", { pathKey: "http://t/sqli" });
  assert.equal(miss.ok, false);
  if (!miss.ok) assert.equal(miss.reason, "not_found");
}

// --- checkResume non-mutating ---
{
  const pool = new SubagentIdlePool({ maxIdle: 4, ttlMs: 60_000, maxPackages: 4 });
  pool.park(fakeHandle("w1", "http://t/a"));
  const c = pool.checkResume("w1", { pathKey: "http://t/a" });
  assert.equal(c.ok, true);
  assert.equal(pool.size, 1, "checkResume must not take");
}

// --- TTL ---
{
  const pool = new SubagentIdlePool({ maxIdle: 4, ttlMs: 1000, maxPackages: 4 });
  const t0 = 1_000_000;
  pool.park(fakeHandle("old", "p", t0), t0);
  const got = pool.tryResume("old", { pathKey: "p" }, t0 + 5000);
  assert.equal(got.ok, false);
  if (!got.ok) assert.equal(got.reason, "expired");
  assert.equal(pool.size, 0);
}

// --- max packages ---
{
  const pool = new SubagentIdlePool({ maxIdle: 4, ttlMs: 60_000, maxPackages: 2 });
  const h = fakeHandle("full", "p");
  h.packagesCompleted = 2;
  pool.park(h);
  assert.equal(pool.size, 0, "over maxPackages must not park");
}

// --- LRU by agent id ---
{
  const pool = new SubagentIdlePool({ maxIdle: 2, ttlMs: 60_000, maxPackages: 4 });
  pool.park(fakeHandle("a", "pa", 1000), 1000);
  pool.park(fakeHandle("b", "pb", 2000), 2000);
  pool.park(fakeHandle("c", "pc", 3000), 3000);
  assert.equal(pool.size, 2);
  assert.equal(pool.tryResume("a", { pathKey: "pa" }, 3500).ok, false);
  const b = pool.tryResume("b", { pathKey: "pb" }, 3500);
  const c = pool.tryResume("c", { pathKey: "pc" }, 3500);
  assert.ok(b.ok || c.ok);
}

// --- disposeAll ---
{
  const pool = new SubagentIdlePool({ maxIdle: 4, ttlMs: 60_000, maxPackages: 4 });
  pool.park(fakeHandle("x", "px"));
  pool.park(fakeHandle("y", "py"));
  await pool.disposeAll();
  assert.equal(pool.size, 0);
}

// --- getOrCreate ---
{
  const life: { subagentIdlePool?: SubagentIdlePool } = {};
  assert.equal(getOrCreateIdlePool(life, { NODE4_SUBAGENT_IDLE: "0" }), undefined);
  const p = getOrCreateIdlePool(life, { NODE4_SUBAGENT_IDLE: "1" });
  assert.ok(p);
}

console.log("subagent-idle-pool.test.ts: ok");
