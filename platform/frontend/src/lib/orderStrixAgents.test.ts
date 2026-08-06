/**
 * Spec #301 — numeric Worker roster sort (orderStrixAgents).
 * Run: npx tsx src/lib/orderStrixAgents.test.ts
 */
import assert from "node:assert/strict";
import { orderStrixAgents } from "../components/AgentCollaborationTree.tsx";
import type { StrixAgentStatus } from "./panelTypes.ts";

function worker(id: string, name: string, parent = "node4-main"): StrixAgentStatus {
  return {
    id,
    name,
    status: "running",
    parent_id: parent,
    role: "subagent",
  };
}

const main: StrixAgentStatus = {
  id: "node4-main",
  name: "Expert",
  status: "running",
  parent_id: null,
  role: "main",
};

const shuffled = [
  worker("w10", "Worker 10"),
  worker("w1", "Worker 1"),
  worker("w11", "Worker 11"),
  worker("w2", "Worker 2"),
  main,
];

const ordered = orderStrixAgents(shuffled);
assert.equal(ordered[0]?.id, "node4-main", "Main first by depth");
assert.deepEqual(
  ordered.filter((a) => a.role === "subagent").map((a) => a.name),
  ["Worker 1", "Worker 2", "Worker 10", "Worker 11"],
  "Workers numeric order 1,2,10,11 not lex 1,10,11,2",
);

console.log("orderStrixAgents.test.ts: ok");
