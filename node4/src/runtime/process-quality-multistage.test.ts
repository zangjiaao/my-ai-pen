/**
 * Spec #116 multi-stage honesty + attempt-budget share.
 * Must fail if honesty scans foreign-stage terminals or attempt counts reset on new child.
 * Run: npx tsx src/runtime/process-quality-multistage.test.ts
 */
import assert from "node:assert/strict";
import {
  evaluateHonestPartial,
  filterPackageTerminalsForStage,
  recordPackageTerminal,
  resetPackageAttemptsForStageRetry,
  shouldDisposeCaptainSessionOnInterrupt,
  graphCoverageSourceOfTruth,
  MAX_PACKAGE_ATTEMPTS,
} from "./package-settlement-law.js";
import { checkPackageAttemptBudget } from "../tools/subagent.js";
import type { ToolRuntime } from "../types.js";
import { FindingStore } from "./finding-store.js";

// --- Cross-stage residual must NOT fail later stage honesty ---
const sharedTerminals: NonNullable<ToolRuntime["lifecycle"]["packageTerminals"]> = {
  "todo-xss": { terminal: "failed", salvaged: false, stage_id: "class_probe" },
  "todo-authz": { terminal: "success", salvaged: false, stage_id: "authz_logic" },
};

// Stage authz_logic only sees its own package (production filterPackageTerminalsForStage)
const stage2Pkgs = filterPackageTerminalsForStage(sharedTerminals, "authz_logic");
assert.equal(stage2Pkgs.length, 1);
assert.equal(stage2Pkgs[0]!.package_key, "todo-authz");

const honesty2 = evaluateHonestPartial({
  packages: stage2Pkgs,
  declared_failed_keys: [],
  claims_full_success: true,
});
assert.equal(honesty2.undeclared_failures.length, 0, "prior-stage failed xss must not pollute authz honesty");

// If we wrongly scanned ALL terminals (bug), xss would undeclared-fail
const allPkgs = Object.entries(sharedTerminals).map(([package_key, v]) => ({
  package_key,
  terminal: v.terminal,
  salvaged: v.salvaged,
  has_valid_result: v.terminal === "success" && !v.salvaged,
}));
const buggy = evaluateHonestPartial({
  packages: allPkgs,
  declared_failed_keys: [],
  claims_full_success: true,
});
assert.ok(
  buggy.undeclared_failures.includes("todo-xss"),
  "sanity: unscoped scan would flag prior fail",
);

// --- packageAttemptCounts shared across "stage children" ---
const parentLifecycle: ToolRuntime["lifecycle"] = {
  packageAttemptCounts: {},
  packageTerminals: {},
  findingStore: new FindingStore(),
};

// Simulate stage-1 child writing attempts on shared map
const child1 = {
  lifecycle: {
    packageAttemptCounts: parentLifecycle.packageAttemptCounts,
    packageTerminals: parentLifecycle.packageTerminals,
  },
} as ToolRuntime;

// Exhaust budget for todo-sqli
parentLifecycle.packageAttemptCounts!["todo-sqli"] = MAX_PACKAGE_ATTEMPTS;

// Stage-2 / retry child MUST share same object
const child2 = {
  lifecycle: {
    packageAttemptCounts: parentLifecycle.packageAttemptCounts, // shared
    packageTerminals: parentLifecycle.packageTerminals,
  },
} as ToolRuntime;

const rejected = checkPackageAttemptBudget(child2, "todo-sqli");
assert.equal(rejected.ok, false, "shared counts must reject after MAX attempts on new child");

// Bug pattern: new empty counts on child resets budget
const brokenChild = {
  lifecycle: {
    packageAttemptCounts: {}, // NOT shared — would incorrectly allow retry
  },
} as ToolRuntime;
assert.equal(
  checkPackageAttemptBudget(brokenChild, "todo-sqli").ok,
  true,
  "sanity: non-shared empty map would wrongly allow attempt",
);

// Parent increments visible to later child
parentLifecycle.packageAttemptCounts!["todo-lfi"] = 1;
const child3 = {
  lifecycle: { packageAttemptCounts: parentLifecycle.packageAttemptCounts },
} as ToolRuntime;
assert.equal(checkPackageAttemptBudget(child3, "todo-lfi").ok, true); // 1 used, may retry once more
parentLifecycle.packageAttemptCounts!["todo-lfi"] = 2;
assert.equal(checkPackageAttemptBudget(child3, "todo-lfi").ok, false);

// buildChildRuntime-style: same object identity
const sharedCounts = parentLifecycle.packageAttemptCounts!;
const childA = { lifecycle: { packageAttemptCounts: sharedCounts } } as ToolRuntime;
const childB = { lifecycle: { packageAttemptCounts: sharedCounts } } as ToolRuntime;
assert.equal(childA.lifecycle.packageAttemptCounts, childB.lifecycle.packageAttemptCounts);

