/**
 * Pure focus field parsers for task_assign.
 * Run: npx tsx src/runtime/task-envelope-fields.test.ts
 */
import assert from "node:assert/strict";
import {
  parseFocusFields,
  parseFocusFindingIds,
  parseFocusNote,
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

console.log("task-envelope-fields.test.ts: ok");
