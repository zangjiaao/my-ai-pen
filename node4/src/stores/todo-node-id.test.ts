/**
 * Todo work_items expose stable node_id for subagent plan_node_id.
 * Run: npx tsx src/stores/todo-node-id.test.ts
 */
import assert from "node:assert/strict";
import { TodoStore, formatTodoSummary, todoTaskNodeId } from "./todo.js";

const store = new TodoStore();
const init = store.apply({
  op: "init",
  list: [
    {
      phase: "class_probe",
      items: ["SQL Injection (sqli)", "Reflected XSS (xss_r)"],
    },
  ],
});
assert.equal(init.errors.length, 0);

const plan = store.toPlanNodes();
const work = plan.filter((n) => n.level === "work_item");
assert.equal(work.length, 2);
for (const w of work) {
  assert.ok(w.node_id.startsWith("todo-task-"), w.node_id);
  assert.equal(w.node_id, todoTaskNodeId("class_probe", w.title));
}

const summary = formatTodoSummary(store.snapshot());
assert.match(summary, /node_id=todo-task-/);
assert.match(summary, /plan_node_id/, "hint when multiple open");
assert.ok(summary.includes(work[0]!.node_id));
assert.ok(summary.includes(work[1]!.node_id));

// One open item → no multi-todo hint.
store.apply({ op: "done", task: "SQL Injection (sqli)" });
const oneOpen = formatTodoSummary(store.snapshot());
assert.match(oneOpen, /node_id=todo-task-/);
assert.doesNotMatch(oneOpen, /Hint: pass work_items/);

console.log("todo-node-id.test.ts: ok");
