/**
 * Spec #308 S-turn / S4 / S5 pure tests.
 */
import assert from "node:assert/strict";
import {
  buildPackageTurns,
  mapDeliveryStatus,
  mergeHistoryAndLive,
  selectDefaultTurnId,
} from "./workerAuditTurns";

assert.equal(mapDeliveryStatus("ok"), "ok");
assert.equal(mapDeliveryStatus("success"), "ok");
assert.equal(mapDeliveryStatus("failed"), "failed");
assert.equal(mapDeliveryStatus("timeout"), "failed");
assert.equal(mapDeliveryStatus("interrupted"), "interrupted");
assert.equal(mapDeliveryStatus("aborted"), "interrupted");
assert.equal(mapDeliveryStatus("stopped"), "interrupted");
assert.notEqual(mapDeliveryStatus("failed"), mapDeliveryStatus("interrupted"));

const frames = [
  {
    id: "s1",
    msg_type: "worker_package_start",
    created_at: "2026-01-01T00:00:00Z",
    content: {
      agent_id: "sub_1",
      package_turn_id: "pkg_1",
      handoff: {
        target: "https://t",
        scope: "web",
        already_done: "none",
        this_turn_goal: "First goal",
        success_criteria: "poc",
      },
    },
  },
  {
    id: "th1",
    msg_type: "thinking",
    created_at: "2026-01-01T00:00:01Z",
    content: {
      agent_id: "sub_1",
      package_turn_id: "pkg_1",
      text: "thinking…",
      stream_id: "st1",
    },
  },
  {
    id: "tool1",
    msg_type: "tool_call",
    created_at: "2026-01-01T00:00:02Z",
    content: {
      agent_id: "sub_1",
      package_turn_id: "pkg_1",
      tool_name: "shell",
      status: "done",
    },
  },
  {
    id: "d1",
    msg_type: "worker_package_delivery",
    created_at: "2026-01-01T00:00:03Z",
    content: {
      agent_id: "sub_1",
      package_turn_id: "pkg_1",
      status: "ok",
      summary: "done",
    },
  },
  {
    id: "s2",
    msg_type: "worker_package_start",
    created_at: "2026-01-01T01:00:00Z",
    content: {
      agent_id: "sub_1",
      package_turn_id: "pkg_2",
      handoff: {
        target: "https://t",
        scope: "web",
        already_done: "first",
        this_turn_goal: "Second goal",
        success_criteria: "deadend",
      },
    },
  },
  {
    id: "th2",
    msg_type: "thinking",
    created_at: "2026-01-01T01:00:01Z",
    content: {
      agent_id: "sub_1",
      package_turn_id: "pkg_2",
      text: "still running",
      stream_id: "st2",
    },
  },
];

const turns = buildPackageTurns(frames, "sub_1");
assert.equal(turns.length, 2);
assert.equal(turns[0].status, "ok");
assert.ok(turns[0].delivery);
assert.equal(turns[0].delivery?.status, "ok");
assert.equal(turns[0].handoff.this_turn_goal, "First goal");
assert.equal(turns[0].process.length, 2);

assert.equal(turns[1].status, "running");
assert.equal(turns[1].delivery, null, "running has no Delivery");
assert.equal(turns[1].handoff.this_turn_goal, "Second goal");

assert.equal(selectDefaultTurnId(turns), "pkg_2", "default latest turn");

// Interrupt vs fail
const failTurn = buildPackageTurns(
  [
    {
      id: "s",
      msg_type: "worker_package_start",
      content: {
        agent_id: "sub_x",
        package_turn_id: "p",
        handoff: { this_turn_goal: "g", target: "t", scope: "s", already_done: "a", success_criteria: "c" },
      },
    },
    {
      id: "d",
      msg_type: "worker_package_delivery",
      content: { agent_id: "sub_x", package_turn_id: "p", status: "interrupted", summary: "stop" },
    },
  ],
  "sub_x",
);
assert.equal(failTurn[0].status, "interrupted");
assert.notEqual(failTurn[0].status, "failed");

// S5 late open: history + live merge keeps prefix
const history = [
  {
    id: "h1",
    msg_type: "thinking",
    created_at: "2026-01-01T00:00:00Z",
    content: { agent_id: "sub_1", package_turn_id: "pkg_1", stream_id: "st1", text: "hi" },
  },
];
const live = [
  {
    id: "l1",
    msg_type: "thinking",
    created_at: "2026-01-01T00:00:01Z",
    content: { agent_id: "sub_1", package_turn_id: "pkg_1", stream_id: "st1", text: "hi there" },
  },
  {
    id: "l2",
    msg_type: "text",
    created_at: "2026-01-01T00:00:02Z",
    content: { agent_id: "sub_1", package_turn_id: "pkg_1", stream_id: "st3", text: "new" },
  },
];
const merged = mergeHistoryAndLive(history, live);
assert.equal(merged.length, 2);
const st1 = merged.find((m) => String(m.content?.stream_id) === "st1");
assert.equal(String(st1?.content?.text), "hi there");

// Legacy: no process frames → empty turns (honest)
assert.deepEqual(buildPackageTurns([{ id: "m", msg_type: "text", content: { text: "main" } }], "sub_1"), []);

console.log("workerAuditTurns.test.ts: ok");
