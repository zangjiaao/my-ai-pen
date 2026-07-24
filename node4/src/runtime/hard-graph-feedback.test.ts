/**
 * #73 Hard Feedback process metrics.
 * Run: npx tsx src/runtime/hard-graph-feedback.test.ts
 */
import assert from "node:assert/strict";
import {
  accumulateStageFeedback,
  coverageAttemptRate,
  deriveCoverageAttempts,
  emptyHardProcessMetrics,
  evaluateDiscoveryYield,
} from "./hard-graph-feedback.js";
import { normalizeSubagentResult } from "./subagent-result.js";

// Discovery yield soft-fail: rich surfaces + class_probe + zero cand/deadend
const y1 = evaluateDiscoveryYield({
  stageId: "class_probe",
  surfacesN: 5,
  fanoutPackagesN: 2,
  newCandidatesN: 0,
  deadendsN: 0,
});
assert.equal(y1.softFail, true);
assert.match(y1.reason || "", /discovery_yield/);

const y2 = evaluateDiscoveryYield({
  stageId: "class_probe",
  surfacesN: 5,
  fanoutPackagesN: 2,
  newCandidatesN: 1,
  deadendsN: 0,
});
assert.equal(y2.softFail, false);

const y3 = evaluateDiscoveryYield({
  stageId: "init",
  surfacesN: 10,
  fanoutPackagesN: 0,
  newCandidatesN: 0,
  deadendsN: 0,
});
assert.equal(y3.softFail, false, "init not yield-accountable");

// Coverage attempts: candidate matches one surface; other untested
const attempts = deriveCoverageAttempts({
  surfaces: [
    { location: "http://127.0.0.1:3010/rest/user/login" },
    { location: "http://127.0.0.1:3010/ftp/" },
  ],
  candidates: [{ location: "http://127.0.0.1:3010/rest/user/login" }],
  deadends: [],
});
assert.equal(attempts.length, 2);
assert.equal(attempts.find((a) => a.location.includes("login"))?.status, "attempted");
assert.equal(attempts.find((a) => a.location.includes("ftp"))?.status, "untested");
assert.ok(coverageAttemptRate(attempts) < 1, "untested pulls rate below 1");
assert.equal(coverageAttemptRate([]), 1);

// Zero attempt must not look like full success when surfaces exist
assert.ok(coverageAttemptRate(attempts) === 0.5);

// Accumulate through stages
let m = emptyHardProcessMetrics();
m = accumulateStageFeedback(m, {
  stageId: "surface",
  structureFailed: false,
  handoffSurfacesN: 4,
  structured: normalizeSubagentResult({
    ok: true,
    summary: "mapped",
    surfaces: [
      { location: "http://t/a" },
      { location: "http://t/b" },
      { location: "http://t/c" },
      { location: "http://t/d" },
    ],
    candidates: [],
  }),
});
assert.ok(m.surfaces_n >= 4);
m = accumulateStageFeedback(m, {
  stageId: "class_probe",
  structureFailed: false,
  fanoutPackagesN: 2,
  handoffSurfacesN: 4,
  structured: normalizeSubagentResult({
    ok: true,
    summary: "empty probe",
    surfaces: [],
    candidates: [],
    deadends: [],
  }),
});
assert.ok(m.discovery_yield_soft_fail_n >= 1, "rich surfaces empty probe soft-fails yield");

m = accumulateStageFeedback(m, {
  stageId: "class_probe",
  structureFailed: false,
  fanoutPackagesN: 1,
  handoffSurfacesN: 4,
  structured: normalizeSubagentResult({
    ok: true,
    summary: "hit",
    candidates: [
      {
        title: "x",
        location: "http://t/a",
        proof_excerpt: "enough proof text for a candidate excerpt here",
      },
    ],
  }),
});
assert.ok(m.new_candidates_n >= 1);
assert.ok(m.coverage_attempts.some((a) => a.status === "attempted"));

// Structure fail increments
m = accumulateStageFeedback(m, {
  stageId: "validate_book",
  structureFailed: true,
  structured: normalizeSubagentResult({
    ok: false,
    summary: "bad",
    candidates: [],
  }),
});
assert.ok(m.structure_fail_n >= 1);
assert.ok(m.book_outcomes, "book_outcomes always present");
assert.ok(m.book_outcomes.reject_hints_n >= 1, "structure/yield contribute reject_hints");

// Real fanout N accumulates; candidates alone do not invent packages
let m2 = emptyHardProcessMetrics();
m2 = accumulateStageFeedback(m2, {
  stageId: "class_probe",
  structureFailed: false,
  fanoutPackagesN: 0,
  handoffSurfacesN: 2,
  structured: normalizeSubagentResult({
    ok: true,
    summary: "serial monologue with candidates but no packages",
    candidates: [
      {
        title: "x",
        location: "http://t/a",
        proof_excerpt: "enough proof text for a candidate excerpt here",
      },
    ],
  }),
});
assert.equal(m2.fanout_packages_n, 0, "candidates without fanoutPackagesN must not count as packages");
m2 = accumulateStageFeedback(m2, {
  stageId: "class_probe",
  structureFailed: false,
  fanoutPackagesN: 3,
  bookOutcomes: { booked_n: 2, reject_hints_n: 0 },
  structured: normalizeSubagentResult({
    ok: true,
    summary: "joined 3 workers",
    candidates: [],
  }),
});
assert.equal(m2.fanout_packages_n, 3);
assert.equal(m2.book_outcomes.booked_n, 2);

console.log("hard-graph-feedback.test.ts: ok");
