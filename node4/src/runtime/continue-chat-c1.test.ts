/**
 * C1 (#78 / #88): post-Graph follow-up with sticky template must not full-run Hard.
 * Models: completed Graph → new task_assign with engagementTemplate + target + graph_execution=continue.
 * Run: npx tsx src/runtime/continue-chat-c1.test.ts
 */
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isContinueInEnvelopeExecution,
  resolveExpertWorkPath,
  resolveHardGraph,
} from "./hard-graph-definition.js";
import { resolveGraphIdFromTask } from "./pentest-graph.js";

const repoExperts = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../experts/pentest",
);

// --- Simulated post-complete sticky task_assign (platform C1 signal) ---
const followUpTask = {
  engagementTemplate: "app_assessment",
  graphId: undefined as string | undefined,
  graphExecution: "continue" as const,
  graphReentry: undefined as boolean | undefined,
  // target present (not chatOnly) — the regression sticky+target used to re-fire Graph
  target: { type: "url", value: "https://lab.example/" },
};

const intent = resolveGraphIdFromTask(followUpTask);
assert.equal(intent, "app_assessment", "sticky template remains Graph intent");

const hard = await resolveHardGraph({
  task: followUpTask,
  packRoot: repoExperts,
  packId: "pentest",
  env: {},
});
assert.equal(hard.mode, "hard", "hard definition still loadable (envelope/RoE intact)");

const cont = isContinueInEnvelopeExecution({
  graphExecution: followUpTask.graphExecution,
  graphReentry: followUpTask.graphReentry,
});
assert.equal(cont, true);

const workPath = resolveExpertWorkPath({
  hardMode: hard.mode,
  graphIntent: intent,
  chatOnly: false,
  continueInEnvelope: cont,
});
assert.equal(
  workPath.path,
  "free",
  "C1: sticky Graph + target + continue ⇒ free-in-envelope, not Hard stage schedule",
);

// Explicit full re-run / reentry still Hard
const reentry = resolveExpertWorkPath({
  hardMode: "hard",
  graphIntent: "redteam_deep",
  chatOnly: false,
  continueInEnvelope: isContinueInEnvelopeExecution({
    graphExecution: "full",
    graphReentry: true,
  }),
});
assert.equal(reentry.path, "hard", "structured reentry still full Hard path");

// Deep sticky continue
const deepCont = resolveExpertWorkPath({
  hardMode: "hard",
  graphIntent: "redteam_deep",
  chatOnly: false,
  continueInEnvelope: isContinueInEnvelopeExecution({ graphExecution: "continue" }),
});
assert.equal(deepCont.path, "free", "deep continue-in-envelope");

console.log("continue-chat-c1.test.ts: ok");
