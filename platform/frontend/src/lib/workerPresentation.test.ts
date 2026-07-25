/**
 * Pure presentation helpers — no vitest; run with:
 *   npx tsx src/lib/workerPresentation.test.ts
 * (from platform/frontend)
 */
import assert from "node:assert/strict";
import {
  agentDisplayName,
  agentPurposeLine,
  displayTodoTitle,
  extractThisTurnGoal,
  findAgentByIdExact,
  humanAgentChipName,
  isWorkerName,
  legacyWorkerDisplayName,
  looksLikeHandoffPackage,
  scrubWorkerPurpose,
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

console.log("workerPresentation.test.ts: ok");
