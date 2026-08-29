/**
 * Harness channel: product role stays harness; provider maps to user + ## Runtime.
 * Run: npx tsx src/runtime/harness-channel.test.ts
 */
import assert from "node:assert/strict";
import {
  HARNESS_CONTINUE_NOTICE,
  convertNode4MessagesToLlm,
  formatHarnessForLlm,
  isHarnessMessage,
  joinHarnessPrefixes,
  makeHarnessMessage,
} from "./harness-channel.js";
import { composeContinuePrompt, emptyStopContinuePrompt } from "./loop-policy.js";
import { buildGoalBudgetLimitPrompt, buildGoalContinuationPrompt } from "../stores/goal.js";
import { midRunTodoNudge } from "./todo-harness.js";
import { midRunBookingNudge } from "./booking-harness.js";
import { midRunNewUntestedSurfaceNudge } from "./surface-harness.js";

assert.equal(joinHarnessPrefixes("a", "", "b"), "a\n\nb");
assert.equal(joinHarnessPrefixes("  ", undefined), undefined);

const harness = makeHarnessMessage("### Continue\nresume");
assert.equal(harness.role, "harness");
assert.ok(isHarnessMessage(harness));
assert.equal(isHarnessMessage({ role: "user", content: "hi", timestamp: 1 }), false);

const fenced = formatHarnessForLlm("### Continue\nresume");
assert.ok(fenced.startsWith("## Runtime\n"));
assert.ok(fenced.includes("### Continue"));
assert.equal(formatHarnessForLlm("## Runtime\n### Continue"), "## Runtime\n### Continue");

const llm = convertNode4MessagesToLlm([
  { role: "user", content: "operator said this", timestamp: 1 },
  harness,
  {
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    api: "openai-completions",
    provider: "test",
    model: "t",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: 3,
  },
]);
assert.equal(llm.length, 3);
assert.equal(llm[0]?.role, "user");
assert.equal(llm[0]?.content, "operator said this");
assert.equal(llm[1]?.role, "user");
assert.equal(typeof llm[1] === "object" && "content" in llm[1] && llm[1].content, fenced);
assert.equal(llm[2]?.role, "assistant");

const empty = emptyStopContinuePrompt(1, 3);
assert.ok(empty.startsWith("### Continue"));
assert.ok(empty.includes(HARNESS_CONTINUE_NOTICE));
assert.ok(!empty.includes("<system-injection>"));
assert.ok(!empty.includes("<system-reminder>"));

const composed = composeContinuePrompt({
  attempt: 1,
  max: 3,
  openTodoCount: 1,
  openTodoTitles: ["recon"],
  kind: "empty",
});
assert.ok(composed.includes("### Continue"));
assert.ok(composed.includes("### This-run todo"));
assert.ok(!composed.includes("<system-injection>"));
assert.ok(!composed.includes("<system-reminder>"));

const goalBody = buildGoalContinuationPrompt(
  {
    id: "g1",
    objective: "maximize coverage",
    status: "active",
    tokensUsed: 10,
    createdAt: "t",
    updatedAt: "t",
    subagentIds: [],
    lastBookedFindingCount: 0,
    lastEvidenceCount: 0,
    segmentsWithoutProgress: 0,
    goalContinueCount: 0,
  },
  { openTodoCount: 0 },
);
assert.ok(goalBody.includes("### Continue"));
assert.ok(goalBody.includes("**Objective**"));
assert.ok(goalBody.includes("goal_continuation"));
assert.ok(!goalBody.includes("<system-injection>"));
assert.ok(!goalBody.includes("<todo_context>"));

const budget = buildGoalBudgetLimitPrompt({
  id: "g1",
  objective: "wrap up",
  status: "budget-limited",
  tokensUsed: 99,
  tokenBudget: 100,
  createdAt: "t",
  updatedAt: "t",
  subagentIds: [],
  lastBookedFindingCount: 0,
  lastEvidenceCount: 0,
  segmentsWithoutProgress: 0,
  goalContinueCount: 1,
});
assert.ok(budget.includes("### Continue"));
assert.ok(budget.includes("token budget"));
assert.ok(!budget.includes("<system-injection>"));

assert.ok(midRunTodoNudge(2).startsWith("### This-run todo"));
assert.ok(!midRunTodoNudge(2).includes("<system-reminder>"));
assert.ok(
  midRunBookingNudge({ evidenceCount: 3, bookedFindingCount: 0, toolsInLastSegment: 2 }).startsWith(
    "### This-run booking",
  ),
);
assert.ok(midRunNewUntestedSurfaceNudge(2).startsWith("### Surface"));

console.log("harness-channel.test.ts: ok");
