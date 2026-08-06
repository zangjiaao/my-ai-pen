/**
 * Spec #301 — Tasks work-item cap + hiddenCount disclosure.
 * Run: npx tsx src/lib/tasksListCap.test.ts
 */
import assert from "node:assert/strict";
import { discloseTaskListCap, TASKS_WORK_ITEM_CAP } from "./tasksListCap.ts";

assert.equal(TASKS_WORK_ITEM_CAP, 80, "product cap is 80");

// Under cap: no disclosure
const under = discloseTaskListCap(Array.from({ length: 40 }, (_, i) => i));
assert.equal(under.items.length, 40);
assert.equal(under.hiddenCount, 0);

// Exactly at cap
const exact = discloseTaskListCap(Array.from({ length: 80 }, (_, i) => i));
assert.equal(exact.items.length, 80);
assert.equal(exact.hiddenCount, 0);

// Over cap: slice + +N more count (e.g. 45 work items historically silent at 40)
const over = discloseTaskListCap(Array.from({ length: 95 }, (_, i) => `todo-${i}`));
assert.equal(over.items.length, 80);
assert.equal(over.hiddenCount, 15);
assert.equal(over.items[0], "todo-0");
assert.equal(over.items[79], "todo-79");
assert.ok(!over.items.includes("todo-80"), "overflow items excluded from list");

// Custom cap still discloses
const custom = discloseTaskListCap(["a", "b", "c", "d"], 2);
assert.deepEqual(custom.items, ["a", "b"]);
assert.equal(custom.hiddenCount, 2);

console.log("tasksListCap.test.ts: ok");
