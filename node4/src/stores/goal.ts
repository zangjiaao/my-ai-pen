/**
 * OMP-style goal mode (clean-room): one persistent objective + status machine.
 *
 * While status is "active", the session-runner injects goal-continuation after
 * natural stops — **unbounded** (no default continue count).
 * Optional token_budget → "budget-limited" stops auto-continue (soft stop).
 *
 * complete is OMP-free in code (active | budget-limited may complete). Honesty is
 * steered by continuation / active / budget-limit prompts, not hard field gates.
 * Optional lab gates remain via NODE4_GOAL_REQUIRE_CLEARANCE=1.
 */

export type GoalModeStatus = "active" | "paused" | "budget-limited" | "complete" | "dropped";

/** Single long-task goal (OMP Goal shape, simplified). */
export type ModeGoal = {
  id: string;
  objective: string;
  status: GoalModeStatus;
  tokenBudget?: number;
  tokensUsed: number;
  createdAt: string;
  updatedAt: string;
  subagentIds: string[];
  /** Booked findings observed at last noteSegmentProgress. */
  lastBookedFindingCount: number;
  lastEvidenceCount: number;
  /** Consecutive segments with no growth in findings (and no big evidence jump). */
  segmentsWithoutProgress: number;
  /** How many goal_continuation injects the harness has already done (telemetry). */
  goalContinueCount: number;
};

export type GoalSnapshot = {
  mode: ModeGoal | null;
  openCount: number;
  goals: ModeGoal[];
  progress?: {
    lastBookedFindingCount: number;
    lastEvidenceCount: number;
    segmentsWithoutProgress: number;
    goalContinueCount: number;
    canComplete: boolean;
    completeBlockers: string[];
  };
};

export type CompleteAttempt = {
  id?: string;
  /** Optional audit notes (prompt-steered; hard-required only if lab clearance env on). */
  auditNotes?: string;
  /** Optional recon remaining count (same). */
  remainingUnsolved?: number;
  /** Tests only — bypass optional lab gates. */
  force?: boolean;
};

export type CompleteResult =
  | { ok: true; goal: ModeGoal }
  | { ok: false; error: string; blockers: string[]; goal: ModeGoal | null };

/**
 * Optional lab-only complete gates. OMP default = free complete (all zeros / off).
 * Set NODE4_GOAL_REQUIRE_CLEARANCE=1 to re-enable product maximize field gates.
 */
export function goalCompleteGatesFromEnv(): {
  minGoalContinues: number;
  minStalls: number;
  minAuditChars: number;
  requireClearanceFields: boolean;
} {
  const requireClearanceRaw = process.env.NODE4_GOAL_REQUIRE_CLEARANCE;
  const requireClearanceFields =
    requireClearanceRaw != null &&
    requireClearanceRaw !== "" &&
    ["1", "true", "on", "yes"].includes(requireClearanceRaw.toLowerCase());
  return {
    minGoalContinues: Math.max(0, Number(process.env.NODE4_GOAL_MIN_CONTINUES ?? 0)),
    minStalls: Math.max(0, Number(process.env.NODE4_GOAL_MIN_STALLS ?? 0)),
    minAuditChars: Math.max(20, Number(process.env.NODE4_GOAL_MIN_AUDIT_CHARS ?? 120)),
    requireClearanceFields,
  };
}

let seq = 0;

export class GoalStore {
  private mode: ModeGoal | null = null;
  /** One-shot: harness should inject budget-limit steer after flip (OMP #sendBudgetLimitSteer). */
  private pendingBudgetLimitSteer = false;

  getMode(): ModeGoal | null {
    return this.mode ? { ...this.mode, subagentIds: [...this.mode.subagentIds] } : null;
  }

  /** True only when status is active — budget-limited / paused do not auto-continue. */
  isActive(): boolean {
    return this.mode?.status === "active";
  }

  /** OMP isAccountingStatus: still track tokens while active or budget-limited. */
  isAccounting(): boolean {
    return this.mode?.status === "active" || this.mode?.status === "budget-limited";
  }

