/**
 * NC-Honesty-Advance #184 / #185 helpers.
 * Run: npx tsx src/runtime/l0-honesty-repair-brief.test.ts
 */
import assert from "node:assert/strict";
import {
  formatL0RepairBrief,
  isBookingOnlyStage,
} from "./l0-honesty-repair-brief.js";
import {
  evaluateStageGate,
  runHardGraph,
  type StageExecutor,
} from "./hard-graph-runner.js";
import type { HardGraphDefinition } from "./hard-graph-definition.js";
import { stageUserPrompt } from "./hard-graph-stage-executor.js";
import type { TaskEnvelope } from "../types.js";
import { buildEngagementCloseout } from "./engagement-closeout.js";
import { FindingStore } from "./finding-store.js";

// --- formatL0RepairBrief fixed template ---
{
  const brief = formatL0RepairBrief({
    stageId: "authz_logic",
    failedAttempt: 1,
    errors: ["structured_ok_false", "illegal_l2_done:pkg-x"],
  });
  assert.match(brief, /L0 stage settlement repair brief/);
  assert.match(brief, /NC-Honesty-Advance/);
  assert.match(brief, /stage_id: authz_logic/);
  assert.match(brief, /illegal_l2_done:pkg-x/);
  assert.match(brief, /cannot_advance: true/);
  assert.match(brief, /Main duties/);
  assert.doesNotMatch(brief, /L1 Critic will refine/i);
}

// --- isBookingOnlyStage ---
assert.equal(isBookingOnlyStage({ intent: "book" }), true);
assert.equal(isBookingOnlyStage({ unbookable_on_exit: true }), true);
assert.equal(isBookingOnlyStage({ id: "validate_book" }), true);
assert.equal(isBookingOnlyStage({ intent: "probe", id: "class_probe" }), false);

// --- stageUserPrompt injects brief ---
{
  const task = {
    conversationId: "c",
    taskId: "t",
    instruction: "do work",
    target: {},
    scope: {},
  } as TaskEnvelope;
  const brief = formatL0RepairBrief({
    stageId: "wave",
    failedAttempt: 1,
    errors: ["running_package:p1"],
  });
  const user = stageUserPrompt(
    {
      stage: { id: "wave", require: { summary: true } },
      stageIndex: 0,
      graphId: "g",
      handoff: {
        surfaces: [],
        candidates: [],
        facts: [],
        deadends: [],
        completed_stages: [],
      },
      tools: ["todo"],
      toolProfile: {},
      stageAttempt: 2,
      l0RepairBrief: brief,
    },
    task,
  );
  assert.match(user, /running_package:p1/);
  assert.match(user, /cannot_advance: true/);
}

