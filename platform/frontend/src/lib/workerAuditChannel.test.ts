/**
 * Spec #308 S-channel pure tests.
 */
import assert from "node:assert/strict";
import {
  filterMainChannelMessages,
  filterWorkerAgentMessages,
  filterWorkerTurnMessages,
  isWorkerAuditScoped,
} from "./workerAuditChannel";

const mainText = { id: "1", msg_type: "text", content: { text: "hello", stream_id: "s1" } };
const mainTool = {
  id: "2",
  msg_type: "tool_call",
  content: { tool_name: "subagent", status: "done" },
};
const workerThink = {
  id: "3",
  msg_type: "thinking",
  content: {
    text: "probe",
    channel: "worker_audit",
    agent_id: "sub_1",
    package_turn_id: "pkg_a",
    stream_id: "ws1",
  },
};
const workerTool = {
  id: "4",
  msg_type: "tool_call",
  content: {
    tool_name: "shell",
    agent_id: "sub_1",
    package_turn_id: "pkg_a",
    status: "done",
  },
};
const workerOther = {
  id: "5",
  msg_type: "text",
  content: { text: "other", agent_id: "sub_2", package_turn_id: "pkg_b", channel: "worker_audit" },
};
const pkgStart = {
  id: "6",
  msg_type: "worker_package_start",
  content: { agent_id: "sub_1", package_turn_id: "pkg_a", handoff: { this_turn_goal: "g" } },
};

assert.equal(isWorkerAuditScoped(mainText), false);
assert.equal(isWorkerAuditScoped(mainTool), false);
assert.equal(isWorkerAuditScoped(workerThink), true);
assert.equal(isWorkerAuditScoped(workerTool), true);
assert.equal(isWorkerAuditScoped(pkgStart), true);

const mainList = filterMainChannelMessages([
  mainText,
  mainTool,
  workerThink,
  workerTool,
  pkgStart,
]);
assert.deepEqual(
  mainList.map((m) => m.id),
  ["1", "2"],
  "Main never shows Worker process",
);

const worker1 = filterWorkerAgentMessages(
  [mainText, workerThink, workerTool, workerOther, pkgStart],
  "sub_1",
);
assert.ok(worker1.every((m) => m.id !== "1" && m.id !== "5"));
assert.ok(worker1.some((m) => m.id === "3"));
assert.ok(worker1.some((m) => m.id === "6"));

const turnA = filterWorkerTurnMessages(worker1, "pkg_a");
assert.ok(turnA.every((m) => String(m.content?.package_turn_id) === "pkg_a"));

console.log("workerAuditChannel.test.ts: ok");