// --- Package identity: multi-alias write must be ONE honesty package ---
// Production-shaped: plan_node_id + this_turn_goal + subagentId (old bug wrote all three into honesty map)
const honestyMap: Record<string, import("./package-settlement-law.js").PackageTerminalEntry> = {};
const aliasIdx: Record<string, string> = {};
recordPackageTerminal(honestyMap, aliasIdx, {
  primary_key: "todo-sqli",
  aliases: ["Probe SQLi on login", "sub_1784953034473_1", "todo-sqli"],
  terminal: "failed",
  salvaged: false,
  stage_id: "class_probe",
});
assert.equal(Object.keys(honestyMap).length, 1, "only primary key in honesty map");
assert.equal(honestyMap["todo-sqli"]?.terminal, "failed");
assert.equal(aliasIdx["Probe SQLi on login"], "todo-sqli");
assert.equal(aliasIdx["sub_1784953034473_1"], "todo-sqli");

const stagePkgs = filterPackageTerminalsForStage(honestyMap, "class_probe");
assert.equal(stagePkgs.length, 1, "one package for honesty");

// Declare only plan_node_id → must be honest (aliases must not appear as undeclared)
const okHonesty = evaluateHonestPartial({
  packages: stagePkgs,
  declared_failed_keys: ["todo-sqli"],
  claims_full_success: false,
});
assert.equal(okHonesty.ok, true);
assert.equal(okHonesty.undeclared_failures.length, 0);

// Legacy multi-key map (pre-fix) must collapse: only primary with plan_node_id===key counts
const legacyMulti: Record<string, import("./package-settlement-law.js").PackageTerminalEntry> = {
  "todo-sqli": {
    terminal: "failed",
    salvaged: false,
    stage_id: "class_probe",
    plan_node_id: "todo-sqli",
  },
  "Probe SQLi on login": {
    terminal: "failed",
    salvaged: false,
    stage_id: "class_probe",
    plan_node_id: "todo-sqli", // alias row pointing at primary
  },
  sub_xyz: {
    terminal: "failed",
    salvaged: false,
    stage_id: "class_probe",
    plan_node_id: "todo-sqli",
  },
};
const collapsed = filterPackageTerminalsForStage(legacyMulti, "class_probe");
assert.equal(collapsed.length, 1, "legacy multi-key map collapses to one primary");
const collapsedHonesty = evaluateHonestPartial({
  packages: collapsed,
  declared_failed_keys: ["todo-sqli"],
});
assert.equal(collapsedHonesty.undeclared_failures.length, 0);

// Omitting plan_node_id declaration still fails
const omitPrimary = evaluateHonestPartial({
  packages: stagePkgs,
  declared_failed_keys: ["Probe SQLi on login"], // alias name only — package_key is primary
});
assert.ok(omitPrimary.undeclared_failures.includes("todo-sqli"));

// --- I0.6 stage retry reset (independent of stage max_retries) ---
const stageCounts: Record<string, number> = { "todo-xss": 2, "todo-ok": 1 };
const stageTerms: Record<string, import("./package-settlement-law.js").PackageTerminalEntry> = {
  "todo-xss": {
    terminal: "failed",
    stage_id: "class_probe",
    plan_node_id: "todo-xss",
  },
  "todo-ok": {
    terminal: "success",
    salvaged: false,
    stage_id: "class_probe",
    plan_node_id: "todo-ok",
  },
};
const r = resetPackageAttemptsForStageRetry(stageCounts, stageTerms, "class_probe");
assert.ok(r.reset_keys.includes("todo-xss"), "I0.6 failed package resets");
assert.ok(r.protected_success_keys.includes("todo-ok"), "I0.6 success kept");
assert.equal(stageCounts["todo-ok"], MAX_PACKAGE_ATTEMPTS);
assert.equal(stageCounts["todo-xss"], undefined);
// After reset, budget allows failed package again
assert.equal(
  checkPackageAttemptBudget(
    { lifecycle: { packageAttemptCounts: stageCounts } } as ToolRuntime,
    "todo-xss",
  ).ok,
  true,
  "I0.6 may retry failed package after stage retry",
);
assert.equal(
  checkPackageAttemptBudget(
    { lifecycle: { packageAttemptCounts: stageCounts } } as ToolRuntime,
    "todo-ok",
  ).ok,
  false,
  "I0.6 successful package not re-dispatched by budget",
);

// --- I0.9 / I0.21 law helpers ---
assert.equal(shouldDisposeCaptainSessionOnInterrupt(), false, "I0.9");
assert.equal(graphCoverageSourceOfTruth(true), "graph_store", "I0.21");

console.log("process-quality-multistage.test.ts: ok");
