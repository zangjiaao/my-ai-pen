/**
 * Unit tests: subagent handoff validation + nest ban (A1/D3).
 * Drive shipped pure functions — no LLM.
 */
import {
  assertSubagentNestAllowed,
  formatHandoffPackage,
  HANDOFF_FIELD_KEYS,
  validateSubagentHandoff,
} from "./subagent-handoff.js";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

// --- missing fields ---
const empty = validateSubagentHandoff({});
assert(!empty.ok, "empty handoff fails");
if (!empty.ok) {
  assert(empty.missing.length === HANDOFF_FIELD_KEYS.length, "all keys missing");
  assert(empty.error.includes("handoff incomplete"), "error mentions incomplete");
}

const partial = validateSubagentHandoff({
  target: "http://127.0.0.1:8080/",
  scope: "127.0.0.1 only",
  already_done: "none",
});
assert(!partial.ok, "partial fails");
if (!partial.ok) {
  assert(partial.missing.includes("this_turn_goal"), "missing this_turn_goal");
  assert(partial.missing.includes("success_criteria"), "missing success_criteria");
}

// --- complete handoff ---
const ok = validateSubagentHandoff({
  target: "http://app.lab/login",
  scope: "app.lab http only; no postex",
  already_done: "recon listed /login and /api/health",
  this_turn_goal: "probe login for error-based SQLi differential",
  success_criteria: "stdout showing status/length delta or SQL error fragment",
  assignment: "prefer session cookies if any",
});
assert(ok.ok, "complete handoff ok");
if (ok.ok) {
  assert(ok.handoff.target.includes("app.lab"), "target set");
  assert(ok.packageText.includes("## Target"), "package has Target section");
  assert(ok.packageText.includes("Nested delegation"), "package forbids nest");
  assert(ok.packageText.includes("prefer session"), "notes appended");
  const again = formatHandoffPackage(ok.handoff);
  assert(again.includes(ok.handoff.this_turn_goal), "formatHandoffPackage works");
}

// --- nest ban ---
assert(assertSubagentNestAllowed(0).ok, "depth 0 allowed");
assert(assertSubagentNestAllowed(undefined).ok, "undefined depth allowed");
const nest = assertSubagentNestAllowed(1);
assert(!nest.ok, "depth 1 banned");
if (!nest.ok) assert(nest.error.includes("nested subagent"), "nest error text");
assert(!assertSubagentNestAllowed(2).ok, "depth 2 banned");

console.log("subagent-handoff.test.ts: ok");
