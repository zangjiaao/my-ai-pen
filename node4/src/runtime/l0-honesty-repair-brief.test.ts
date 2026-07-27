/**
 * NC-Honesty-Advance #184 / #185 helpers.
 * Run: npx tsx src/runtime/l0-honesty-repair-brief.test.ts
 */
import assert from "node:assert/strict";
import {
  formatL0RepairBrief,
  isBookingOnlyStage,
  isHonestyCannotAdvanceErrors,
} from "./l0-honesty-repair-brief.js";
import {
  evaluateStageGate,
  runHardGraph,
  type HardGraphStageEvent,
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
  assert.match(brief, /prior_failed_attempt: 1/);
}

// --- formatL0RepairBrief booking_tail mode (no fake prior_failed_attempt) ---
{
  const brief = formatL0RepairBrief({
    stageId: "validate_book",
    failedAttempt: 0,
    mode: "booking_tail",
    errors: [
      "upstream_stage_blocked:authz_logic",
      "booking_only_tail: confirm remaining feedback_ok",
    ],
  });
  assert.match(brief, /booking-only tail|booking_only_tail/i);
  assert.match(brief, /upstream/);
  assert.match(brief, /stage_id: validate_book/);
  assert.doesNotMatch(brief, /prior_failed_attempt/);
  assert.doesNotMatch(brief, /cannot_advance: true/);
}

// --- isHonestyCannotAdvanceErrors ---
assert.equal(
  isHonestyCannotAdvanceErrors(["structured_ok_false", "illegal_l2_done:pkg-x"]),
  true,
);
assert.equal(
  isHonestyCannotAdvanceErrors(["structured_ok_false", "running_package:p1"]),
  true,
);
assert.equal(
  isHonestyCannotAdvanceErrors(["surfaces_min:1:got:0"]),
  false,
  "structure-only fail is not honesty cannot-advance",
);
assert.equal(
  isHonestyCannotAdvanceErrors(["summary_required"]),
  false,
);
assert.equal(
  isHonestyCannotAdvanceErrors(["structured_ok_false"]),
  false,
  "structured_ok_false alone without honesty codes is not booking-tail trigger",
);
assert.equal(
  isHonestyCannotAdvanceErrors(["l1_budget_exhausted:refine_n=2:max=2"]),
  false,
);

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

// --- runHardGraph: L0 honesty fail → retry brief + skip probe + booking tail ---
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

  const seenBriefs: Array<{ stageId: string; attempt?: number; hasBrief: boolean; brief?: string }> = [];
  const stageEndEvents: HardGraphStageEvent[] = [];
  let probeAttempts = 0;
  let bookRan = false;

  const exec: StageExecutor = async (input) => {
    seenBriefs.push({
      stageId: input.stage.id,
      attempt: input.stageAttempt,
      hasBrief: Boolean(input.l0RepairBrief?.includes("cannot_advance") || input.l0RepairBrief?.includes("booking_only_tail")),
      brief: input.l0RepairBrief,
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
      assert.ok(
        input.l0RepairBrief?.includes("booking_only_tail") ||
          input.l0RepairBrief?.includes("upstream_stage_blocked") ||
          input.l0RepairBrief?.includes("upstream"),
      );
      assert.doesNotMatch(
        input.l0RepairBrief || "",
        /prior_failed_attempt/,
        "booking tail brief must not fake prior_failed_attempt",
      );
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
    onEvent: (e) => {
      if (e.type === "stage_end") stageEndEvents.push(e);
    },
  });

  assert.equal(result.terminal, "blocked", "process incomplete");
  assert.ok(probeAttempts >= 2, "stage max_retries gives second attempt");
  const second = seenBriefs.find((s) => s.stageId === "probe_a" && s.attempt === 2);
  assert.ok(second?.hasBrief, "second attempt gets L0 repair brief");
  assert.equal(bookRan, true, "booking-only tail ran");
  const skipped = result.stages.find((s) => s.stageId === "probe_b");
  assert.equal(skipped?.outcome, "skipped");
  const skipEvent = stageEndEvents.find((e) => e.type === "stage_end" && e.stageId === "probe_b");
  assert.equal(
    skipEvent && skipEvent.type === "stage_end" ? skipEvent.outcome : undefined,
    "skipped",
    "stage_end must emit outcome=skipped (not blocked) for skipped probes",
  );
  const book = result.stages.find((s) => s.stageId === "validate_book");
  assert.ok(book && (book.outcome === "passed" || book.outcome === "blocked"));
  // Gate unit: honesty errors distinct; failed_package is not a gate error
  const g = evaluateStageGate(
    { id: "probe_a", require: { summary: true } },
    {
      ok: false,
      summary: "x",
      summaryProvided: true,
      surfaces: [],
      candidates: [],
      facts: [],
      deadends: ["illegal_l2_done:pkg-x", "failed_package:pkg-x"],
    } as any,
  );
  assert.ok(g.ok === false && g.errors.includes("illegal_l2_done:pkg-x"));
  assert.ok(!g.errors.some((e) => e.startsWith("failed_package:")));
}

