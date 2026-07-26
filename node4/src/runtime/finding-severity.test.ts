/**
 * Spec #139 D1 / NC-Severity — pure severity helpers.
 * Run: npx tsx src/runtime/finding-severity.test.ts
 */
import assert from "node:assert/strict";
import {
  isValidFindingSeverity,
  parseFindingSeverity,
  resolveBookSeverity,
} from "./finding-severity.js";

assert.equal(parseFindingSeverity("critical"), "critical");
assert.equal(parseFindingSeverity("HIGH"), "high");
assert.equal(parseFindingSeverity("medium"), "medium");
assert.equal(parseFindingSeverity("low"), "low");
assert.equal(parseFindingSeverity("info"), "info");
assert.equal(parseFindingSeverity(""), null, "empty is not medium");
assert.equal(parseFindingSeverity(undefined), null);
assert.equal(parseFindingSeverity("unknown"), null);
assert.equal(parseFindingSeverity("  "), null);

assert.ok(isValidFindingSeverity("high"));
assert.equal(isValidFindingSeverity(""), false);

// Fail closed when both missing
const miss = resolveBookSeverity({});
assert.equal(miss.ok, false);
if (!miss.ok) assert.match(miss.error, /severity required|silent medium/i);

// Tool wins
const tool = resolveBookSeverity({ toolSeverity: "critical", storeSeverity: "low" });
assert.equal(tool.ok, true);
if (tool.ok) {
  assert.equal(tool.severity, "critical");
  assert.equal(tool.source, "tool");
}

// Store fill when tool omits
const storeFill = resolveBookSeverity({ storeSeverity: "high" });
assert.equal(storeFill.ok, true);
if (storeFill.ok) {
  assert.equal(storeFill.severity, "high");
  assert.equal(storeFill.source, "store");
}

// Invalid tool + valid store → store
const badTool = resolveBookSeverity({ toolSeverity: "nope", storeSeverity: "info" });
assert.equal(badTool.ok, true);
if (badTool.ok) assert.equal(badTool.severity, "info");

// Invalid both
const bothBad = resolveBookSeverity({ toolSeverity: "x", storeSeverity: "y" });
assert.equal(bothBad.ok, false);

console.log("finding-severity.test.ts: ok");
