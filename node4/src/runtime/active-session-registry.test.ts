/**
 * Run: npx tsx src/runtime/active-session-registry.test.ts
 */
import assert from "node:assert/strict";
import {
  applyScopeToLiveSession,
  clearActiveSessionsForTests,
  clearPendingSteers,
  deliverUserSteerToActiveSession,
  enqueuePendingSteer,
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

// --- pending buffer: enqueue before register, flush on register ---
{
  const got: string[] = [];
  enqueuePendingSteer("c-pending", "password is admin");
  enqueuePendingSteer("c-pending", "also try root");
  // still no session → deliver fails
  assert.deepEqual(
    deliverUserSteerToActiveSession("c-pending", "late"),
    { ok: false, reason: "no_session" },
  );
  enqueuePendingSteer("c-pending", "late");
  registerActiveSession({
    conversationId: "c-pending",
    taskId: "t-p",
    steer: (t) => {
      got.push(t);
    },
    followUp: () => {
      throw new Error("no followUp");
    },
  });
  assert.deepEqual(got, ["password is admin", "also try root", "late"]);
  clearActiveSessionsForTests();
}

// --- enqueue with live session injects immediately ---
{
  const got: string[] = [];
  registerActiveSession({
    conversationId: "c-live",
    taskId: "t-l",
    steer: (t) => {
      got.push(t);
    },
    followUp: () => {},
  });
  enqueuePendingSteer("c-live", "immediate");
  assert.deepEqual(got, ["immediate"]);
  clearActiveSessionsForTests();
}

// --- clearPendingSteers drops queue without delivery ---
{
  const got: string[] = [];
  enqueuePendingSteer("c-drop", "never");
  clearPendingSteers("c-drop");
  registerActiveSession({
    conversationId: "c-drop",
    taskId: "t-d",
    steer: (t) => {
      got.push(t);
    },
    followUp: () => {},
  });
  assert.deepEqual(got, []);
  clearActiveSessionsForTests();
}

// --- empty / blank enqueue is no-op ---
{
  enqueuePendingSteer("", "x");
  enqueuePendingSteer("c-empty", "  ");
  const got: string[] = [];
  registerActiveSession({
    conversationId: "c-empty",
    taskId: "t-e",
    steer: (t) => {
      got.push(t);
    },
    followUp: () => {},
  });
  assert.deepEqual(got, []);
  clearActiveSessionsForTests();
}

// --- stage switch: unregister A, enqueue, register B flushes to B ---
{
  const a: string[] = [];
  const b: string[] = [];
  const unregA = registerActiveSession({
    conversationId: "c-switch",
    taskId: "t-a",
    steer: (t) => {
      a.push(t);
    },
    followUp: () => {},
  });
  unregA();
  enqueuePendingSteer("c-switch", "for next stage");
  registerActiveSession({
    conversationId: "c-switch",
    taskId: "t-b",
    steer: (t) => {
      b.push(t);
    },
    followUp: () => {},
  });
  assert.deepEqual(a, []);
  assert.deepEqual(b, ["for next stage"]);
  clearActiveSessionsForTests();
}

{
  const task = { scope: { allow: [] as string[] } };
  registerActiveSession({
    conversationId: "c-scope",
    taskId: "t-scope",
    steer: () => {},
    followUp: () => {},
    applyScope: (scope) => {
      const incoming = scope && typeof scope === "object" ? (scope as { allow?: string[] }) : {};
      task.scope = { allow: incoming.allow || [] };
    },
  });
  assert.equal(applyScopeToLiveSession("c-scope", { allow: ["www.example.com"] }), true);
  assert.deepEqual(task.scope.allow, ["www.example.com"]);
  assert.equal(applyScopeToLiveSession("missing", { allow: ["x"] }), false);
  clearActiveSessionsForTests();
}

console.log("active-session-registry.test.ts: ok");