// --- P1: structure-only fail must NOT skip probes or run booking tail ---
{
  const graph: HardGraphDefinition = {
    discipline: "hard",
    id: "structure_block",
    label: "structure block",
    stages: [
      {
        id: "probe_a",
        intent: "probe",
        require: { summary: true, surfaces_min: 1 },
        max_retries: 0,
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

  const executed: string[] = [];
  const exec: StageExecutor = async (input) => {
    executed.push(input.stage.id);
    if (input.stage.id === "probe_a") {
      return {
        structured: {
          ok: true,
          summary: "no surfaces",
          summaryProvided: true,
          surfaces: [],
          candidates: [],
          facts: [],
          deadends: [],
        },
      };
    }
    throw new Error(`${input.stage.id} must not execute after structure-only block`);
  };

  const result = await runHardGraph({
    graph,
    executeStage: exec,
    availableTools: ["todo", "finding"],
  });

  assert.equal(result.terminal, "blocked");
  assert.deepEqual(executed, ["probe_a"], "no later stages executed");
  assert.equal(result.stages.length, 1, "old behavior: stop without skip/booking records");
  assert.equal(result.stages[0]?.outcome, "blocked");
  assert.ok(
    !result.stages.some((s) => s.outcome === "skipped"),
    "structure-only fail must not mark later probes skipped",
  );
  assert.ok(
    !result.stages.some((s) => s.stageId === "validate_book"),
    "structure-only fail must not run booking tail",
  );
}

// --- Review finding #1: structure-only retry must NOT inject honesty M1 brief ---
{
  const graph: HardGraphDefinition = {
    discipline: "hard",
    id: "structure_retry_no_honesty_brief",
    label: "structure retry",
    stages: [
      {
        id: "surface",
        intent: "surface",
        require: { summary: true, surfaces_min: 1 },
        max_retries: 1,
      },
    ],
  };
  const briefs: Array<{ attempt?: number; hasHonestyBrief: boolean }> = [];
  let n = 0;
  const exec: StageExecutor = async (input) => {
    n += 1;
    briefs.push({
      attempt: input.stageAttempt,
      hasHonestyBrief: Boolean(
        input.l0RepairBrief?.includes("cannot_advance") ||
          input.l0RepairBrief?.includes("Main duties (M1)"),
      ),
    });
    // Always structure-fail (ok true, no surfaces)
    return {
      structured: {
        ok: true,
        summary: "still empty",
        summaryProvided: true,
        surfaces: [],
        candidates: [],
        facts: [],
        deadends: [],
      },
    };
  };
  const result = await runHardGraph({
    graph,
    executeStage: exec,
    availableTools: ["todo"],
  });
  assert.equal(result.terminal, "blocked");
  assert.equal(n, 2, "max_retries=1 → two attempts");
  const second = briefs.find((b) => b.attempt === 2);
  assert.ok(second, "second attempt ran");
  assert.equal(
    second.hasHonestyBrief,
    false,
    "structure-only retry must not inject honesty M1 repair brief",
  );
}

// --- Honesty retry still gets repair brief ---
{
  const graph: HardGraphDefinition = {
    discipline: "hard",
    id: "honesty_retry_brief",
    label: "honesty retry",
    stages: [
      {
        id: "wave",
        intent: "probe",
        require: { summary: true },
        max_retries: 1,
      },
    ],
  };
  const briefs: boolean[] = [];
  const exec: StageExecutor = async (input) => {
    if ((input.stageAttempt || 1) === 2) {
      briefs.push(Boolean(input.l0RepairBrief?.includes("cannot_advance")));
    }
    return {
      structured: {
        ok: false,
        summary: "illegal",
        summaryProvided: true,
        surfaces: [],
        candidates: [],
        facts: [],
        deadends: ["illegal_l2_done:pkg-x"],
      },
    };
  };
  await runHardGraph({ graph, executeStage: exec, availableTools: ["todo"] });
  assert.equal(briefs[0], true, "honesty cannot-advance retry still injects repair brief");
}

// --- close-out residual class + true post-block booking_tail_ran ---
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
  assert.match(closeout.residual_risk, /booking-only tail ran after upstream block/);
  assert.ok((closeout.findings.feedback_ok_unbooked_ids || []).includes(id));
}

console.log("l0-honesty-repair-brief.test.ts: ok");
