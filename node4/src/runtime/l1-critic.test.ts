/**
 * Spec #139 NC-L1 — L1 Critic contract tests.
 * Run: npx tsx src/runtime/l1-critic.test.ts
 */
import assert from "node:assert/strict";
import {
  buildL1InputFromProductState,
  l1MaxStageRefine,
  mechanicalProductStateCritic,
  runL1Critic,
} from "./l1-critic.js";
import { FindingStore } from "./finding-store.js";

assert.equal(l1MaxStageRefine(), 1);

// L0 fail → L1 not authoritative pass
const skip = await runL1Critic({
  l0Passed: false,
  input: { stageId: "class_probe" },
});
assert.equal(skip.decision, "refine");
assert.match(skip.gaps.join(" "), /L0/);

// Critic error → fail-closed
const boom = await runL1Critic({
  l0Passed: true,
  input: { stageId: "surface" },
  critic: async () => {
    throw new Error("timeout");
  },
});
assert.equal(boom.decision, "refine");
assert.match(boom.gaps.join(" "), /fail-closed|timeout/i);

// Pass path
const pass = await runL1Critic({
  l0Passed: true,
  input: {
    stageId: "init",
    storeSummary: { feedback_ok_n: 0, booked_n: 0 },
    packageSummary: { fanout_n: 0 },
  },
});
assert.equal(pass.decision, "pass");

// Probe fanout empty yield → refine when opt-in
process.env.NODE4_L1_YIELD_REFINE = "1";
const refine = mechanicalProductStateCritic({
  stageId: "class_probe",
  packageSummary: { fanout_n: 5 },
  storeSummary: { feedback_ok_n: 0, booked_n: 0 },
});
assert.equal(refine.decision, "refine");
delete process.env.NODE4_L1_YIELD_REFINE;

// Under-severity judgment (opt-in; not default host keyword table)
process.env.NODE4_L1_UNDER_SEVERITY_REFINE = "1";
const under = mechanicalProductStateCritic({
  stageId: "component",
  storeSummary: {
    feedback_ok_n: 2,
    severity_counts: { medium: 2 },
    sample_titles: ["Command injection RCE", "Credential dump"],
  },
});
assert.equal(under.decision, "refine");
assert.match(under.gaps.join(" "), /under-severity/i);
delete process.env.NODE4_L1_UNDER_SEVERITY_REFINE;

const store = new FindingStore();
store.upsert({
  title: "t",
  location: "http://x/",
  severity: "high",
  proof_excerpt: "proof excerpt long enough for status open row",
});
const built = buildL1InputFromProductState({
  stageId: "surface",
  store,
  fanoutPackagesN: 0,
});
assert.ok(built.storeSummary);

console.log("l1-critic.test.ts: ok");
