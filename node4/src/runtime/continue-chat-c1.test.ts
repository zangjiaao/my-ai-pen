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
  parseGraphExecution,
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

// Explicit full re-run still Hard (structured retest = graph_execution=full)
const reentry = resolveExpertWorkPath({
  hardMode: "hard",
  graphIntent: "redteam_deep",
  chatOnly: false,
  continueInEnvelope: isContinueInEnvelopeExecution({
    graphExecution: "full",
  }),
});
assert.equal(reentry.path, "hard", "structured full still full Hard path");

// Deep sticky continue
const deepCont = resolveExpertWorkPath({
  hardMode: "hard",
  graphIntent: "redteam_deep",
  chatOnly: false,
  continueInEnvelope: isContinueInEnvelopeExecution({ graphExecution: "continue" }),
});
assert.equal(deepCont.path, "free", "deep continue-in-envelope");

// Shared parse collapses synonyms once
assert.equal(parseGraphExecution({ graph_execution: "continue_chat" }), "continue");
assert.equal(parseGraphExecution({ graphExecution: "envelope" }), "continue");
assert.equal(parseGraphExecution({ graph_execution: "run" }), "full");
assert.equal(parseGraphExecution({ graph_execution: "restart" }), "full");
assert.equal(parseGraphExecution({}), undefined);
assert.equal(
  isContinueInEnvelopeExecution({
    graphExecution: parseGraphExecution({ graph_execution: "continue_chat" }),
  }),
  true,
  "parse then binary: continue_chat → continue",
);
assert.equal(
  isContinueInEnvelopeExecution({
    graphExecution: parseGraphExecution({ graph_execution: "full" }),
  }),
  false,
);

// Spec #282: incomplete Graph resume must not take C1 free path
assert.equal(parseGraphExecution({ graph_execution: "resume" }), "resume");
assert.equal(
  isContinueInEnvelopeExecution({
    graphExecution: parseGraphExecution({ graph_execution: "resume" }),
  }),
  false,
  "resume is not C1",
);
const resumePath = resolveExpertWorkPath({
  hardMode: "hard",
  graphIntent: "app_assessment",
  chatOnly: false,
  continueInEnvelope: isContinueInEnvelopeExecution({
    graphExecution: parseGraphExecution({ graph_execution: "resume" }),
  }),
});
assert.equal(resumePath.path, "hard", "Spec #282: incomplete resume stays Hard");

console.log("continue-chat-c1.test.ts: ok");
