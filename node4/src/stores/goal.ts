/**
 * Thin session-scoped goals for long-task anchoring (not a settlement hard gate).
 */

export type GoalStatus = "open" | "done" | "dropped";

export type Goal = {
  id: string;
  title: string;
  status: GoalStatus;
  detail?: string;
  /** Subagent ids working this goal (soft link). */
  subagentIds: string[];
  createdAt: string;
  updatedAt: string;
};

export type GoalSnapshot = {
  goals: Goal[];
  openCount: number;
};

let seq = 0;

export class GoalStore {
  private goals = new Map<string, Goal>();

  create(input: { title: string; detail?: string; id?: string }): Goal {
    const now = new Date().toISOString();
    const id = input.id?.trim() || `goal_${Date.now()}_${++seq}`;
    const goal: Goal = {
      id,
      title: input.title.trim() || id,
      status: "open",
      detail: input.detail,
      subagentIds: [],
      createdAt: now,
      updatedAt: now,
    };
    this.goals.set(id, goal);
    return { ...goal, subagentIds: [...goal.subagentIds] };
  }

  get(id: string): Goal | undefined {
    const g = this.goals.get(id);
    return g ? { ...g, subagentIds: [...g.subagentIds] } : undefined;
  }

  update(id: string, patch: { title?: string; detail?: string; status?: GoalStatus }): Goal | undefined {
    const g = this.goals.get(id);
    if (!g) return undefined;
    if (patch.title != null) g.title = patch.title.trim() || g.title;
    if (patch.detail != null) g.detail = patch.detail;
    if (patch.status) g.status = patch.status;
    g.updatedAt = new Date().toISOString();
    return this.get(id);
  }

  attachSubagent(goalId: string, subagentId: string): Goal | undefined {
    const g = this.goals.get(goalId);
    if (!g) return undefined;
    if (!g.subagentIds.includes(subagentId)) g.subagentIds.push(subagentId);
    g.updatedAt = new Date().toISOString();
    return this.get(goalId);
  }

  list(): Goal[] {
    return [...this.goals.values()].map((g) => ({ ...g, subagentIds: [...g.subagentIds] }));
  }

  snapshot(): GoalSnapshot {
    const goals = this.list();
    return {
      goals,
      openCount: goals.filter((g) => g.status === "open").length,
    };
  }

  /** Prompt-facing summary (survives continue; compaction-oriented snapshot). */
  formatForPrompt(): string {
    const open = this.list().filter((g) => g.status === "open");
    if (!open.length) return "Goals: none open (settlement does not require empty goals).";
    const lines = ["Active goals (long-task anchors; do not treat as finish gates):"];
    for (const g of open) {
      lines.push(`- [${g.id}] ${g.title}${g.detail ? ` — ${g.detail}` : ""}`);
    }
    return lines.join("\n");
  }
}
