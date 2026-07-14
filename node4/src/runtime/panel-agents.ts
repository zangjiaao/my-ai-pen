/**
 * Lightweight main + subagent roster for platform right-panel collaboration tree
 * (checkpoint.panel_agents / Node2-compatible shape).
 */

export type PanelAgentRecord = {
  id: string;
  name: string;
  status: string;
  parent_id: string | null;
  task: string;
  skills: string[];
  pending_count: number;
  role: string;
  current_tool?: string;
  current_action?: string;
  outcome?: string;
  error?: string;
  goal_id?: string;
};

export class PanelAgentTracker {
  private readonly children = new Map<string, PanelAgentRecord>();
  private mainTask: string;
  private mainName: string;
  private mainStatus = "running";
  private activeTool = "";
  private phase = "starting";

  constructor(mainTask: string, mainName?: string) {
    this.mainTask = (mainTask || "Authorized security task").slice(0, 240);
    // Prefer product expert persona over generic "Main Agent" / node labels.
    this.mainName = (mainName || "Expert").trim().slice(0, 64) || "Expert";
  }

  setMainPhase(phase: string, activeTool?: string): void {
    this.phase = phase;
    if (activeTool !== undefined) this.activeTool = activeTool;
  }

  setMainTerminal(status: "completed" | "failed" | "aborted"): void {
    this.mainStatus = status === "aborted" ? "stopped" : status;
  }

  noteSubagentStart(input: { id: string; assignment: string; goalId?: string }): void {
    this.children.set(input.id, {
      id: input.id,
      name: `Subagent ${input.id.slice(0, 12)}`,
      status: "running",
      parent_id: "node4-main",
      task: input.assignment.slice(0, 240),
      skills: [],
      pending_count: 0,
      role: "subagent",
      current_action: "running",
      goal_id: input.goalId,
    });
  }

  noteSubagentEnd(input: { id: string; ok: boolean; summary?: string }): void {
    const prev = this.children.get(input.id);
    const status = input.ok ? "completed" : "failed";
    this.children.set(input.id, {
      id: input.id,
      name: prev?.name || `Subagent ${input.id.slice(0, 12)}`,
      status,
      parent_id: "node4-main",
      task: prev?.task || "",
      skills: [],
      pending_count: 0,
      role: "subagent",
      current_action: status,
      outcome: status,
      error: input.ok ? undefined : (input.summary || "failed").slice(0, 240),
      goal_id: prev?.goal_id,
    });
  }

  list(options?: { terminal?: boolean }): PanelAgentRecord[] {
    const mainStatus = options?.terminal
      ? this.mainStatus === "running"
        ? "completed"
        : this.mainStatus
      : this.mainStatus;
    const main: PanelAgentRecord = {
      id: "node4-main",
      name: this.mainName,
      status: mainStatus,
      parent_id: null,
      task: this.mainTask,
      skills: [],
      pending_count: 0,
      role: "main",
      current_tool: this.activeTool,
      current_action: this.phase,
    };
    return [main, ...this.children.values()];
  }
}
