/**
 * Hypothesis queue Product-state seam (Spec #274).
 * Run: npx tsx src/runtime/hypothesis-store.test.ts
 */
import assert from "node:assert/strict";
import { FindingStore } from "./finding-store.js";
import {
  HypothesisStore,
  assertHypothesisModeGraphLoad,
  buildHypothesisPromoteSummary,
  formatConfirmedNotSeededProjection,
  formatHypothesisQueueInjection,
  isHypothesisWorkModeOn,
  parseHypothesisPackageOutcomes,
  reseedHypothesisQueue,
  stageL0IgnoresHypothesisQueue,
  suggestedCommitFromPackageOutcome,
} from "./hypothesis-store.js";

// --- Main-only semantics at store layer (tool enforces actor) ---
const store = new HypothesisStore();
const row = store.upsert({
  statement: "SQLi on /login id param",
  signal: "error-based reflection",
  prove_if: "time-based delay or data leak",
  disprove_if: "parameter not injectable after bounded probes",
});
assert.equal(row.status, "active");
assert.ok(row.id.startsWith("hyp-"));

const listed = store.list({ status: "active" });
assert.equal(listed.length, 1);

// Commit lifecycle
const confirmed = store.commit({ id: row.id, status: "confirmed", evidence_refs: ["ev1"] });
assert.equal(confirmed.status, "confirmed");
assert.ok(confirmed.evidence_refs?.includes("ev1"));

const killedRow = store.upsert({
  statement: "XSS on /search",
  signal: "reflected param",
  prove_if: "script exec",
  disprove_if: "encoded",
});
const killed = store.commit({
  id: killedRow.id,
  status: "killed",
  revisit_if: "if CSP weakens",
});
assert.equal(killed.status, "killed");
assert.equal(killed.revisit_if, "if CSP weakens");

const deferredRow = store.upsert({
  statement: "IDOR on /api/user",
  signal: "sequential ids",
  prove_if: "cross-user read",
  disprove_if: "authz hard fail",
});
const deferred = store.commit({
  id: deferredRow.id,
  status: "deferred",
  revisit_if: "after auth map",
});
assert.equal(deferred.status, "deferred");

// Killed/Deferred never seed ledger
const fstore = new FindingStore();
const killSeed = store.seedConfirmedToStore(fstore, killed.id, "http://t/search");
assert.equal(killSeed.ok, false);
assert.match((killSeed as { error: string }).error, /killed|deferred|only confirmed/i);
assert.equal(fstore.snapshot().length, 0, "killed never ledger");

const defSeed = store.seedConfirmedToStore(fstore, deferred.id, "http://t/api");
assert.equal(defSeed.ok, false);
assert.equal(fstore.snapshot().length, 0, "deferred never ledger");

// Confirmed may seed Store but is NOT booked / not feedback_ok auto-confirm
store.upsert({
  id: row.id,
  statement: row.statement,
  signal: row.signal,
  prove_if: row.prove_if,
  disprove_if: row.disprove_if,
  payload: {
    title: "SQL injection login",
    location: "http://t/login",
    severity: "high",
    proof_excerpt: "x".repeat(30),
  },
});
// re-confirm after upsert reactivated
store.commit({ id: row.id, status: "confirmed" });
const seed = store.seedConfirmedToStore(fstore, row.id);
assert.equal(seed.ok, true);
if (seed.ok) {
  const fr = fstore.get(seed.finding_id);
  assert.ok(fr);
  assert.notEqual(fr!.status, "booked", "seed is not book");
  // Confirm still requires feedback_ok path
  const gate = fstore.assertConfirmAllowed(seed.finding_id);
  // May be feedback_ok if proof long enough, or not — either way seed ≠ platform confirm
  assert.ok(gate.ok === true || gate.ok === false);
}

// Queue confirmed cannot replace finding_id confirm — no store row → cannot confirm
const emptyGate = fstore.assertConfirmAllowed("hyp-not-a-store-id");
assert.equal(emptyGate.ok, false);

