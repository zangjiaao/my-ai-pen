/**
 * OMP-style goal mode (clean-room): one persistent objective + status machine.
 * While status is "active", the session-runner injects goal-continuation after
 * natural stops. complete() is gated so the agent cannot soft-exit maximize
 * objectives after partial progress (no target answer keys — progress is
 * measured by booked findings / evidence growth).
 */

export type GoalModeStatus = "active" | "paused" | "complete" | "dropped";

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
  /** How many goal_continuation injects the harness has already done. */
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
  /** Required non-trivial audit text unless force. */
  auditNotes?: string;
  /** Optional agent estimate of remaining unsolved items from its own recon. */
  remainingUnsolved?: number;
  /** Tests only — bypass gates. */
  force?: boolean;
};

export type CompleteResult =
  | { ok: true; goal: ModeGoal }
  | { ok: false; error: string; blockers: string[]; goal: ModeGoal | null };

/** Env-overridable gates (also used by tryComplete defaults). */
export function goalCompleteGatesFromEnv(): {
  minGoalContinues: number;
  minStalls: number;
  minAuditChars: number;
} {
  return {
    minGoalContinues: Math.max(0, Number(process.env.NODE4_GOAL_MIN_CONTINUES ?? 2)),
    minStalls: Math.max(0, Number(process.env.NODE4_GOAL_MIN_STALLS ?? 2)),
    minAuditChars: Math.max(20, Number(process.env.NODE4_GOAL_MIN_AUDIT_CHARS ?? 80)),
  };
}

let seq = 0;

export class GoalStore {
  private mode: ModeGoal | null = null;

  getMode(): ModeGoal | null {
    return this.mode ? { ...this.mode, subagentIds: [...this.mode.subagentIds] } : null;
  }