  create(input: { objective: string; tokenBudget?: number; id?: string }): ModeGoal {
    const objective = input.objective.trim();
    if (!objective) throw new Error("objective is required");
    if (this.mode && this.mode.status !== "complete" && this.mode.status !== "dropped") {
      throw new Error("cannot create a new goal because this session already has a goal");
    }
    const now = new Date().toISOString();
    const id = input.id?.trim() || `goal_${Date.now()}_${++seq}`;
    const budget = input.tokenBudget;
    if (budget !== undefined && (!Number.isFinite(budget) || budget <= 0)) {
      throw new Error("token_budget must be a positive number when provided");
    }
    this.mode = {
      id,
      objective,
      status: "active",
      tokenBudget: budget,
      tokensUsed: 0,
      createdAt: now,
      updatedAt: now,
      subagentIds: [],
      lastBookedFindingCount: 0,
      lastEvidenceCount: 0,
      segmentsWithoutProgress: 0,
      goalContinueCount: 0,
    };
    this.pendingBudgetLimitSteer = false;
    return this.getMode()!;
  }

  get(id?: string): ModeGoal | undefined {
    if (!this.mode) return undefined;
    if (id && this.mode.id !== id) return undefined;
    return this.getMode()!;
  }

  /**
   * Call after each agent segment with product progress metrics.
   * Resets stall counter when findings grow; otherwise increments stall.
   */
  noteSegmentProgress(input: {
    bookedFindings: number;
    evidenceCount: number;
    toolsInSegment: number;
    goalContinueCount?: number;
  }): void {
    if (!this.mode || !this.isAccounting()) return;
    const booked = Math.max(0, Math.floor(input.bookedFindings));
    const evidence = Math.max(0, Math.floor(input.evidenceCount));
    if (input.goalContinueCount != null) {
      this.mode.goalContinueCount = Math.max(0, Math.floor(input.goalContinueCount));
    }
    const findingGrowth = booked > this.mode.lastBookedFindingCount;
    const evidenceGrowth = evidence >= this.mode.lastEvidenceCount + 3;
    if (findingGrowth || evidenceGrowth) {
      this.mode.segmentsWithoutProgress = 0;
    } else if (input.toolsInSegment > 0 || this.mode.goalContinueCount > 0) {
      this.mode.segmentsWithoutProgress += 1;
    }
    this.mode.lastBookedFindingCount = Math.max(this.mode.lastBookedFindingCount, booked);
    this.mode.lastEvidenceCount = Math.max(this.mode.lastEvidenceCount, evidence);
    this.mode.updatedAt = new Date().toISOString();
  }

  setGoalContinueCount(n: number): void {
    if (!this.mode) return;
    this.mode.goalContinueCount = Math.max(0, Math.floor(n));
    this.mode.updatedAt = new Date().toISOString();
  }

  /**
   * OMP-style token accounting. When tokenBudget is set and tokensUsed >= budget,
   * flips to budget-limited and queues a one-shot budget-limit steer.
   * @returns true if this call flipped status to budget-limited
   */
  addTokensUsed(delta: number): boolean {
    if (!this.mode || !this.isAccounting()) return false;
    const n = Math.max(0, Math.floor(Number(delta) || 0));
    if (n <= 0) return false;
    this.mode.tokensUsed += n;
    this.mode.updatedAt = new Date().toISOString();
    if (
      this.mode.tokenBudget !== undefined &&
      this.mode.tokensUsed >= this.mode.tokenBudget &&
      this.mode.status === "active"
    ) {
      this.mode.status = "budget-limited";
      this.pendingBudgetLimitSteer = true;
      return true;
    }
    return false;
  }

  /** Take one-shot budget-limit steer payload (OMP #sendBudgetLimitSteer). */
  takePendingBudgetLimitSteer(): ModeGoal | null {
    if (!this.pendingBudgetLimitSteer || !this.mode || this.mode.status !== "budget-limited") {
      return null;
    }
    this.pendingBudgetLimitSteer = false;
    return this.getMode()!;
  }

  /** Optional raise/clear budget (OMP setBudget). May re-activate from budget-limited. */
  setTokenBudget(budget: number | undefined): ModeGoal | undefined {
    if (!this.mode) return undefined;
    if (budget !== undefined && (!Number.isFinite(budget) || budget <= 0)) {
      throw new Error("token_budget must be a positive number when provided");
    }
    this.mode.tokenBudget = budget;
    this.mode.updatedAt = new Date().toISOString();
    if (budget !== undefined && this.mode.tokensUsed >= budget) {
      if (this.mode.status === "active") {
        this.mode.status = "budget-limited";
        this.pendingBudgetLimitSteer = true;
      }
    } else if (this.mode.status === "budget-limited") {
      this.mode.status = "active";
      this.pendingBudgetLimitSteer = false;
    }
    return this.getMode()!;
  }

