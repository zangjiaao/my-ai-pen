import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ToolRuntime } from "../types.js";
import { jsonResult, textResult } from "./common.js";

/**
 * OMP-style goal tool: create / get / complete / drop / resume / pause / list.
 * complete is gated so maximize-style goals cannot soft-exit after partial wins.
 */
export function createGoalTool(runtime: ToolRuntime): ToolDefinition<any> {
  return {
    name: "goal",
    label: "Goal",
    description: [
      "OMP-style long-task goal mode (single active objective).",
      "Ops: create|get|complete|drop|resume|pause|list.",
      "create: objective (required), token_budget?.",
      "complete: requires audit_notes + remaining_unsolved=0; rejected until harness goal_continuations + no-progress stalls pass.",
      "remaining_unsolved is required; >0 always rejected — keep working remaining items from your recon until full clearance.",
      "Do not drop a maximize objective to soft-exit partial progress.",
      "While active the harness auto-continues after natural stops (capped).",
    ].join(" "),
    parameters: Type.Object({
      op: Type.String(),
      objective: Type.Optional(Type.String()),
      title: Type.Optional(Type.String()),
      id: Type.Optional(Type.String()),
      token_budget: Type.Optional(Type.Number()),
      detail: Type.Optional(Type.String()),
      status: Type.Optional(Type.String()),
      /** Required for complete: detailed audit of remaining surface and blockers. */
      audit_notes: Type.Optional(Type.String()),
      /** From agent recon: how many challenges/items still unsolved (0 only when truly done). */
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
              "Goal active. Keep dense shell work on remaining surface. complete is gated until continuations+stalls+audit_notes.",
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
                "COMPLETE REJECTED. Keep dense shell on remaining items from YOUR recon until remaining_unsolved=0 and gates pass. Do not shrink the objective; do not only narrate.",
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
