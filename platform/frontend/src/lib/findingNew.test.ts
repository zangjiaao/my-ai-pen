/**
 * Pure New-badge derivation — no vitest; run with:
 *   npx tsx src/lib/findingNew.test.ts
 * (from platform/frontend)
 */
import assert from "node:assert/strict";
import { isFalsyNewFlag, isFindingNew, isTruthyNewFlag } from "./findingNew.ts";

// ---------------------------------------------------------------------------
// Flag coercion
// ---------------------------------------------------------------------------
{
  assert.equal(isTruthyNewFlag(true), true);
  assert.equal(isTruthyNewFlag("true"), true);
  assert.equal(isTruthyNewFlag(1), true);
  assert.equal(isTruthyNewFlag("1"), true);
  assert.equal(isTruthyNewFlag(false), false);
  assert.equal(isTruthyNewFlag(undefined), false);
  assert.equal(isTruthyNewFlag(null), false);
  assert.equal(isTruthyNewFlag("yes"), false);

  assert.equal(isFalsyNewFlag(false), true);
  assert.equal(isFalsyNewFlag("false"), true);
  assert.equal(isFalsyNewFlag(0), true);
  assert.equal(isFalsyNewFlag("0"), true);
  assert.equal(isFalsyNewFlag(true), false);
  console.log("ok: truthy/falsy New flags");
}

// ---------------------------------------------------------------------------
// Explicit created / is_new
// ---------------------------------------------------------------------------
{
  assert.equal(isFindingNew({ created: true }), true, "created true → new");
  assert.equal(isFindingNew({ created: "true" }), true);
  assert.equal(isFindingNew({ created: 1 }), true);
  assert.equal(isFindingNew({ created: false }), false, "created false → not");
  assert.equal(isFindingNew({ created: "false" }), false);
  assert.equal(isFindingNew({ is_new: true }), true);
  assert.equal(isFindingNew({ is_new: false }), false);
  // created wins over rediscovery noise when present
  assert.equal(isFindingNew({ created: true, rediscovery_count: 3 }), true);
  assert.equal(isFindingNew({ created: false, first_seen_at: "2026-01-01T00:00:00Z" }), false);
  console.log("ok: explicit created / is_new");
}

// ---------------------------------------------------------------------------
// Rediscovery → not New
// ---------------------------------------------------------------------------
{
  assert.equal(isFindingNew({ rediscovery_count: 1 }), false, "rediscovery_count 1 → not");
  assert.equal(isFindingNew({ rediscovery_count: "2" }), false);
  assert.equal(isFindingNew({ multiple_discoveries: true }), false);
  // Explicit 0 without engagement context does not invent New on global lists
  assert.equal(isFindingNew({ rediscovery_count: 0 }), false);
  assert.equal(
    isFindingNew({ rediscovery_count: 0 }, { caseStartedAt: "2026-06-01T00:00:00.000Z" }),
    true,
    "rediscovery_count 0 inside engagement → new",
  );
  console.log("ok: rediscovery signals");
}

// ---------------------------------------------------------------------------
// first_seen vs case start
// ---------------------------------------------------------------------------
{
  const caseStart = "2026-06-01T10:00:00.000Z";
  assert.equal(
    isFindingNew({ first_seen_at: "2026-06-01T12:00:00.000Z" }, { caseStartedAt: caseStart }),
    true,
    "first_seen after case start → new",
  );
  assert.equal(
    isFindingNew({ first_seen_at: "2026-06-01T10:00:00.000Z" }, { caseStartedAt: caseStart }),
    true,
    "first_seen equal case start → new",
  );
  assert.equal(
    isFindingNew({ first_seen_at: "2026-05-01T00:00:00.000Z" }, { caseStartedAt: caseStart }),
    false,
    "first_seen before case start → not",
  );
  // first_seen alias
  assert.equal(
    isFindingNew({ first_seen: "2026-06-02T00:00:00.000Z" }, { caseStartedAt: caseStart }),
    true,
  );
  console.log("ok: first_seen vs case start");
}

// ---------------------------------------------------------------------------
// first_seen == discovered (first-ever)
// ---------------------------------------------------------------------------
{
  const t = "2026-04-01T08:00:00.000Z";
  assert.equal(isFindingNew({ first_seen_at: t, discovered_at: t }), true);
  assert.equal(
    isFindingNew({
      first_seen_at: "2026-04-01T08:00:00.000Z",
      discovered_at: "2026-04-02T08:00:00.000Z",
    }),
    false,
    "later rediscover time without count still not equal → not new",
  );
  console.log("ok: first_seen equals discovered");
}

// ---------------------------------------------------------------------------
// Missing signals
// ---------------------------------------------------------------------------
{
  assert.equal(isFindingNew({}), false, "empty outside engagement → not");
  assert.equal(isFindingNew({ title: "x" }), false);
  assert.equal(
    isFindingNew({ title: "x" }, { caseStartedAt: "2026-06-01T00:00:00.000Z" }),
    true,
    "empty row inside engagement → first-ever New",
  );
  console.log("ok: missing signals");
}

console.log("all findingNew tests passed");
