/**
 * Spec #308 S-name pure tests.
 */
import assert from "node:assert/strict";
import {
  applyDisplayNameOverrides,
  normalizeDisplayNameWrite,
  resolveWorkerDisplayName,
} from "./workerDisplayName";

assert.equal(
  resolveWorkerDisplayName({
    agentId: "sub_1",
    overrides: { sub_1: "Alice" },
    panelName: "Worker 2",
  }),
  "Alice",
);
assert.equal(
  resolveWorkerDisplayName({ agentId: "sub_1", panelName: "Worker 2" }),
  "Worker 2",
);
assert.equal(
  resolveWorkerDisplayName({ agentId: "sub_1", workerOrdinal: 3 }),
  "Worker 3",
);
assert.equal(resolveWorkerDisplayName({ agentId: "sub_1" }), "Worker");

// Prefixed panel id
assert.equal(
  resolveWorkerDisplayName({
    agentId: "root-sub_9",
    overrides: { sub_9: "Bob" },
    panelName: "Worker 9",
  }),
  "Bob",
);

assert.deepEqual(normalizeDisplayNameWrite("  hi  "), { ok: true, value: "hi" });
assert.deepEqual(normalizeDisplayNameWrite(""), { ok: true, value: "" });
assert.equal(normalizeDisplayNameWrite("a".repeat(65)).ok, false);
assert.equal(normalizeDisplayNameWrite("ba\nd").ok, false);

const agents = [
  { id: "main", name: "Main", role: "main" },
  { id: "sub_1", name: "Worker 1", role: "subagent" },
  { id: "sub_2", name: "Worker 2", role: "subagent" },
];
const applied = applyDisplayNameOverrides(agents, { sub_1: "Recon" });
assert.equal(applied[0].name, "Main");
assert.equal(applied[1].name, "Recon");
assert.equal(applied[2].name, "Worker 2");

console.log("workerDisplayName.test.ts: ok");
