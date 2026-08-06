/**
 * Pure presentation helpers — no vitest; run with:
 *   npx tsx src/lib/workerPresentation.test.ts
 * (from platform/frontend)
 */
import assert from "node:assert/strict";
import {
  agentDisplayName,
  agentPurposeLine,
  compareAgentNames,
  displayTodoTitle,
  extractThisTurnGoal,
  findAgentByIdExact,
  humanAgentChipName,
  isWorkerName,
  legacyWorkerDisplayName,
  looksLikeHandoffPackage,
  resolveTasksAgentChip,
  scrubWorkerPurpose,
  workerNameOrdinal,
} from "./workerPresentation.ts";

const handoff = `# Subagent handoff package
## Target
https://example.com/sqli
## This-turn goal
Probe SQL Injection at /vulnerabilities/sqli/
## Scope
web
`;

assert.equal(looksLikeHandoffPackage(handoff), true);
assert.equal(extractThisTurnGoal(handoff), "Probe SQL Injection at /vulnerabilities/sqli/");
assert.equal(scrubWorkerPurpose(handoff), "Probe SQL Injection at /vulnerabilities/sqli/");
assert.equal(scrubWorkerPurpose("Worker 2"), "");
assert.equal(scrubWorkerPurpose("sub_12"), "");
assert.equal(isWorkerName("Worker 3"), true);
assert.equal(isWorkerName("Worker"), false);

assert.equal(
  agentDisplayName({ role: "subagent", name: "Worker 2" }),
  "Worker 2",
);
assert.equal(
  agentDisplayName({ role: "subagent", name: "Subagent sub_9", id: "x" }),
  "Worker",
);
assert.equal(
  agentDisplayName({ role: "main", name: "渗透大师", parent_id: null }),
  "渗透大师",
);
// parent_id alone must not force Worker rename (multi-role).
assert.equal(
  agentDisplayName({ role: "main", name: "Role B", parent_id: "case" }),
  "Role B",
);

assert.equal(
  agentPurposeLine({
    current_detail: handoff,
    task: "",
    name: "Worker 1",
  }),
  "Probe SQL Injection at /vulnerabilities/sqli/",
);

assert.equal(humanAgentChipName("Worker 1"), "Worker 1");
assert.equal(humanAgentChipName("sub_99"), "");
assert.equal(humanAgentChipName("Subagent sub_1"), "");

const agents = [
  { id: "node4-main", name: "Expert" },
  { id: "node4-main-sub_1", name: "Worker 1" },
  { id: "node4-main-sub_10", name: "Worker 10" },
];
assert.equal(findAgentByIdExact(agents, "sub_1")?.name, "Worker 1");
assert.equal(findAgentByIdExact(agents, "sub_10")?.name, "Worker 10");
// includes() would wrongly match sub_1 inside sub_10 — exact suffix must not.
assert.notEqual(findAgentByIdExact(agents, "sub_1")?.id, "node4-main-sub_10");

assert.equal(legacyWorkerDisplayName(agents, "sub_1"), "Worker 1");
assert.equal(legacyWorkerDisplayName(agents, "sub_99"), "Worker");
assert.equal(legacyWorkerDisplayName([], "sub_1"), "Worker");

assert.ok(displayTodoTitle(handoff).includes("SQL Injection"));
assert.equal(displayTodoTitle("Map login（已完成）"), "Map login");

// Spec #301 — numeric Worker roster order (1,2,10,11 not 1,10,11,2)
assert.equal(workerNameOrdinal("Worker 10"), 10);
assert.equal(workerNameOrdinal("Main"), null);
assert.ok(compareAgentNames("Worker 2", "Worker 10") < 0, "Worker 2 before Worker 10");
assert.ok(compareAgentNames("Worker 10", "Worker 11") < 0);
const roster = ["Worker 1", "Worker 10", "Worker 11", "Worker 2"].sort(compareAgentNames);
assert.deepEqual(roster, ["Worker 1", "Worker 2", "Worker 10", "Worker 11"]);

// Chip: agent_id → panel Worker N when owner missing
assert.equal(
  resolveTasksAgentChip({ owner_agent_name: "", agent_id: "sub_1" }, agents),
  "Worker 1",
);
// Spec #308: panel roster by agent_id wins over sticky Node owner_agent_name
assert.equal(
  resolveTasksAgentChip({ owner_agent_name: "Worker 3", agent_id: "sub_1" }, agents),
  "Worker 1",
);
assert.equal(resolveTasksAgentChip({ agent_id: "sub_missing" }, agents), "");
// owner_agent_name still used when no agent_id / panel row
assert.equal(
  resolveTasksAgentChip({ owner_agent_name: "Worker 3", agent_id: "sub_missing" }, agents),
  "Worker 3",
);
assert.equal(resolveTasksAgentChip({ owner_agent_name: "Worker 7" }), "Worker 7");

// Spec #308 S7 / DoD #10: rename on Tasks chips via overrides or agents with override applied
assert.equal(
  resolveTasksAgentChip(
    { owner_agent_name: "Worker 1", agent_id: "sub_1" },
    agents,
    { sub_1: "Recon" },
  ),
  "Recon",
);
const renamedAgents = [
  { id: "node4-main-sub_1", name: "Recon", role: "subagent" },
  { id: "node4-main-sub_10", name: "Worker 10", role: "subagent" },
];
assert.equal(
  resolveTasksAgentChip(
    { owner_agent_name: "Worker 1", agent_id: "sub_1" },
    renamedAgents,
  ),
  "Recon",
);

console.log("workerPresentation.test.ts: ok");
