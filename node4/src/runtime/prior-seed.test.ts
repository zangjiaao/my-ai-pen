/**
 * Spec #139 D2 / NC-Prior — prior seed + discovery avoid.
 * Run: npx tsx src/runtime/prior-seed.test.ts
 */
import assert from "node:assert/strict";
import { FindingStore } from "./finding-store.js";
import {
  checkDiscoveryAvoidCollision,
  formatPriorSnapshotInjection,
  openFindingsToPriorInputs,
  priorAvoidUnit,
  seedPriorsAtGraphStart,
} from "./prior-seed.js";

// open findings → prior inputs (fixed skipped)
const inputs = openFindingsToPriorInputs([
  { id: "v1", title: "SQLi login", location: "http://t/login", severity: "high", status: "open" },
  { id: "v2", title: "Fixed XSS", location: "http://t/x", severity: "low", status: "fixed" },
]);
assert.equal(inputs.length, 1);
assert.equal(inputs[0]!.platform_vuln_id, "v1");

const store = new FindingStore();
const seed = seedPriorsAtGraphStart(store, {
  findings_summary: [
    {
      id: "pv-1",
      title: "Command injection",
      location: "http://t/exec",
      severity: "critical",
      status: "open",
    },
  ],
});
assert.equal(seed.prior_n, 1);
assert.equal(seed.empty_prior, false);
const row = store.get(seed.ids[0]!);
assert.ok(row?.prior);
assert.equal(row?.severity, "critical");
assert.equal(row?.proof_excerpt, undefined, "historical proof stripped");
assert.equal(row?.status, "open");

// Idempotent on platform_vuln_id
const seed2 = seedPriorsAtGraphStart(store, {
  findings_summary: [
    {
      id: "pv-1",
      title: "Command injection again",
      location: "http://t/exec",
      severity: "critical",
      status: "open",
    },
  ],
});
assert.equal(store.counts().prior_n, 1, "idempotent prior import");

// Empty prior honest
const emptyStore = new FindingStore();
const empty = seedPriorsAtGraphStart(emptyStore, { findings_summary: [] });
assert.equal(empty.empty_prior, true);
assert.match(formatPriorSnapshotInjection(empty), /empty_prior: true/);
assert.match(formatPriorSnapshotInjection(seed), /prior_n: 1/);
assert.match(formatPriorSnapshotInjection(seed), /Dual use/);

// Discovery avoid hard-fail
const unit = priorAvoidUnit("http://t/exec?x=1", { title: "Command injection" });
assert.ok(unit.includes("∩"));
const hit = checkDiscoveryAvoidCollision({
  store,
  targetLocation: "http://t/exec",
  title: "Command injection",
});
assert.equal(hit.ok, false);
if (!hit.ok) assert.match(hit.error, /re-verify|pathKey/i);

// Re-verify allowed
const re = checkDiscoveryAvoidCollision({
  store,
  targetLocation: "http://t/exec",
  title: "Command injection",
  priorStoreIds: [seed.ids[0]!],
  packageKind: "re-verify",
});
assert.equal(re.ok, true);

// Other class on same path allowed
const otherClass = checkDiscoveryAvoidCollision({
  store,
  targetLocation: "http://t/exec",
  title: "Path traversal",
  class_key: "path_traversal",
});
assert.equal(otherClass.ok, true, "other class on same path is not skip-list");

console.log("prior-seed.test.ts: ok");