  /**
   * OMP-style complete blockers: only status machine errors by default.
   * Optional lab clearance fields when NODE4_GOAL_REQUIRE_CLEARANCE=1.
   */
  completeBlockers(opts?: CompleteAttempt): string[] {
    const g = this.mode;
    if (!g) return ["no active goal"];
    if (g.status === "complete") return ["goal already complete"];
    if (g.status === "dropped") return ["goal was dropped"];
    if (g.status === "paused") return ["goal is paused — resume first"];
    // active and budget-limited may complete (OMP).
    if (opts?.force) return [];

    const gates = goalCompleteGatesFromEnv();
    const blockers: string[] = [];
    if (gates.minGoalContinues > 0 && g.goalContinueCount < gates.minGoalContinues) {
      blockers.push(
        `need at least ${gates.minGoalContinues} harness goal_continuation(s) before complete (have ${g.goalContinueCount})`,
      );
    }
    if (gates.minStalls > 0 && g.segmentsWithoutProgress < gates.minStalls) {
      blockers.push(
        `need ${gates.minStalls} consecutive no-progress segments (have ${g.segmentsWithoutProgress})`,
      );
    }
    if (gates.requireClearanceFields) {
      const audit = String(opts?.auditNotes || "").trim();
      if (audit.length < gates.minAuditChars) {
        blockers.push(
          `audit_notes required (≥${gates.minAuditChars} chars) — lab clearance mode (NODE4_GOAL_REQUIRE_CLEARANCE)`,
        );
      }
      if (opts?.remainingUnsolved == null || !Number.isFinite(Number(opts.remainingUnsolved))) {
        blockers.push("remaining_unsolved is required (lab clearance mode)");
      } else if (Number(opts.remainingUnsolved) > 0) {
        blockers.push(`remaining_unsolved=${opts.remainingUnsolved} > 0 (lab clearance mode)`);
      }
    }
    return blockers;
  }

  tryComplete(opts?: CompleteAttempt): CompleteResult {
    if (!this.mode) return { ok: false, error: "no active goal to complete", blockers: ["no active goal"], goal: null };
    if (opts?.id && this.mode.id !== opts.id) {
      return { ok: false, error: "goal id mismatch", blockers: ["goal id mismatch"], goal: this.getMode() };
    }
    if (this.mode.status === "complete") {
      return {
        ok: false,
        error: "goal status is complete",
        blockers: ["status=complete"],
        goal: this.getMode(),
      };
    }
    if (this.mode.status === "dropped") {
      return {
        ok: false,
        error: "goal status is dropped",
        blockers: ["status=dropped"],
        goal: this.getMode(),
      };
    }
    if (this.mode.status === "paused") {
      return {
        ok: false,
        error: "goal status is paused",
        blockers: ["status=paused"],
        goal: this.getMode(),
      };
    }
    const blockers = this.completeBlockers(opts);
    if (blockers.length) {
      return {
        ok: false,
        error: `complete rejected: ${blockers[0]}`,
        blockers,
        goal: this.getMode(),
      };
    }
    this.mode.status = "complete";
    this.mode.updatedAt = new Date().toISOString();
    this.pendingBudgetLimitSteer = false;
    return { ok: true, goal: this.getMode()! };
  }

  /** @deprecated prefer tryComplete — force path for tests */
  complete(id?: string): ModeGoal | undefined {
    const r = this.tryComplete({ id, force: true });
    return r.ok ? r.goal : undefined;
  }

  drop(id?: string): ModeGoal | undefined {
    if (!this.mode) return undefined;
    if (id && this.mode.id !== id) return undefined;
    this.mode.status = "dropped";
    this.mode.updatedAt = new Date().toISOString();
    this.pendingBudgetLimitSteer = false;
    return this.getMode()!;
  }