  isActive(): boolean {
    return this.mode?.status === "active";
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
    if (!this.mode || this.mode.status !== "active") return;
    const booked = Math.max(0, Math.floor(input.bookedFindings));
    const evidence = Math.max(0, Math.floor(input.evidenceCount));
    if (input.goalContinueCount != null) {
      this.mode.goalContinueCount = Math.max(0, Math.floor(input.goalContinueCount));
    }
    const findingGrowth = booked > this.mode.lastBookedFindingCount;
    // Evidence jump of 3+ without findings still counts as productive recon.
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

  /** Compute whether complete is allowed (pure helper for smokes). */
  completeBlockers(opts?: CompleteAttempt): string[] {
    const gates = goalCompleteGatesFromEnv();
    const g = this.mode;
    if (!g || g.status !== "active") return ["no active goal"];
    if (opts?.force) return [];
    const blockers: string[] = [];
    const audit = String(opts?.auditNotes || "").trim();
    if (audit.length < gates.minAuditChars) {
      blockers.push(
        `audit_notes required (≥${gates.minAuditChars} chars) listing remaining challenges/hypotheses and why each is blocked`,
      );
    }
    if (g.goalContinueCount < gates.minGoalContinues) {
      blockers.push(
        `need at least ${gates.minGoalContinues} harness goal_continuation(s) before complete (have ${g.goalContinueCount}); keep working — do not shrink the objective`,
      );
    }
    if (g.segmentsWithoutProgress < gates.minStalls) {
      blockers.push(
        `need ${gates.minStalls} consecutive no-progress segments after pushes (have ${g.segmentsWithoutProgress}); try other categories/levels with dense shell`,
      );
    }
    if (opts?.remainingUnsolved != null && Number(opts.remainingUnsolved) > 0) {
      blockers.push(
        `remaining_unsolved=${opts.remainingUnsolved} > 0 — keep attacking remaining items from your own recon`,
      );
    }
    return blockers;
  }

  tryComplete(opts?: CompleteAttempt): CompleteResult {
    if (!this.mode) return { ok: false, error: "no active goal to complete", blockers: ["no active goal"], goal: null };
    if (opts?.id && this.mode.id !== opts.id) {
      return { ok: false, error: "goal id mismatch", blockers: ["goal id mismatch"], goal: this.getMode() };
    }
    if (this.mode.status !== "active") {
      return {
        ok: false,
        error: `goal status is ${this.mode.status}`,
        blockers: [`status=${this.mode.status}`],
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
    this.mode.status = "active";
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
    const blockers = this.completeBlockers({ auditNotes: "x".repeat(200), force: false });
    // canComplete ignores audit for display — show structural readiness
    const structural = mode
      ? this.completeBlockers({ auditNotes: "x".repeat(200), force: false }).filter(
          (b) => !b.startsWith("audit_notes"),
        )
      : ["no active goal"];
    return {
      mode,
      openCount: mode?.status === "active" || mode?.status === "paused" ? 1 : 0,
      goals: this.list(),
      progress: mode
        ? {
            lastBookedFindingCount: mode.lastBookedFindingCount,
            lastEvidenceCount: mode.lastEvidenceCount,
            segmentsWithoutProgress: mode.segmentsWithoutProgress,
            goalContinueCount: mode.goalContinueCount,
            canComplete: structural.length === 0,
            completeBlockers: this.completeBlockers({ force: false }),
          }
        : undefined,
    };
  }

  formatForPrompt(): string {
    const g = this.mode;
    if (!g) return "Goal mode: inactive (use goal op=create with objective for long-task OMP-style mode).";
    if (g.status === "active") {
      const gates = goalCompleteGatesFromEnv();
      const blockers = this.completeBlockers({ force: false });
      return [
        "<goal_context>",
        "Goal mode is active. Treat the objective as the full task (do not shrink it).",
        `<objective>\n${g.objective}\n</objective>`,
        `status: active; id: ${g.id}`,
        `progress: booked_findings=${g.lastBookedFindingCount} evidence=${g.lastEvidenceCount} stalls=${g.segmentsWithoutProgress} goal_continues=${g.goalContinueCount}`,
        `complete_gates: min_goal_continues=${gates.minGoalContinues} min_stalls=${gates.minStalls} (complete rejected until gates pass + audit_notes)`,
        blockers.length
          ? `complete_blockers_now: ${blockers.join(" | ")}`
          : "complete_gates: structural ok — still require detailed audit_notes",
        "Keep attacking remaining levels/categories from YOUR recon with dense shell. NEVER redefine success around easy wins only.",
        "goal(op=complete) requires audit_notes; remaining_unsolved>0 is rejected.",
        "Harness auto-continues while active. There is no finish tool.",
        "</goal_context>",
      ].join("\n");
    }
    return `Goal mode: ${g.status} — ${g.objective.slice(0, 200)}`;
  }
}

/** OMP-like hidden continuation after agent_end while goal still active. */
export function buildGoalContinuationPrompt(goal: ModeGoal): string {
  return [
    `<system-injection customType="goal-continuation">`,
    `Continue work on the active goal (harness goal_continuation #${goal.goalContinueCount + 1}).`,
    `<objective>`,
    goal.objective,
    `</objective>`,
    `Progress so far (harness): booked_findings≈${goal.lastBookedFindingCount}, no_progress_segments=${goal.segmentsWithoutProgress}.`,
    `NEVER redefine success around a smaller subset. Keep going after remaining challenges/levels from your own enumeration.`,
    `Prefer high-density shell (multi-step pipelines; multiple shell calls same turn). Do not spam single http probes.`,
    `goal(op=complete) will be REJECTED until: (1) enough goal_continuations, (2) several no-progress segments, (3) long audit_notes, (4) remaining_unsolved is 0 or omitted.`,
    `If unfinished: just keep working. Do not only narrate. Book new flags/vulns with finding(confirm)+evidence_ids.`,
    `There is no finish tool.`,
    `</system-injection>`,
  ].join("\n");
}
