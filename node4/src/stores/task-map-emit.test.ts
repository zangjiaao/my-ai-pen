/**
 * Spec #321: Free emitTodoPlanTreeUpdate carries task_map_revisions + live_revision_id.
 * E2 sealed→init without grant grows revisions.
 */
import assert from "node:assert/strict";
import { TodoStore } from "./todo.js";
import { emitTodoPlanTreeUpdate } from "../runtime/plan-projection.js";
import type { PlatformMessage, TaskEnvelope } from "../types.js";

const messages: PlatformMessage[] = [];
const platform = {
  async send(msg: PlatformMessage) {
    messages.push(msg);
  },
};
const task = {
  conversationId: "c1",
  taskId: "t1",
  instruction: "test",
  expertId: "e1",
  expertName: "Expert",
} as TaskEnvelope;

const todo = new TodoStore();
todo.apply({ op: "init", free_map: true, items: ["A", "B"] });
todo.apply({ op: "done", free_map: true, task: "A" });
todo.apply({ op: "done", free_map: true, task: "B" });
assert.equal(todo.taskMapProjection().live_sealed, true);

await emitTodoPlanTreeUpdate(platform, task, todo, "todo.done");
const sealedEmit = messages.at(-1) as any;
assert.ok(Array.isArray(sealedEmit.task_map_revisions));
assert.ok(sealedEmit.live_revision_id);
assert.equal(sealedEmit.live_sealed, true);

// E2: sealed init without allow_replace
const r = todo.apply({ op: "init", free_map: true, items: ["Next"] });
assert.equal(r.errors.length, 0, "E2 no grant");
assert.equal(todo.taskMapProjection().task_map_revisions.length, 2);

messages.length = 0;
await emitTodoPlanTreeUpdate(platform, task, todo, "todo.init");
const nextEmit = messages.at(-1) as any;
assert.equal(nextEmit.task_map_revisions.length, 2);
assert.equal(nextEmit.live_sealed, false);
assert.notEqual(nextEmit.live_revision_id, sealedEmit.live_revision_id);

console.log("task-map-emit-test: ok");
