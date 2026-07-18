import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ToolRuntime } from "../types.js";
import { jsonResult, textResult } from "./common.js";

/**
 * OMP-style goal tool: create / get / complete / drop / resume / pause / list.
 * Auto-continue unbounded while active; optional token_budget → budget-limited.
 * complete is free in code (OMP); honesty is prompt-steered on continuations.
 */
export function createGoalTool(runtime: ToolRuntime): ToolDefinition<any> {
  return {
    name: "goal",
    label: "Goal",
    description: [
      "OMP-style long-task goal mode (single active objective).",
      "Ops: create|get|complete|drop|resume|pause|list.",
      "create: objective (required), token_budget? (optional soft stop — when exhausted status becomes budget-limited and auto-continue stops).",
      "While active the harness auto-continues after natural stops with **no default continue count** (OMP).",
      "complete: only when the objective is actually verified done against current evidence — NEVER because a budget is low or a turn is ending.",
      "Budget exhaustion is not completion. Do not drop a maximize objective to soft-exit partial progress.",
    ].join(" "),
    parameters: Type.Object({
      op: Type.String(),
      objective: Type.Optional(Type.String()),
      title: Type.Optional(Type.String()),
      id: Type.Optional(Type.String()),
      token_budget: Type.Optional(Type.Number()),
      detail: Type.Optional(Type.String()),
      status: Type.Optional(Type.String()),
      /** Optional notes; not required for complete (OMP free complete). */
      audit_notes: Type.Optional(Type.String()),
      /** Optional recon remaining count; not required for complete by default. */
      remaining_unsolved: Type.Optional(Type.Number()),
    }),
    async execute(_id: string, params: any) {
      const op = String(params.op || "list").trim().toLowerCase();
      const goals = runtime.goals;

      if (op === "list" || op === "view" || op === "get") {
        return jsonResult({
          ok: true,
          ...goals.snapshot(),
          summary: goals.formatForPrompt(),
          active: goals.isActive(),
        });
      }

      if (op === "create") {
        const objective = String(params.objective || params.title || params.detail || "").trim();
        if (!objective) return textResult("error: objective required for create");
        try {
          const g = goals.create({
            objective,
            tokenBudget: params.token_budget != null ? Number(params.token_budget) : undefined,
          });
          await runtime.platform.send({
            type: "goal_updated",
            conversation_id: runtime.task.conversationId,
            task_id: runtime.task.taskId,
            op: "create",
            goal: g,
            open_count: goals.snapshot().openCount,
          });
          return jsonResult({
            ok: true,
            goal: g,
            summary: goals.formatForPrompt(),
            guidance:
              "Goal active. Harness auto-continues while active (unbounded OMP). Optional token_budget is the soft stop. Call complete only after a real completion audit against current evidence.",
          });
        } catch (e) {
          return textResult(`error: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      if (op === "complete") {
        const result = goals.tryComplete({
          id: params.id != null ? String(params.id) : undefined,
          auditNotes: params.audit_notes != null ? String(params.audit_notes) : undefined,
          remainingUnsolved:
            params.remaining_unsolved != null ? Number(params.remaining_unsolved) : undefined,
        });
        if (!result.ok) {
          await runtime.platform.send({
            type: "goal_updated",
            conversation_id: runtime.task.conversationId,
            task_id: runtime.task.taskId,
            op: "complete_rejected",
            blockers: result.blockers,
            goal: result.goal,
            open_count: goals.snapshot().openCount,
          });
          return jsonResult(
            {
              ok: false,
              error: result.error,
              blockers: result.blockers,
              progress: goals.snapshot().progress,
              summary: goals.formatForPrompt(),
              guidance:
                "COMPLETE REJECTED. Keep working remaining items from YOUR recon with dense shell. Do not shrink the objective; do not only narrate.",
            },
            { isError: true },
          );
        }
        await runtime.platform.send({
          type: "goal_updated",
          conversation_id: runtime.task.conversationId,
          task_id: runtime.task.taskId,
          op: "complete",
          goal: result.goal,
          open_count: 0,
        });
        return jsonResult({
          ok: true,
          goal: result.goal,
          summary: goals.formatForPrompt(),
          guidance: "Goal complete accepted. Auto-continuation stops.",
        });
      }

      if (op === "drop") {
        const g = goals.drop(params.id != null ? String(params.id) : undefined);
        if (!g) return textResult("error: no goal to drop");
        await runtime.platform.send({
          type: "goal_updated",
          conversation_id: runtime.task.conversationId,
          task_id: runtime.task.taskId,
          op: "drop",
          goal: g,
          open_count: 0,
        });
        return jsonResult({ ok: true, goal: g, summary: goals.formatForPrompt() });
      }

      if (op === "pause") {
        const g = goals.pause();
        if (!g) return textResult("error: no active goal to pause");
        await runtime.platform.send({
          type: "goal_updated",
          conversation_id: runtime.task.conversationId,
          task_id: runtime.task.taskId,
          op: "pause",
          goal: g,
        });
        return jsonResult({ ok: true, goal: g, summary: goals.formatForPrompt() });
      }

      if (op === "resume") {
        try {
          const g = goals.resume();
          if (!g) return textResult("error: no goal to resume");
          await runtime.platform.send({
            type: "goal_updated",
            conversation_id: runtime.task.conversationId,
            task_id: runtime.task.taskId,
            op: "resume",
            goal: g,
          });
          return jsonResult({ ok: true, goal: g, summary: goals.formatForPrompt() });
        } catch (e) {
          return textResult(`error: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      if (op === "update") {
        const status = params.status != null ? String(params.status).toLowerCase() : "";
        if (status === "done" || status === "complete") {
          const result = goals.tryComplete({
            id: params.id != null ? String(params.id) : undefined,
            auditNotes: params.audit_notes != null ? String(params.audit_notes) : undefined,
            remainingUnsolved:
              params.remaining_unsolved != null ? Number(params.remaining_unsolved) : undefined,
          });
          if (!result.ok) {
            return jsonResult(
              {
                ok: false,
                error: result.error,
                blockers: result.blockers,
                summary: goals.formatForPrompt(),
                guidance: "COMPLETE REJECTED — keep working remaining recon items with dense shell.",
              },
              { isError: true },
            );
          }
          return jsonResult({ ok: true, goal: result.goal, summary: goals.formatForPrompt() });
        }
        if (status === "dropped" || status === "drop") {
          const g = goals.drop(params.id != null ? String(params.id) : undefined);
          if (!g) return textResult("error: no goal");
          return jsonResult({ ok: true, goal: g, summary: goals.formatForPrompt() });
        }
        return textResult("error: update supports status=complete|dropped; prefer complete/drop ops");
      }

      return textResult("error: op must be create|get|complete|drop|resume|pause|list");
    },
  };
}
