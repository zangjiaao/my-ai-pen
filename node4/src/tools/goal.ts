import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ToolRuntime } from "../types.js";
import { jsonResult, textResult } from "./common.js";

/**
 * OMP-style goal tool: create / get / complete / drop / resume / pause / list.
 * Active goal enables session-runner goal-continuation after natural stops.
 */
export function createGoalTool(runtime: ToolRuntime): ToolDefinition<any> {
  return {
    name: "goal",
    label: "Goal",
    description: [
      "OMP-style long-task goal mode (single active objective).",
      "Ops: create|get|complete|drop|resume|pause|list.",
      "create: objective (required), token_budget? (optional soft cap).",
      "complete: only after verified completion audit against current evidence.",
      "While status=active the harness may auto-continue after you stop with tools.",
      "Does NOT replace shell work; does not hard-gate settlement if never used.",
    ].join(" "),
    parameters: Type.Object({
      op: Type.String(),
      objective: Type.Optional(Type.String()),
      /** Alias for objective (compat with older soft goals). */
      title: Type.Optional(Type.String()),
      id: Type.Optional(Type.String()),
      token_budget: Type.Optional(Type.Number()),
      detail: Type.Optional(Type.String()),
      status: Type.Optional(Type.String()),
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
              "Goal mode active. Keep working until complete audit passes; harness may auto-continue while active.",
          });
        } catch (e) {
          return textResult(`error: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      if (op === "complete") {
        const g = goals.complete(params.id != null ? String(params.id) : undefined);
        if (!g) return textResult("error: no active goal to complete");
        await runtime.platform.send({
          type: "goal_updated",
          conversation_id: runtime.task.conversationId,
          task_id: runtime.task.taskId,
          op: "complete",
          goal: g,
          open_count: goals.snapshot().openCount,
        });
        return jsonResult({
          ok: true,
          goal: g,
          summary: goals.formatForPrompt(),
          guidance: "Goal marked complete. Auto-continuation stops. You may stop with no tools.",
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

      // Compat: update status on mode goal
      if (op === "update") {
        const status = params.status != null ? String(params.status).toLowerCase() : "";
        if (status === "done" || status === "complete") {
          const g = goals.complete(params.id != null ? String(params.id) : undefined);
          if (!g) return textResult("error: no goal");
          return jsonResult({ ok: true, goal: g, summary: goals.formatForPrompt() });
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
