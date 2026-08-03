/**
 * Run: npx tsx src/runtime/active-session-registry.test.ts
 */
import assert from "node:assert/strict";
import {
  clearActiveSessionsForTests,
  deliverUserSteerToActiveSession,
  registerActiveSession,
} from "./active-session-registry.js";

clearActiveSessionsForTests();

assert.deepEqual(
  deliverUserSteerToActiveSession("c1", "password is hacked"),
  { ok: false, reason: "no_session" },
  "no session",
);

const steered: string[] = [];
const followed: string[] = [];
const unreg = registerActiveSession({
  conversationId: "c1",
  taskId: "t1",
  steer: (t) => {
    steered.push(t);
  },
  followUp: (t) => {
    followed.push(t);
  },
});

const r = deliverUserSteerToActiveSession("c1", "密码是hacked");
assert.equal(r.ok, true);
assert.equal(r.ok && r.mode, "steer");
assert.deepEqual(steered, ["密码是hacked"]);
assert.deepEqual(followed, []);

assert.deepEqual(
  deliverUserSteerToActiveSession("c1", "   "),
  { ok: false, reason: "empty" },
  "empty",
);

// steer throws → followUp
clearActiveSessionsForTests();
registerActiveSession({
  conversationId: "c2",
  taskId: "t2",
  steer: () => {
    throw new Error("no steer");
  },
  followUp: (t) => {
    followed.push(t);
  },
});
followed.length = 0;
const r2 = deliverUserSteerToActiveSession("c2", "hint");
assert.equal(r2.ok, true);
assert.equal(r2.ok && r2.mode, "followUp");
assert.deepEqual(followed, ["hint"]);

unreg();
clearActiveSessionsForTests();
console.log("active-session-registry.test.ts: ok");