  pause(): ModeGoal | undefined {
    if (!this.mode || this.mode.status !== "active") return this.getMode() ?? undefined;
    this.mode.status = "paused";
    this.mode.updatedAt = new Date().toISOString();
    return this.getMode()!;
  }

  resume(): ModeGoal | undefined {
    if (!this.mode) return undefined;
    if (this.mode.status === "complete") throw new Error("Goal is already complete");
    if (this.mode.status === "dropped") throw new Error("Goal was dropped");
    if (this.mode.tokenBudget !== undefined && this.mode.tokensUsed >= this.mode.tokenBudget) {
      this.mode.status = "budget-limited";
    } else {
      this.mode.status = "active";
    }
    this.mode.updatedAt = new Date().toISOString();
    return this.getMode()!;
  }

  attachSubagent(goalId: string, subagentId: string): ModeGoal | undefined {
    if (!this.mode || this.mode.id !== goalId) return undefined;
    if (!this.mode.subagentIds.includes(subagentId)) this.mode.subagentIds.push(subagentId);
    this.mode.updatedAt = new Date().toISOString();
    return this.getMode()!;
  }

  list(): ModeGoal[] {
    return this.mode ? [this.getMode()!] : [];
  }

  snapshot(): GoalSnapshot {
    const mode = this.getMode();
    const structural = mode ? this.completeBlockers({ force: false }) : ["no active goal"];
    return {
      mode,
      openCount:
        mode?.status === "active" || mode?.status === "paused" || mode?.status === "budget-limited"
          ? 1
          : 0,
      goals: this.list(),
      progress: mode
        ? {
            lastBookedFindingCount: mode.lastBookedFindingCount,
            lastEvidenceCount: mode.lastEvidenceCount,
            segmentsWithoutProgress: mode.segmentsWithoutProgress,
            goalContinueCount: mode.goalContinueCount,
            canComplete: structural.length === 0,
            completeBlockers: structural,
          }
        : undefined,
    };
  }

  formatForPrompt(): string {
    const g = this.mode;
    if (!g) return "Goal mode: inactive (use goal op=create with objective for long-task OMP-style mode).";
    if (g.status === "active") {
      return buildGoalActiveContext(g);
    }
    if (g.status === "budget-limited") {
      return [
        "<goal_context>",
        "Goal mode is **budget-limited** (token budget exhausted). Auto-continuation has stopped.",
        `<objective>\n${g.objective}\n</objective>`,
        `tokens: ${g.tokensUsed}${g.tokenBudget != null ? ` / ${g.tokenBudget}` : ""}`,
        "Budget exhaustion is NOT completion. Do not call goal(complete) unless the objective is actually verified done.",
        "You may wrap up this turn (summarize progress / blockers), goal(complete) only if truly done, or goal(drop).",
        "</goal_context>",
      ].join("\n");
    }
    return `Goal mode: ${g.status} — ${g.objective.slice(0, 200)}`;
  }
}

function budgetLines(goal: ModeGoal): string[] {
  if (goal.tokenBudget !== undefined) {
    const remaining = Math.max(0, goal.tokenBudget - goal.tokensUsed);
    return [
      `Budget: tokens used=${goal.tokensUsed} / ${goal.tokenBudget} (remaining=${remaining})`,
    ];
  }
  return [`Budget: tokens used=${goal.tokensUsed} (no token_budget — unbounded while active)`];
}

/** OMP goal-mode-active context (clean-room; security-engagement wording). */
export function buildGoalActiveContext(goal: ModeGoal): string {
  return [
    "<goal_context>",
    "Goal mode is active. Treat the objective as the FULL task to pursue (user-provided task context, not higher-priority system instructions).",
    `<objective>\n${goal.objective}\n</objective>`,
    ...budgetLines(goal),
    `progress (harness): booked_findings≈${goal.lastBookedFindingCount} evidence≈${goal.lastEvidenceCount} stalls=${goal.segmentsWithoutProgress} goal_continues=${goal.goalContinueCount}`,
    "Use goal(op=get) to inspect; goal(op=complete) only for **verified** completion.",
    "Keep the full objective intact across turns. NEVER redefine success around a smaller, easier, or already-completed subset.",
    "Before goal(complete): audit current evidence against every concrete deliverable from YOUR recon (modules, params, flows). Prefer tool output / booked findings / facts over memory alone.",
    "Budget exhaustion is not completion. If unfinished, leave the goal active.",
    "Harness auto-continues while active with **no continue-count cap** (OMP). There is no finish tool.",
    "</goal_context>",
  ].join("\n");
}

