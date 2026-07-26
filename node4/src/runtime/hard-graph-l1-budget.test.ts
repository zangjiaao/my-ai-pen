/**
 * Spec #139 NC-L1 — runner owns refine budget.
 * Run: npx tsx src/runtime/hard-graph-l1-budget.test.ts
 */
import assert from "node:assert/strict";
import { runHardGraph } from "./hard-graph-runner.js";
import type { HardGraphDefinition } from "./hard-graph-definition.js";

const graph: HardGraphDefinition = {
  discipline: "hard",
  id: "l1_budget_fixture",
  label: "L1 budget",
  stages: [
    {
      id: "probe",
      intent: "probe",
      success: "ok",
      require: { summary: true },
      max_retries: 2,
    },
  ],
};

let attempts = 0;
const result = await runHardGraph({
  graph,
  availableTools: ["todo"],
  l1Budget: {
    getRefineCount: () => attempts,
    recordRefine: () => {
      attempts += 1;
    },
    maxRefine: 1,
  },
  executeStage: async () => {
    return {
      structured: {
        ok: true,
        summary: "probe done with summary text",
        surfaces: [],
        candidates: [],
        facts: [],
        deadends: [],
      },
      summary: "probe done with summary text",
      l1: { decision: "refine" as const, gaps: ["empty yield"] },
    };
  },
});

assert.equal(result.terminal, "blocked", "L1 refine budget exhaust blocks stage");
assert.ok(attempts >= 1, "at least one refine recorded");
assert.ok(
  result.stages[0]?.errors.some((e) => /l1_refine|l1_budget/i.test(e)),
  `errors mention l1: ${result.stages[0]?.errors.join(",")}`,
);

console.log("hard-graph-l1-budget.test.ts: ok");
