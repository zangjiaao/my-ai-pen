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
    // Defaults favor multi-level maximize runs (CTF/DVWA tails need several outer pushes).
    minGoalContinues: Math.max(0, Number(process.env.NODE4_GOAL_MIN_CONTINUES ?? 3)),
    minStalls: Math.max(0, Number(process.env.NODE4_GOAL_MIN_STALLS ?? 3)),
    minAuditChars: Math.max(20, Number(process.env.NODE4_GOAL_MIN_AUDIT_CHARS ?? 120)),
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

  /** OMP-style: accumulate tokens from assistant turns while goal is active. */
  addTokensUsed(delta: number): void {
    if (!this.mode || this.mode.status !== "active") return;
    const n = Math.max(0, Math.floor(Number(delta) || 0));
    if (n <= 0) return;
    this.mode.tokensUsed += n;
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
        `audit_notes required (≥${gates.minAuditChars} chars): re-list every challenge/level from YOUR recon, mark solved vs blocked, and why each residual is exhausted`,
      );
    }
    if (g.goalContinueCount < gates.minGoalContinues) {
      blockers.push(
        `need at least ${gates.minGoalContinues} harness goal_continuation(s) before complete (have ${g.goalContinueCount}); keep working the FULL objective — do not shrink success to easy wins`,
      );
    }
    if (g.segmentsWithoutProgress < gates.minStalls) {
      blockers.push(
        `need ${gates.minStalls} consecutive no-progress segments after pushes (have ${g.segmentsWithoutProgress}); rotate techniques on stalled items and attack remaining levels from your recon`,
      );
    }
    // remaining_unsolved is required (agent's own recon count) — omit is not "done".
    if (opts?.remainingUnsolved == null || !Number.isFinite(Number(opts.remainingUnsolved))) {
      blockers.push(
        "remaining_unsolved is required: set to your recon count of unfinished challenges; use 0 only after every enumerated item is solved or proven blocked",
      );
    } else if (Number(opts.remainingUnsolved) > 0) {
      blockers.push(
        `remaining_unsolved=${opts.remainingUnsolved} > 0 — keep attacking remaining items from your own recon; do not complete partial maximize runs`,
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
    // Structural readiness assumes agent will supply long audit + remaining_unsolved=0.
    const structural = mode
      ? this.completeBlockers({
          auditNotes: "x".repeat(200),
          remainingUnsolved: 0,
          force: false,
        }).filter((b) => !b.startsWith("audit_notes") && !b.startsWith("remaining_unsolved"))
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
        "Goal mode is active. Treat the objective as the FULL task (do not shrink to easy wins).",
        `<objective>\n${g.objective}\n</objective>`,
        `status: active; id: ${g.id}`,
        `progress: booked_findings=${g.lastBookedFindingCount} evidence=${g.lastEvidenceCount} stalls=${g.segmentsWithoutProgress} goal_continues=${g.goalContinueCount}`,
        `complete_gates: min_goal_continues=${gates.minGoalContinues} min_stalls=${gates.minStalls} audit_chars≥${gates.minAuditChars}; remaining_unsolved must be 0`,
        blockers.length
          ? `complete_blockers_now: ${blockers.join(" | ")}`
          : "complete_gates: structural ok — still require detailed audit_notes + remaining_unsolved=0",
        "Keep attacking remaining levels/categories from YOUR recon with dense shell until every enumerated item is solved or proven blocked.",
        "goal(op=complete) requires audit_notes AND remaining_unsolved=0; incomplete maximize runs are rejected.",
        "Do not goal(drop) to soft-exit a maximize objective — finish residual levels first.",
        "Harness auto-continues while active. There is no finish tool.",
        "</goal_context>",
      ].join("\n");
    }
    return `Goal mode: ${g.status} — ${g.objective.slice(0, 200)}`;
  }
}

/** OMP-like hidden continuation after agent_end while goal still active. */
export function buildGoalContinuationPrompt(goal: ModeGoal): string {
  const stallHint =
    goal.segmentsWithoutProgress > 0
      ? `You have ${goal.segmentsWithoutProgress} no-progress segment(s). Rotate techniques on stalled challenges (encoding, auth path, alternate params, source/JS recon, multi-step shell pipelines) — do not re-run the same single probe.`
      : `Findings are still growing or a fresh push just started — keep dense shell on the next unfinished item from your recon.`;
  return [
    `<system-injection customType="goal-continuation">`,
    `Continue work on the active goal (harness goal_continuation #${goal.goalContinueCount + 1}).`,
    `<objective>`,
    goal.objective,
    `</objective>`,
    `Progress so far (harness): booked_findings≈${goal.lastBookedFindingCount}, evidence≈${goal.lastEvidenceCount}, no_progress_segments=${goal.segmentsWithoutProgress}.`,
    stallHint,
    `Mandatory this segment:`,
    `1) Mentally re-list every level/challenge you already discovered; pick ONE unfinished item and attack it with dense shell now.`,
    `2) Prefer multi-step shell pipelines and multiple shell calls in the same turn. Do not spam single http probes.`,
    `3) Book any new flag/vuln with finding(confirm)+evidence_ids immediately.`,
    `4) Do NOT call goal(complete) unless remaining_unsolved=0 after a full re-enumeration of your recon (and gates pass). Do not drop the goal to soft-exit.`,
    `NEVER redefine success around a smaller subset of easy wins. Partial clearance is not done.`,
    `If unfinished: just keep working. Do not only narrate.`,
    `There is no finish tool.`,
    `</system-injection>`,
  ].join("\n");
}
