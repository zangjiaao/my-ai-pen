/**
 * Engagement resolution + finish gates by structured engagement / workflow run.
 * Does NOT keyword-parse free-text instructions (AGENTS.md Intent And Workflow Selection).
 */
import {
  engagementFromWorkflowRuns,
  resolveEffectiveEngagement,
  resolveExplicitEngagement,
  workflowForEngagement,
} from "./runtime/engagement.js";
import { finishCompletedEligibility } from "./runtime/detection-conversion.js";
import type { TaskEnvelope } from "./types.js";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const baseTask = {
  taskId: "eng-smoke",
  conversationId: "eng-smoke",
  instruction: "placeholder — free text must not drive structured engagement in this smoke",
  target: { type: "url", value: "http://127.0.0.1:9" },
  scope: { allow: ["http://127.0.0.1:9"] },
  snapshot: {},
} as TaskEnvelope;

// Explicit structured field.
const explicit = resolveExplicitEngagement({ ...baseTask, engagement: "verify" });
assert(explicit?.engagement === "verify", "explicit verify");
assert(explicit?.workflow === "pentest-verify", "verify workflow name");
assert(explicit?.source === "explicit", "explicit source");

// No free-text inference: instruction containing "verify" without structured field stays unset.
const noExplicit = resolveExplicitEngagement({
  ...baseTask,
  instruction: "Please verify the SQL injection on /login and also explain the methodology",
});
assert(noExplicit === undefined, "must not infer engagement from free-text instruction");

// Default catalog default is assess, but effective without runs is default assess.
const effectiveDefault = resolveEffectiveEngagement(baseTask, []);
assert(effectiveDefault.engagement === "assess", "default assess");
assert(effectiveDefault.source === "default", "default source");

// Workflow-run derivation after agent chose pentest-verify.
const fromRun = engagementFromWorkflowRuns([
  { runId: "r1", status: "completed", specPath: "workflows/pentest-verify/spec.json" },
]);
assert(fromRun?.engagement === "verify", "workflow run → verify");
assert(fromRun?.source === "workflow", "workflow source");

const effectiveFromRun = resolveEffectiveEngagement(baseTask, [
  { runId: "r1", status: "completed", specPath: "workflows/pentest-consult/spec.json" },
]);
assert(effectiveFromRun.engagement === "consult", "effective from consult workflow");
assert(effectiveFromRun.source === "workflow", "effective source workflow");

// Explicit wins over workflow run.
const explicitWins = resolveEffectiveEngagement({ ...baseTask, engagement: "retest" }, [
  { runId: "r1", status: "completed", specPath: "workflows/pentest-web/spec.json" },
]);
assert(explicitWins.engagement === "retest", "explicit wins");
assert(workflowForEngagement("retest") === "pentest-retest", "retest workflow");

// Finish gates: assess blocks on multi-actor when surface needs it; verify does not.
const apiRows = [{ endpoint: "/api/Users/1", param: "id", vulnClass: "idor", status: "failed", notes: "tested" }];
const assessBlocked = finishCompletedEligibility(apiRows as any, {
  status: "completed",
  actorCount: 0,
  engagement: "assess",
});
assert(!assessBlocked.allowed, `assess should block multi-actor: ${assessBlocked.reason}`);

const verifyOk = finishCompletedEligibility(apiRows as any, {
  status: "completed",
  actorCount: 0,
  engagement: "verify",
});
assert(verifyOk.allowed, `verify should allow without multi-actor: ${verifyOk.reason}`);

const consultOk = finishCompletedEligibility([], {
  status: "completed",
  engagement: "consult",
});
assert(consultOk.allowed, "consult completed allowed");

console.log(
  JSON.stringify(
    {
      ok: true,
      explicit: explicit?.engagement,
      no_nlp_inference: true,
      workflow_derivation: fromRun?.engagement,
      assess_blocks_without_actors: !assessBlocked.allowed,
      verify_skips_full_gates: verifyOk.allowed,
    },
    null,
    2,
  ),
);
