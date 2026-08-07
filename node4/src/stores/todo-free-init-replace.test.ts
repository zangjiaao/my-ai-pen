/**
 * Spec #313 S2 — Free todo init replace policy.
 * Silent full todo.init replace forbidden when Free map exists; maintain ops stay open.
 * Run: npx tsx src/stores/todo-free-init-replace.test.ts
 */
import assert from "node:assert/strict";
import {
  applyTodoOp,
  freeInitReplaceDenied,
  freeMapNonEmpty,
  TodoStore,
  type TodoPhase,
} from "./todo.js";

const seed: TodoPhase[] = [
  {
    name: "Tasks",
    tasks: [
      { content: "Map surface", status: "completed" },
      { content: "Probe auth", status: "in_progress" },
      { content: "Book findings", status: "pending" },
    ],
  },
];

// --- pure policy ---
assert.equal(freeMapNonEmpty([]), false);
assert.equal(freeMapNonEmpty([{ name: "T", tasks: [] }]), false);
assert.equal(freeMapNonEmpty(seed), true);

assert.equal(freeInitReplaceDenied([], false), undefined, "empty map allows init");
assert.equal(freeInitReplaceDenied(seed, true), undefined, "permission allows replace");
const denied = freeInitReplaceDenied(seed, false);
assert.ok(
  denied && (/allow_replace|todo_replace/i.test(denied) || /permission|forbidden|replace/i.test(denied)),
  "denied names replace permission",
);
assert.ok(denied && /permission|forbidden|replace/i.test(denied));

// --- applyTodoOp with free_map gate ---
const wipe = applyTodoOp(seed, {
  op: "init",
  free_map: true,
  items: ["Brand new A", "Brand new B"],
});
assert.ok(wipe.errors.length > 0, "silent free init replace errors");
assert.equal(wipe.readOnly, true);
assert.equal(wipe.phases.length, 1);
assert.equal(wipe.phases[0]!.tasks.length, 3, "state unchanged");
assert.equal(wipe.phases[0]!.tasks[0]!.content, "Map surface");

const withPerm = applyTodoOp(seed, {
  op: "init",
  free_map: true,
  allow_replace: true,
  items: ["Replanned one", "Replanned two"],
});
assert.equal(withPerm.errors.length, 0);
assert.equal(withPerm.readOnly, false);
assert.equal(withPerm.phases[0]!.tasks.length, 2);
assert.equal(withPerm.phases[0]!.tasks[0]!.content, "Replanned one");

// Without free_map flag: Graph/legacy callers keep prior full-replace behavior.
const legacy = applyTodoOp(seed, {
  op: "init",
  items: ["Legacy replace A"],
});
assert.equal(legacy.errors.length, 0);
assert.equal(legacy.phases[0]!.tasks.length, 1);

// --- L4: decline replace still allows maintain ops ---
const afterDeny = applyTodoOp(seed, {
  op: "init",
  free_map: true,
  list: [{ phase: "New", items: ["x"] }],
});
assert.ok(afterDeny.errors.length > 0);

const appended = applyTodoOp(seed, {
  op: "append",
  free_map: true,
  phase: "Tasks",
  items: ["Deepen XSS"],
});
assert.equal(appended.errors.length, 0);
assert.ok(appended.phases[0]!.tasks.some((t) => t.content === "Deepen XSS"));

const done = applyTodoOp(seed, { op: "done", free_map: true, task: "Probe auth" });
assert.equal(done.errors.length, 0);
assert.equal(done.phases[0]!.tasks.find((t) => t.content === "Probe auth")!.status, "completed");

const dropped = applyTodoOp(seed, { op: "drop", free_map: true, task: "Book findings" });
assert.equal(dropped.errors.length, 0);
assert.equal(dropped.phases[0]!.tasks.find((t) => t.content === "Book findings")!.status, "abandoned");

const started = applyTodoOp(seed, { op: "start", free_map: true, task: "Book findings" });
assert.equal(started.errors.length, 0);
assert.equal(started.phases[0]!.tasks.find((t) => t.content === "Book findings")!.status, "in_progress");

// Empty Free map may init without permission.
const first = applyTodoOp([], {
  op: "init",
  free_map: true,
  items: ["First map item"],
});
assert.equal(first.errors.length, 0);
assert.equal(first.phases[0]!.tasks.length, 1);

// --- TodoStore apply path ---
const store = new TodoStore();
store.apply({ op: "init", free_map: true, items: ["A", "B"] });
const blocked = store.apply({
  op: "init",
  free_map: true,
  items: ["X", "Y", "Z"],
});
assert.ok(blocked.errors.length > 0);
assert.equal(store.snapshot()[0]!.tasks.length, 2, "store unchanged after denied replace");
const allowed = store.apply({
  op: "init",
  free_map: true,
  allow_replace: true,
  items: ["Clean slate"],
});
assert.equal(allowed.errors.length, 0);
assert.equal(store.snapshot()[0]!.tasks.length, 1);
store.apply({ op: "append", free_map: true, phase: "Tasks", items: ["Keep going"] });
assert.equal(store.snapshot()[0]!.tasks.length, 2);

console.log("todo-free-init-replace.test.ts: ok");
