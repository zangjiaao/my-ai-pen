/**
 * Pure focus / RoE field parsers for task_assign.
 * Run: npx tsx src/runtime/task-envelope-fields.test.ts
 */
import assert from "node:assert/strict";
import {
  parseAllowDestructive,
  parseAllowPostex,
  parseFocusFields,
  parseFocusFindingIds,
  parseFocusNote,
  parseHandoffSummary,
  parseOptionalWireBoolean,
  parseStringIdList,
} from "./task-envelope-fields.js";

assert.deepEqual(parseStringIdList(["a", " b ", ""]), ["a", "b"]);
assert.deepEqual(parseStringIdList("id1,id2"), ["id1", "id2"]);
assert.equal(parseStringIdList(null), undefined);
assert.equal(parseStringIdList(""), undefined);

assert.deepEqual(parseFocusFindingIds({ focus_finding_ids: ["f1"] }), ["f1"]);
assert.deepEqual(parseFocusFindingIds({ focusFindingIds: "id1,id2" }), ["id1", "id2"]);
// Legacy retest_* wire removed — must not invent focus from old keys
assert.equal(parseFocusFindingIds({ retest_finding_ids: ["r1"] }), undefined);
assert.equal(parseFocusFindingIds({ text: "please retest all" }), undefined);

assert.equal(parseFocusNote({ focus_note: "  cover authz  " }), "cover authz");
assert.equal(parseFocusNote({ focusNote: "n" }), "n");
assert.equal(parseFocusNote({ text: "retest please" }), undefined);

const bundled = parseFocusFields({
  focus_finding_ids: ["a", "b"],
  focus_note: " dig ",
  initial_instruction: "noise",
});
assert.deepEqual(bundled, { focusFindingIds: ["a", "b"], focusNote: "dig" });

assert.deepEqual(parseFocusFields({ text: "please retest everything" }), {});
assert.deepEqual(parseFocusFields({ retest_finding_ids: ["old"] }), {});

// Optional wire booleans (allow_postex / allow_destructive)
assert.equal(parseOptionalWireBoolean(true), true);
assert.equal(parseOptionalWireBoolean(false), false);
assert.equal(parseOptionalWireBoolean("true"), true);
assert.equal(parseOptionalWireBoolean("false"), false);
assert.equal(parseOptionalWireBoolean(undefined), undefined);
assert.equal(parseOptionalWireBoolean(null), undefined);
assert.equal(parseOptionalWireBoolean("yes"), undefined);
assert.equal(parseOptionalWireBoolean(1), undefined);

assert.equal(parseAllowPostex({ allow_postex: true }), true);
assert.equal(parseAllowPostex({ allowPostex: false }), false);
assert.equal(parseAllowPostex({ allow_postex: "true" }), true);
assert.equal(parseAllowPostex({ allowPostex: "false" }), false);
assert.equal(parseAllowPostex({}), undefined);
assert.equal(parseAllowPostex({ text: "allow postex please" }), undefined);

assert.equal(parseHandoffSummary({ handoff_summary: "  short scope  " }), "short scope");
assert.equal(parseHandoffSummary({ handoffSummary: "card body" }), "card body");
assert.equal(parseHandoffSummary({ proposed_action: "not this field" }), undefined);
assert.equal(parseHandoffSummary({ initial_instruction: "utterance" }), undefined);

assert.equal(parseAllowDestructive({ allow_destructive: true }), true);
assert.equal(parseAllowDestructive({ allowDestructive: false }), false);
assert.equal(parseAllowDestructive({ allow_destructive: "true" }), true);
assert.equal(parseAllowDestructive({ allowDestructive: "false" }), false);
assert.equal(parseAllowDestructive({}), undefined);
assert.equal(parseAllowDestructive({ text: "please allow destructive" }), undefined);
// Must not invent from instruction / unrelated keys
assert.equal(parseAllowDestructive({ allow_postex: true }), undefined);

console.log("task-envelope-fields.test.ts: ok");
