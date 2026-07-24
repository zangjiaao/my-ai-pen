/**
 * Map #81 F1: retest_finding_ids + focus_note survive task_assign normalize.
 * Run: npx tsx src/runtime/f1-envelope.test.ts
 */
import assert from "node:assert/strict";
import { normalizeTaskAssign } from "../platform-smoke.js";

const task = normalizeTaskAssign({
  type: "task_assign",
  task_id: "f1-1",
  conversation_id: "conv-f1",
  initial_instruction: "dig deeper on authz",
  engagement: "pentest",
  engagement_template: "app_assessment",
  graph_execution: "continue",
  retest_finding_ids: ["vuln-a", " vuln-b ", ""],
  focus_note: "  cover IDOR on /api/basket  ",
});

assert.deepEqual(task.retestFindingIds, ["vuln-a", "vuln-b"]);
assert.equal(task.focusNote, "cover IDOR on /api/basket");
assert.equal(task.graphExecution, "continue");

const camel = normalizeTaskAssign({
  type: "task_assign",
  task_id: "f1-2",
  conversation_id: "conv-f1",
  initial_instruction: "x",
  retestFindingIds: "id1,id2",
  focusNote: "note",
});
assert.deepEqual(camel.retestFindingIds, ["id1", "id2"]);
assert.equal(camel.focusNote, "note");

// No invent from free text alone
const bare = normalizeTaskAssign({
  type: "task_assign",
  task_id: "f1-3",
  conversation_id: "c",
  initial_instruction: "please retest everything",
});
assert.equal(bare.retestFindingIds, undefined);
assert.equal(bare.focusNote, undefined);

console.log("f1-envelope.test.ts: ok");