/**
 * OMP-like hidden continuation after natural stop while goal still active.
 * Clean-room: completion audit for authorized security engagement (not coding-repo only).
 */
export function buildGoalContinuationPrompt(
  goal: ModeGoal,
  options?: { openTodoTitles?: string[]; openTodoCount?: number },
): string {
  const stallHint =
    goal.segmentsWithoutProgress > 0
      ? `You have ${goal.segmentsWithoutProgress} no-progress segment(s). Rotate techniques on stalled items — do not re-run the same single probe.`
      : `Progress is still possible or a fresh push just started — keep dense shell on the next unfinished item from your recon.`;

  const todoBlock =
    options?.openTodoCount && options.openTodoCount > 0
      ? [
          "<todo_context>",
          `Open todos: ${options.openTodoCount}. Treat as live progress state, not decoration.`,
          ...(options.openTodoTitles || []).slice(0, 12).map((t) => `- [open] ${t}`),
          "If a todo is stale or done, update todo before claiming phase complete. Map-complete ≠ discovery complete.",
          "</todo_context>",
        ]
      : options?.openTodoCount === 0
        ? [
            "<todo_context>",
            "Todo map shows no open items — that does NOT mean every recon surface was tested. Re-check your notes/facts for untested modules.",
            "</todo_context>",
          ]
        : [];

  return [
    `<system-injection customType="goal-continuation">`,
    `Continue work on the active goal (harness goal_continuation #${goal.goalContinueCount + 1}).`,
    `<objective>`,
    goal.objective,
    `</objective>`,
    ...budgetLines(goal),
    `Progress so far (harness): booked_findings≈${goal.lastBookedFindingCount}, evidence≈${goal.lastEvidenceCount}, no_progress_segments=${goal.segmentsWithoutProgress}.`,
    stallHint,
    ...todoBlock,
    ``,
    `This is an autonomous continuation. The objective persists across turns; NEVER redefine success around a smaller, easier, or already-completed subset.`,
    ``,
    `Before calling goal(op=complete), you MUST perform a completion audit against **current** evidence:`,
    `1) Restate the objective as concrete deliverables (modules/challenges/surfaces from YOUR recon — not invented answer keys).`,
    `2) Map each deliverable to evidence: tool stdout/body, finding(confirm) proofs, facts, scripts under the task dir.`,
    `3) Inspect actual current state — re-check notes/facts/findings. NEVER rely only on memory of earlier turns.`,
    `4) Match verification scope to claim scope. One easy module booked does not prove full-surface maximize objectives.`,
    `5) Treat uncertainty as not-yet-achieved. Partial coverage or "looks done" without inspection → keep working.`,
    `6) Budget exhaustion is not completion. NEVER complete merely because tokens are low.`,
    ``,
    `Call goal(op=complete) only when every deliverable has direct, current evidence. The completion call ends autonomous goal continuation.`,
    `If unfinished: keep working with dense shell (multi-step / multi-call same turn). Book proven issues with finding(confirm)+proof. Do NOT only narrate.`,
    `There is no finish tool. Harness keeps auto-continuing while goal is active (no continue-count cap).`,
    `</system-injection>`,
  ].join("\n");
}

/** OMP goal-budget-limit steer (clean-room). */
export function buildGoalBudgetLimitPrompt(goal: ModeGoal): string {
  return [
    `<system-injection customType="goal-budget-limit">`,
    `The active goal has reached its token budget.`,
    `<objective>`,
    goal.objective,
    `</objective>`,
    `Budget: tokens used=${goal.tokensUsed}${goal.tokenBudget != null ? ` / ${goal.tokenBudget}` : ""}.`,
    `The runtime marked the goal as budget-limited. NEVER start new substantive work for this goal.`,
    `Wrap up this turn soon: summarize useful progress, identify remaining work or blockers, and leave a clear next step.`,
    `Budget exhaustion is NOT completion. NEVER call goal(op=complete) unless current evidence proves the goal is actually complete.`,
    `</system-injection>`,
  ].join("\n");
}
