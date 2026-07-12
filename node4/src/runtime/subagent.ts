/**
 * Minimal clean-room subagent host: spawn → worker → structured result → evidence.
 * No OMP TUI/IRC/worktree hub. Workers are injectable for deterministic smokes.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GoalStore } from "../stores/goal.js";
import type { EvidenceStoreLike, PlatformSink, TaskEnvelope } from "../types.js";

export type SubagentResult = {
  ok: boolean;
  subagentId: string;
  summary: string;
  data: unknown;
  evidenceId?: string;
  goalId?: string;
  artifactPath?: string;
};

export type SubagentContext = {
  subagentId: string;
  assignment: string;
  goalId?: string;
  taskDir: string;
  workDir: string;
  task: TaskEnvelope;
};

export type SubagentWorker = (ctx: SubagentContext) => Promise<{ summary: string; data: unknown; ok?: boolean }>;

export type SubagentHostOptions = {
  task: TaskEnvelope;
  taskDir: string;
  evidence: EvidenceStoreLike;
  platform: PlatformSink;
  goals: GoalStore;
  /** Optional right-panel agent tree tracker. */
  panelAgents?: import("./panel-agents.js").PanelAgentTracker;
};

let subSeq = 0;

export class SubagentHost {
  constructor(private readonly opts: SubagentHostOptions) {}

  /**
   * Run a child unit of work under the task workspace contract.
   * `worker` is required for non-LLM deterministic execution; agent tools supply a default.
   */
  async spawn(options: {
    assignment: string;
    goalId?: string;
    worker: SubagentWorker;
    subagentId?: string;
  }): Promise<SubagentResult> {
    const subagentId = options.subagentId?.trim() || `sub_${Date.now()}_${++subSeq}`;
    const workDir = join(this.opts.taskDir, "subagents", subagentId);
    await mkdir(workDir, { recursive: true });

    if (options.goalId) {
      this.opts.goals.attachSubagent(options.goalId, subagentId);
    }

    await writeFile(
      join(workDir, "assignment.md"),
      `# Subagent ${subagentId}\n\n${options.assignment}\n\ngoalId: ${options.goalId || ""}\n`,
      "utf8",
    );

    this.opts.panelAgents?.noteSubagentStart({
      id: subagentId,
      assignment: options.assignment,
      goalId: options.goalId,
    });

    await this.opts.platform.send({
      type: "subagent_started",
      conversation_id: this.opts.task.conversationId,
      task_id: this.opts.task.taskId,
      subagent_id: subagentId,
      goal_id: options.goalId,
      assignment: options.assignment.slice(0, 500),
    });

    let summary = "";
    let data: unknown = null;
    let ok = true;
    try {
      const out = await options.worker({
        subagentId,
        assignment: options.assignment,
        goalId: options.goalId,
        taskDir: this.opts.taskDir,
        workDir,
        task: this.opts.task,
      });
      summary = String(out.summary || "").trim() || "subagent finished";
      data = out.data;
      ok = out.ok !== false;
    } catch (err) {
      ok = false;
      summary = err instanceof Error ? err.message : String(err);
      data = { error: summary };
    }

    const artifactPath = join(workDir, "result.json");
    const payload = {
      subagentId,
      ok,
      summary,
      data,
      goalId: options.goalId,
      finishedAt: new Date().toISOString(),
    };
    await writeFile(artifactPath, JSON.stringify(payload, null, 2), "utf8");

    const evidence = await this.opts.evidence.create({
      type: "subagent_result",
      sourceTool: "subagent",
      summary: `subagent ${subagentId}: ${summary.slice(0, 200)}`,
      data: payload,
    });

    this.opts.panelAgents?.noteSubagentEnd({ id: subagentId, ok, summary });

    await this.opts.platform.send({
      type: "subagent_finished",
      conversation_id: this.opts.task.conversationId,
      task_id: this.opts.task.taskId,
      subagent_id: subagentId,
      goal_id: options.goalId,
      ok,
      evidence_id: evidence.id,
      summary: summary.slice(0, 500),
    });

    return {
      ok,
      subagentId,
      summary,
      data,
      evidenceId: evidence.id,
      goalId: options.goalId,
      artifactPath,
    };
  }
}