// --- runHardGraph: L0 fail retry receives brief; then mid-block skips probe + booking tail ---
{
  const graph: HardGraphDefinition = {
    discipline: "hard",
    id: "honesty_tail",
    label: "honesty tail",
    stages: [
      {
        id: "probe_a",
        intent: "probe",
        require: { summary: true },
        max_retries: 1,
      },
      {
        id: "probe_b",
        intent: "probe",
        require: { summary: true },
        max_retries: 0,
      },
      {
        id: "validate_book",
        intent: "book",
        unbookable_on_exit: true,
        require: { summary: true },
        max_retries: 0,
        tools: { allow: ["finding", "todo"] },
      },
    ],
  };

  const seenBriefs: Array<{ stageId: string; attempt?: number; hasBrief: boolean }> = [];
  let probeAttempts = 0;
  let bookRan = false;

  const exec: StageExecutor = async (input) => {
    seenBriefs.push({
      stageId: input.stage.id,
      attempt: input.stageAttempt,
      hasBrief: Boolean(input.l0RepairBrief?.includes("cannot_advance")),
    });
    if (input.stage.id === "probe_a") {
      probeAttempts += 1;
      // Always fail L0 honesty shape
      return {
        structured: {
          ok: false,
          summary: "illegal l2",
          summaryProvided: true,
          surfaces: [],
          candidates: [],
          facts: [],
          deadends: ["illegal_l2_done:pkg-x"],
        },
      };
    }
    if (input.stage.id === "probe_b") {
      throw new Error("probe_b must not run after honesty block");
    }
    if (input.stage.id === "validate_book") {
      bookRan = true;
      assert.ok(input.l0RepairBrief?.includes("booking_only_tail") || input.l0RepairBrief?.includes("upstream_stage_blocked"));
      return {
        structured: {
          ok: true,
          summary: "booked what we could",
          summaryProvided: true,
          surfaces: [],
          candidates: [],
          facts: [],
          deadends: [],
        },
      };
    }
    return { structured: { ok: true, summary: "x", summaryProvided: true } };
  };

  const result = await runHardGraph({
    graph,
    executeStage: exec,
    availableTools: ["todo", "finding", "subagent"],
  });

  assert.equal(result.terminal, "blocked", "process incomplete");
  assert.ok(probeAttempts >= 2, "stage max_retries gives second attempt");
  const second = seenBriefs.find((s) => s.stageId === "probe_a" && s.attempt === 2);
  assert.ok(second?.hasBrief, "second attempt gets L0 repair brief");
  assert.equal(bookRan, true, "booking-only tail ran");
  const skipped = result.stages.find((s) => s.stageId === "probe_b");
  assert.equal(skipped?.outcome, "skipped");
  const book = result.stages.find((s) => s.stageId === "validate_book");
  assert.ok(book && (book.outcome === "passed" || book.outcome === "blocked"));
  // Gate unit: honesty errors distinct
  const g = evaluateStageGate(
    { id: "probe_a", require: { summary: true } },
    {
      ok: false,
      summary: "x",
      summaryProvided: true,
      surfaces: [],
      candidates: [],
      facts: [],
      deadends: ["illegal_l2_done:pkg-x"],
    } as any,
  );
  assert.ok(g.ok === false && g.errors.includes("illegal_l2_done:pkg-x"));
}

// --- close-out residual class ---
{
  const store = new FindingStore();
  const { id } = store.upsert({
    title: "Keep",
    location: "http://t/k",
    severity: "high",
    proof_excerpt: "proof excerpt long enough for L0 mechanical feedback gate xx",
  });
  store.enqueueFeedback([id]);
  store.applyMechanicalL0Feedback([id]);
  assert.equal(store.get(id)?.status, "feedback_ok");

  const task = {
    conversationId: "c",
    taskId: "t",
    instruction: "i",
    target: { value: "http://t" },
    scope: {},
  } as TaskEnvelope;

  const closeout = buildEngagementCloseout({
    task,
    graphId: "app_assessment",
    terminal: "blocked",
    stages: [
      {
        stageId: "authz_logic",
        stageIndex: 4,
        attempts: 2,
        outcome: "blocked",
        errors: ["structured_ok_false", "illegal_l2_done:pkg-x"],
      },
      {
        stageId: "component",
        stageIndex: 5,
        attempts: 0,
        outcome: "skipped",
        errors: ["skipped_after_upstream_blocked"],
      },
      {
        stageId: "validate_book",
        stageIndex: 6,
        attempts: 1,
        outcome: "passed",
        errors: [],
      },
    ],
    store,
  });
  assert.equal(closeout.residual_class, "blocked_with_unbooked_feedback_ok");
  assert.equal(closeout.process_complete, false);
  assert.equal(closeout.booking_tail_ran, true);
  assert.ok(closeout.blocked_reasons?.some((r) => r.includes("illegal_l2_done")));
  assert.match(closeout.residual_risk, /process incomplete|terminal=blocked/i);
  assert.ok((closeout.findings.feedback_ok_unbooked_ids || []).includes(id));
}

console.log("l0-honesty-repair-brief.test.ts: ok");
