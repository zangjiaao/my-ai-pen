import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ToolRuntime } from "../types.js";
import { jsonResult, textResult } from "./common.js";

export function createGoalTool(runtime: ToolRuntime): ToolDefinition<any> {
  return {
    name: "goal",
    label: "Goal",
    description:
      "Long-task anchors (open/done/dropped). Survives continue. Does NOT gate harness settlement — labs may complete with open goals. Ops: create|update|list|view.",
    parameters: Type.Object({
      op: Type.String(),
      id: Type.Optional(Type.String()),
      title: Type.Optional(Type.String()),
      detail: Type.Optional(Type.String()),
      status: Type.Optional(Type.String()),
    }),
    async execute(_id: string, params: any) {
      const op = String(params.op || "list").trim().toLowerCase();
      const goals = runtime.goals;
      if (op === "list" || op === "view") {
        return jsonResult({ ok: true, ...goals.snapshot(), summary: goals.formatForPrompt() });
      }
      if (op === "create") {
        const title = String(params.title || "").trim();
        if (!title) return textResult("error: title required for create");
        const g = goals.create({ title, detail: params.detail != null ? String(params.detail) : undefined });
        await runtime.platform.send({
          type: "goal_updated",
          conversation_id: runtime.task.conversationId,
          task_id: runtime.task.taskId,
          op: "create",
          goal: g,
          open_count: goals.snapshot().openCount,
        });
        return jsonResult({ ok: true, goal: g, summary: goals.formatForPrompt() });
      }
      if (op === "update") {
        const id = String(params.id || "").trim();
        if (!id) return textResult("error: id required for update");
        const statusRaw = params.status != null ? String(params.status).toLowerCase() : undefined;
        const status =
          statusRaw === "done" || statusRaw === "dropped" || statusRaw === "open" ? statusRaw : undefined;
        const g = goals.update(id, {
          title: params.title != null ? String(params.title) : undefined,
          detail: params.detail != null ? String(params.detail) : undefined,
          status,
        });
        if (!g) return textResult(`error: goal not found: ${id}`);
        await runtime.platform.send({
          type: "goal_updated",
          conversation_id: runtime.task.conversationId,
          task_id: runtime.task.taskId,
          op: "update",
          goal: g,
          open_count: goals.snapshot().openCount,
        });
        return jsonResult({ ok: true, goal: g, summary: goals.formatForPrompt() });
      }
      return textResult("error: op must be create|update|list|view");
    },
  };
}