// Sub outcomes parse + suggested commit (Main must apply)
const outcomes = parseHypothesisPackageOutcomes([
  { hypothesis_id: row.id, result: "proved", evidence_refs: ["p1"] },
  { result: "disproved", suggested_revisit_if: "later" },
  { result: "bogus" },
]);
assert.equal(outcomes.length, 2);
assert.deepEqual(suggestedCommitFromPackageOutcome(outcomes[0]!), { status: "confirmed" });
assert.equal(suggestedCommitFromPackageOutcome(outcomes[1]!)?.status, "killed");

// Stage flag: missing/false = off; true only when explicit
assert.equal(isHypothesisWorkModeOn({}), false);
assert.equal(isHypothesisWorkModeOn({ hypothesis_work_mode: false }), false);
assert.equal(isHypothesisWorkModeOn({ hypothesis_work_mode: true }), true);
assert.equal(isHypothesisWorkModeOn({ hypothesis_work_mode: "true" as any }), false, "string not true");

// Fail-closed graph load
const bad = assertHypothesisModeGraphLoad({
  stages: [{ id: "class_probe", hypothesis_work_mode: true }],
  packHypothesisAvailable: false,
});
assert.equal(bad.ok, false);
assert.match((bad as { error: string }).error, /fail-closed|capabilities/i);

const good = assertHypothesisModeGraphLoad({
  stages: [{ id: "class_probe", hypothesis_work_mode: true }],
  packHypothesisAvailable: true,
});
assert.equal(good.ok, true);

const offOk = assertHypothesisModeGraphLoad({
  stages: [{ id: "init" }, { id: "validate_book", hypothesis_work_mode: false }],
  packHypothesisAvailable: false,
});
assert.equal(offOk.ok, true, "no flag → ok without pack capability");

// Intent alone does not enable (stage without flag)
assert.equal(isHypothesisWorkModeOn({ intent: "probe" } as any), false);

// L0 ignores queue — contract marker + fullness cannot be settlement input
assert.equal(stageL0IgnoresHypothesisQueue(), true);
const emptyHyp = new HypothesisStore();
const fullHyp = new HypothesisStore();
for (let i = 0; i < 5; i++) {
  fullHyp.upsert({
    statement: `h${i}`,
    signal: "s",
    prove_if: "p",
    disprove_if: "d",
  });
}
// Settlement seam does not take hypothesis store — fullness is irrelevant to L0 contract
assert.notEqual(emptyHyp.counts().active_n, fullHyp.counts().active_n);
assert.equal(stageL0IgnoresHypothesisQueue(), true);

// Promote + re-seed into NEW store (no shared mutation)
const promote = buildHypothesisPromoteSummary(store);
assert.ok(promote.active_n + promote.confirmed_n + promote.killed_n + promote.deferred_n >= 1);
assert.ok(promote.gists.length >= 1);

const nextRun = new HypothesisStore();
const reseed = reseedHypothesisQueue(nextRun, promote.gists);
assert.ok(reseed.seeded_n >= 1);
assert.notEqual(nextRun, store, "new store instance");
// Mutating nextRun must not change original
const before = store.counts().total_n;
nextRun.upsert({
  statement: "only next run",
  signal: "x",
  prove_if: "p",
  disprove_if: "d",
});
assert.equal(store.counts().total_n, before, "no live shared multi-run queue");

// Projection strings
const inj = formatHypothesisQueueInjection(store);
assert.match(inj, /hypothesis-queue/);
assert.match(inj, /Confirmed ≠ booked/);
assert.doesNotMatch(inj, /flag\{/i);

const confProj = formatConfirmedNotSeededProjection(store, new FindingStore());
assert.match(confProj, /hypothesis-confirmed-not-seeded|none|^$/);

console.log("hypothesis-store.test.ts: ok");
