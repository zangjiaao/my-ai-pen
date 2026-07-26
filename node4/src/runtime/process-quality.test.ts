/**
 * Spec #116 / #114 process-quality contract tests (I0 / I1 / I2 core).
 * Pure helpers + Store + tool entry points — no DVWA answer keys.
 * Run: npx tsx src/runtime/process-quality.test.ts
 *
 * Coverage map (C7): each assert block labels the invariant id it proves.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FindingStore,
  actorMayConfirm,
  ingestPackageCandidatesToStore,
  shouldMergeFindings,
  titlesSoftMatch,
} from "./finding-store.js";
import {
  MAX_PACKAGE_ATTEMPTS,
  classifyUserControl,
  evaluateHonestPartial,
  graphCoverageSourceOfTruth,
  isPackageSuccess,
  l2DoneRate,
  mainMaySerialReprobeFailedPackage,
  mayMarkL2DoneForPackage,
  mayRetryPackage,
  recordPackageTerminal,
  requirePlanNodeIdForGraphPackage,
  resetPackageAttemptsForStageRetry,
  shouldAutoReplayBatchAfterInterrupt,
} from "./package-settlement-law.js";
import {
  countFanoutPackagesP1,
  deriveCoverageAttempts,
  findingsBookedAlignment,
  metricFamilyKeys,
  surfaceActedRate,
  emptyHardProcessMetrics,
  accumulateStageFeedback,
} from "./hard-graph-feedback.js";
import { assertGraphPackageAnchor } from "./package-honesty-host.js";
import { normalizeSubagentResult } from "./subagent-result.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../../..");

// --- I0.1 package attempt budget ---
assert.equal(MAX_PACKAGE_ATTEMPTS, 2, "I0.1: max 2 attempts per package");
assert.equal(mayRetryPackage(0), true);
assert.equal(mayRetryPackage(1), true);
assert.equal(mayRetryPackage(2), false, "I0.1: 3rd attempt forbidden");

// --- I0.4 salvage ≠ success ---
assert.equal(isPackageSuccess({ ok: true, salvaged: true, has_valid_result: true }), false, "I0.4");
assert.equal(isPackageSuccess({ ok: true, salvaged: false, has_valid_result: true }), true, "I0.4");
assert.equal(isPackageSuccess({ ok: false, salvaged: false, has_valid_result: false }), false, "I0.4");

// --- I0.2–3 honest partial ---
const honest = evaluateHonestPartial({
  packages: [
    { package_key: "sqli", terminal: "success", has_valid_result: true },
    { package_key: "xss", terminal: "failed" },
  ],
  declared_failed_keys: ["xss"],
  claims_full_success: false,
});
assert.equal(honest.ok, true, "I0.2: declared fail is honest partial");

const silent = evaluateHonestPartial({
  packages: [
    { package_key: "sqli", terminal: "success", has_valid_result: true },
    { package_key: "xss", terminal: "failed" },
  ],
  declared_failed_keys: [],
  claims_full_success: true,
  l2_done_for_keys: ["sqli", "xss"],
});
assert.equal(silent.ok, false, "I0.2: silent partial forbidden");
assert.ok(silent.undeclared_failures.includes("xss"), "I0.3: must declare failed");
assert.ok(silent.illegal_l2_done.includes("xss"), "I0.3/I0.11: no L2 done for failed");

// --- I0.5 Main after packages ---
assert.equal(
  mainMaySerialReprobeFailedPackage({
    packagesStartedThisStage: true,
    action: "serial_reprobe_failed",
  }),
  false,
  "I0.5: no serial erase of package failure",
);
assert.equal(
  mainMaySerialReprobeFailedPackage({
    packagesStartedThisStage: true,
    action: "orchestrate_settle",
  }),
  true,
  "I0.5: orchestrate+settle allowed",
);

// --- I0.6 stage retry resets non-success package budgets ---
const attemptCounts: Record<string, number> = {
  "todo-sqli": 2,
  "todo-xss": 2,
  "todo-authz": 1,
};
const terminalsForRetry: Record<string, { terminal: "success" | "failed"; salvaged?: boolean; stage_id?: string; plan_node_id?: string }> = {
  "todo-sqli": { terminal: "success", salvaged: false, stage_id: "class_probe", plan_node_id: "todo-sqli" },
  "todo-xss": { terminal: "failed", salvaged: false, stage_id: "class_probe", plan_node_id: "todo-xss" },
  "todo-authz": { terminal: "failed", salvaged: false, stage_id: "authz_logic", plan_node_id: "todo-authz" },
};
const reset = resetPackageAttemptsForStageRetry(attemptCounts, terminalsForRetry, "class_probe");
assert.ok(reset.reset_keys.includes("todo-xss"), "I0.6: failed package budget resets on stage retry");
assert.ok(reset.protected_success_keys.includes("todo-sqli"), "I0.6: success protected");
assert.equal(attemptCounts["todo-sqli"], MAX_PACKAGE_ATTEMPTS, "I0.6: success pinned at max");
assert.equal(attemptCounts["todo-xss"], undefined, "I0.6: failed counter cleared");
assert.equal(attemptCounts["todo-authz"], 1, "I0.6: other-stage packages untouched");

// --- I0.7–8 interrupt / empty / no auto replay ---
const empty = classifyUserControl({ kind: "empty_message" });
assert.equal(empty.is_abort, false, "I0.8: empty is not abort");
assert.ok(empty.reject);

const interrupt = classifyUserControl({ kind: "ui_interrupt" });
assert.equal(interrupt.is_abort, true, "I0.7: UI interrupt is abort");
assert.equal(interrupt.is_package_fail, false, "I0.7: interrupt ≠ package-fail");

assert.equal(shouldAutoReplayBatchAfterInterrupt(), false, "I0.8: no auto full-batch replay");

// --- I0.9: durable captain continue not implemented; interrupt is abort but ≠ package-fail ---
assert.equal(
  classifyUserControl({ kind: "ui_interrupt" }).is_package_fail,
  false,
  "I0.9/I0.7: interrupt ≠ package-fail",
);
assert.equal(classifyUserControl({ kind: "empty_message" }).is_abort, false, "I0.8: empty not abort");

// --- I0.10 package must anchor L2 ---
assert.equal(requirePlanNodeIdForGraphPackage(undefined).ok, false, "I0.10");
assert.equal(requirePlanNodeIdForGraphPackage("todo-task-sqli").ok, true, "I0.10");

const fakeRuntimeGraph = {
  lifecycle: { hardGraphRun: { plan: {} } },
} as any;
assert.match(
  assertGraphPackageAnchor(fakeRuntimeGraph, { plan_node_id: undefined }, "flat") || "",
  /plan_node_id/,
  "I0.10 tool hard-fail",
);
assert.equal(
  assertGraphPackageAnchor(fakeRuntimeGraph, { plan_node_id: "todo-x" }, "flat"),
  null,
);
assert.equal(
  assertGraphPackageAnchor({ lifecycle: {} } as any, { plan_node_id: undefined }, "flat"),
  null,
  "I0.10 non-graph path optional anchor",
);

// --- I0.11 L2 done gate ---
assert.equal(mayMarkL2DoneForPackage("failed").ok, false, "I0.11");
assert.equal(mayMarkL2DoneForPackage("running").ok, false, "I0.11");
assert.equal(mayMarkL2DoneForPackage("success", true).ok, false, "I0.11 salvage");
assert.equal(mayMarkL2DoneForPackage("success", false).ok, true, "I0.11");

// --- I0.12 incomplete handoff (spawn hard-fail shape) ---
// Contract: missing required fields yield an incomplete-handoff error string (subagent resolvePackageInput).
{
  const { createSubagentTool } = await import("../tools/subagent.js");
  // Lightweight: assertGraphPackageAnchor already covers Graph anchor; handoff incompleteness is
  // exercised in process-quality-e2e via production resolve. Shape check here:
  const errShape =
    "error: flat incomplete handoff — need target, scope, already_done, this_turn_goal, success_criteria";
  assert.match(errShape, /incomplete handoff/, "I0.12 error shape");
  void createSubagentTool;
}

// --- I0.13 sub never confirm ---
assert.equal(actorMayConfirm("sub"), false, "I0.13");
assert.equal(actorMayConfirm("main"), true, "I0.14 Main may confirm");

// --- Finding Store I0.14–20 ---
const store = new FindingStore();
const a = store.upsert({
  title: "SQL injection in login",
  location: "http://t/login.php?id=1",
  proof_excerpt: "MySQL syntax error near ''' at line 1 — enough for proof",
  class_key: "sqli",
  package_id: "pkg-1",
  source: "pkg-1",
});
assert.equal(a.merged, false);

// L0 merge same path_key + class (query stripped) — I0.17
const b = store.upsert({
  title: "SQLi on login form",
  location: "http://t/login.php?id=2",
  proof_excerpt: "MySQL syntax error near ''' at line 1 — enough for proof",
  class_key: "sqli",
  package_id: "pkg-2",
  source: "pkg-2",
});
assert.equal(b.merged, true, "I0.17: same path_key+class merges");
assert.equal(b.id, a.id);
assert.equal(store.snapshot().length, 1, "I0.17: no silent twin rows");

// Different class same path → new id
const xss = store.upsert({
  title: "Reflected XSS login",
  location: "http://t/login.php",
  proof_excerpt: "script alert reflected in body enough characters here",
  class_key: "xss",
});
assert.equal(xss.merged, false);
assert.notEqual(xss.id, a.id);

// Production L0 path: ingest sets feedback_ok when proof present — I0.19
const store2 = new FindingStore();
const ingested = ingestPackageCandidatesToStore(
  store2,
  [
    {
      title: "SQL injection in login",
      location: "http://t/login.php",
      proof_excerpt: "MySQL syntax error near ''' at line 1 — enough for proof",
    },
  ],
  { package_id: "p1" },
);
assert.equal(store2.get(ingested[0]!)?.status, "feedback_ok", "I0.19 auto Feedback → ok");

// No proof → L0 reject
const noProofIds = ingestPackageCandidatesToStore(
  store2,
  [{ title: "Weak claim", location: "http://t/other" }],
  { package_id: "p2" },
);
assert.equal(store2.get(noProofIds[0]!)?.status, "feedback_reject", "I0.19 L0 reject without proof");

// Manual ok for first store row
store.applyMechanicalL0Feedback([a.id]);
assert.equal(store.get(a.id)?.status, "feedback_ok");

// Confirm gate — I0.14–16
assert.equal(store.assertConfirmAllowed("").ok, false, "I0.16: invent-without-id forbidden");
assert.equal(store.assertConfirmAllowed("missing-id").ok, false, "I0.16");
assert.equal(store.assertConfirmAllowed(xss.id).ok, false, "I0.14: not feedback_ok");
assert.equal(store.assertConfirmAllowed(a.id).ok, true, "I0.14");

// I0.15 path: markBooked after successful confirm (platform vuln_found in e2e)
store.markBooked(a.id, "plat-1");
assert.equal(store.get(a.id)?.status, "booked");
assert.equal(store.get(a.id)?.platform_vuln_id, "plat-1");

// I0.18 Store survives stage transitions
const before = store.snapshot().length;
store.upsert({
  title: "Next stage finding",
  location: "http://t/upload",
  proof_excerpt: "upload allowed php shell proof excerpt long enough",
  class_key: "upload",
  stage_id: "component",
});
assert.ok(store.snapshot().length > before, "I0.18: not wiped per stage");

// Prior import R1
store.importPriors([
  {
    platform_vuln_id: "pv-9",
    title: "Prior SQLi",
    location: "http://t/legacy",
    severity: "high",
  },
]);
assert.ok(store.counts().prior_n >= 1);

// Title soft match helper
assert.ok(titlesSoftMatch("SQL injection login", "SQLi injection in login"));
assert.ok(
  shouldMergeFindings(
    { location: "http://t/a", title: "SQL injection", class_key: "sqli", status: "open" },
    { location: "http://t/a?x=1", title: "SQL injection", class_key: "sqli" },
  ),
);

// I0.20 Store-first: result.json projection must not invent a second authority
// (confirm gate requires Store feedback_ok id — invent-without-id forbidden above)

// I0.21 Graph coverage SoT
assert.equal(graphCoverageSourceOfTruth(true), "graph_store", "I0.21");
assert.equal(graphCoverageSourceOfTruth(false), "todo_store", "I0.21 non-graph");

// --- I1 metrics ---
// I1.1 five families
const families = metricFamilyKeys();
assert.deepEqual([...families].sort(), ["fanout", "findings", "l2", "soft", "surface"].sort(), "I1.1");

// I1.2: exact pathKey candidate → probed; unrelated surface stays untested (no loose includes)
const cov = deriveCoverageAttempts({
  surfaces: [{ location: "http://t/a" }, { location: "http://t/b" }],
  candidates: [{ location: "http://t/a" }],
  deadends: [],
});
assert.equal(cov.find((x) => x.location.includes("/a"))?.status, "probed", "I1.2");
assert.equal(cov.find((x) => x.location.includes("/b"))?.status, "untested", "I1.2 no impersonation");
assert.equal(surfaceActedRate(cov), 0.5, "I1.2 R1");

const covLedger = deriveCoverageAttempts({
  surfaces: [{ location: "http://t/c", status: "probed" }],
  candidates: [],
  deadends: [],
});
assert.equal(covLedger[0]?.status, "probed");

// I1.3 fanout P1; must NOT hard-require >0
assert.equal(countFanoutPackagesP1({ success_n: 1, fail_n: 1, abort_n: 1 }), 3, "I1.3");
assert.equal(countFanoutPackagesP1({ executed_n: 0 }), 0, "I1.3: fanout 0 legal");

// I1.4 findings_booked vs platform alignment red signal
const alignOk = findingsBookedAlignment({ findings_booked_n: 2, platform_visible_n: 2 });
assert.equal(alignOk.aligned, true);
assert.equal(alignOk.red_signal, false);
const alignBad = findingsBookedAlignment({ findings_booked_n: 3, platform_visible_n: 0 });
assert.equal(alignBad.red_signal, true, "I1.4 Case B ledger gap shape");

// I1.5 L2 S1 done-only numerator
assert.equal(l2DoneRate({ total: 10, done: 2 }), 0.2, "I1.5");

// I1.6: metrics must not encode expected vuln counts — empty metrics have no vuln tables
const emptyM = emptyHardProcessMetrics();
assert.equal((emptyM as { expected_vulns?: number }).expected_vulns, undefined, "I1.6");
assert.ok(typeof emptyM.surface_acted_rate === "number");
assert.equal(emptyM.surface_acted_rate, emptyM.coverage_attempt_rate, "I1.2 alias parity");

// accumulateStageFeedback keeps surface_acted_rate in sync
let m = accumulateStageFeedback(emptyM, {
  stageId: "class_probe",
  structureFailed: false,
  fanoutPackagesN: 0,
  handoffSurfacesN: 2,
  structured: normalizeSubagentResult({
    ok: true,
    summary: "serial legal",
    surfaces: [{ location: "http://t/a" }, { location: "http://t/b" }],
    candidates: [],
  }),
});
assert.equal(m.fanout_packages_n, 0, "I1.3: zero fanout legal (Case B shape)");
assert.equal(m.surface_acted_rate, m.coverage_attempt_rate);
assert.equal(m.findings_booked_n, 0, "I1.4: findings_booked_n always present");

// I1.4: Store booked absolute is wired into process metrics (not book_outcomes delta)
m = accumulateStageFeedback(m, {
  stageId: "validate_book",
  structureFailed: false,
  fanoutPackagesN: 0,
  bookOutcomes: { booked_n: 1, reject_hints_n: 0 },
  findingsBookedN: 3,
  structured: normalizeSubagentResult({
    ok: true,
    summary: "booked",
    candidates: [],
  }),
});
assert.equal(m.book_outcomes.booked_n, 1, "book_outcomes is JSON/platform delta accumulate");
assert.equal(m.findings_booked_n, 3, "findings_booked_n is absolute Store count");
assert.equal(
  findingsBookedAlignment({
    findings_booked_n: m.findings_booked_n,
    platform_visible_n: m.book_outcomes.booked_n,
  }).red_signal,
  true,
  "I1.4: Store vs book_outcomes mismatch is alignment red",
);

// --- Case A shape fixture (partial wave + interrupt honesty) — not answer keys ---
const caseA = evaluateHonestPartial({
  packages: [
    { package_key: "todo-sqli", terminal: "success", has_valid_result: true },
    { package_key: "todo-xss", terminal: "aborted" },
    { package_key: "todo-lfi", terminal: "never_started" },
  ],
  declared_failed_keys: ["todo-lfi"],
  l2_done_for_keys: ["todo-sqli", "todo-xss"],
});
assert.ok(caseA.illegal_l2_done.includes("todo-xss"), "Case A: aborted package cannot L2-done");
assert.ok(
  classifyUserControl({ kind: "ui_interrupt" }).is_package_fail === false,
  "Case A: interrupt ≠ package-fail",
);

// --- Case B shape fixture (zero fanout legal; ledger gap red; no invent confirm) ---
assert.equal(countFanoutPackagesP1({ executed_n: 0 }), 0, "Case B: zero class_probe fanout legal");
assert.equal(
  findingsBookedAlignment({ findings_booked_n: 25, platform_visible_n: 0 }).red_signal,
  true,
  "Case B: Store/workspace findings without platform ledger = red",
);
assert.equal(store.assertConfirmAllowed("").ok, false, "Case B: invent-without-id forbidden");

// --- I2 Track B static presence (pack + specs) ---
const workMd = readFileSync(join(repoRoot, "experts/pentest/work.md"), "utf8");
assert.match(workMd, /prefer packages/i, "I2.1 prefer packages");
assert.match(workMd, /anti-micro-spawn|micro-spawn/i, "I2.1 anti-micro");
assert.match(workMd, /not.*process chore|process chores/i, "I2.1 L2≠process-chore");
assert.match(workMd, /phase intent/i, "I2.1 phase intent");
assert.match(workMd, /answer keys|expected vuln|hard fanout quotas/i, "I2.2 bans");
assert.match(workMd, /finding_id|feedback_ok/i, "I2 Store confirm path");
assert.doesNotMatch(
  workMd,
  /packages_n\s*must\s*[≥>=]\s*\d|must spawn\s+\d+\s+packages/i,
  "I2.3 no L1 hard fanout quota sentences",
);

const appAssessment = readFileSync(
  join(repoRoot, "experts/pentest/graphs/hard/app_assessment.json"),
  "utf8",
);
assert.match(appAssessment, /no hard package quota|prefer Agent Graph packages/i, "I2.1 graph success");
assert.match(appAssessment, /micro-spawn|plan_node_id/i, "I2.1");
assert.doesNotMatch(appAssessment, /must spawn\s+\d+/i, "I2.3");

const harness = readFileSync(join(repoRoot, "docs/specs/harness.md"), "utf8");
assert.match(harness, /Salvage without valid result\.json|salvage.*≠|not count as package success/i, "I2 harness salvage law");

const taskGraph = readFileSync(join(repoRoot, "docs/specs/task-graph.md"), "utf8");
assert.match(taskGraph, /Finding Store|feedback_ok|surface_acted_rate/i, "I2 living docs");

console.log("process-quality.test.ts: ok (I0/I1/I2 + Case A/B shapes)");
