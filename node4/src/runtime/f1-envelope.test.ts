/**
 * Map #81 F1: focus fields survive normalizeTaskAssign (uses shared pure parser).
 * Run: npx tsx src/runtime/f1-envelope.test.ts
 */
import assert from "node:assert/strict";
import { normalizeTaskAssign } from "../platform-smoke.js";
import { parseF1Focus } from "./task-envelope-fields.js";

// Pure path (canonical)
assert.deepEqual(
  parseF1Focus({
    focus_finding_ids: ["vuln-a", " vuln-b ", ""],
    focus_note: "  cover IDOR on /api/basket  ",
  }),
  { focusFindingIds: ["vuln-a", "vuln-b"], focusNote: "cover IDOR on /api/basket" },
);

// Through normalize (same pure helper)
const task = normalizeTaskAssign({
  type: "task_assign",
  task_id: "f1-1",
  conversation_id: "conv-f1",
  initial_instruction: "dig deeper on authz",
  engagement: "pentest",
  engagement_template: "app_assessment",
  graph_execution: "continue",
  focus_finding_ids: ["vuln-a", " vuln-b ", ""],
  focus_note: "  cover IDOR on /api/basket  ",
});

assert.deepEqual(task.focusFindingIds, ["vuln-a", "vuln-b"]);
assert.equal(task.focusNote, "cover IDOR on /api/basket");
assert.equal(task.graphExecution, "continue");

// Legacy wire alias still accepted
const legacy = normalizeTaskAssign({
  type: "task_assign",
  task_id: "f1-legacy",
  conversation_id: "c",
  initial_instruction: "x",
  retest_finding_ids: "id1,id2",
});
assert.deepEqual(legacy.focusFindingIds, ["id1", "id2"]);

const bare = normalizeTaskAssign({
  type: "task_assign",
  task_id: "f1-3",
  conversation_id: "c",
  initial_instruction: "please retest everything",
});
assert.equal(bare.focusFindingIds, undefined);
assert.equal(bare.focusNote, undefined);

console.log("f1-envelope.test.ts: ok");
