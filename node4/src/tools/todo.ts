import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { formatTodoSummary, type TodoOpName, type TodoParams } from "../stores/todo.js";
import { TODO_TOOL_DESCRIPTION } from "../runtime/todo-harness.js";
import type { ToolRuntime } from "../types.js";
import { jsonResult, textResult } from "./common.js";

const OPS = ["init", "start", "done", "rm", "drop", "append", "view"] as const;

export function createTodoTool(runtime: ToolRuntime): ToolDefinition<any> {
  return {
    name: "todo",
    label: "Todo",
    description: TODO_TOOL_DESCRIPTION,
    parameters: Type.Object({
      op: Type.String(),
      list: Type.Optional(Type.Array(Type.Object({ phase: Type.String(), items: Type.Array(Type.String()) }))),
      task: Type.Optional(Type.String()),
      phase: Type.Optional(Type.String()),
      items: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_id: string, params: any) {
      const op = String(params.op || "").trim().toLowerCase() as TodoOpName;
      if (!OPS.includes(op as (typeof OPS)[number])) return textResult(`error: op must be one of ${OPS.join(", ")}`);
      const input: TodoParams = {
        op,
        list: Array.isArray(params.list)
          ? params.list
              .map((e: any) => ({
                phase: String(e?.phase || "").trim(),
                items: Array.isArray(e?.items) ? e.items.map((x: unknown) => String(x).trim()).filter(Boolean) : [],
              }))
              .filter((e: { phase: string; items: string[] }) => e.phase && e.items.length)
          : undefined,
        task: params.task != null ? String(params.task) : undefined,
        phase: params.phase != null ? String(params.phase) : undefined,
        items: Array.isArray(params.items) ? params.items.map((x: unknown) => String(x)) : undefined,
      };
      const result = runtime.todo.apply(input);
      if (result.errors.length) {
        runtime.lifecycle.pendingTodoErrorReminder = result.errors.slice();
        return jsonResult(
          {
            ok: false,
            errors: result.errors,
            summary: formatTodoSummary(result.phases, result.errors, true),
            phases: result.phases,
          },
          { isError: true },
        );
      }
      // Successful mutation clears a pending error reminder.
      if (!result.readOnly) {
        runtime.lifecycle.pendingTodoErrorReminder = undefined;
        await runtime.platform.send({
          type: "todo_updated",
          conversation_id: runtime.task.conversationId,
          task_id: runtime.task.taskId,
          op,
          phases: runtime.todo.snapshot(),
          open_count: runtime.todo.openCount(),
        });
      }
      return jsonResult({
        ok: true,
        op,
        summary: formatTodoSummary(result.phases, [], result.readOnly),
        phases: result.phases,
        open_count: runtime.todo.openCount(),
        completed_tasks: result.completedTasks,
      });
    },
  };
}
