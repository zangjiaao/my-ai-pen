import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { formatTodoSummary, type TodoOpName, type TodoParams } from "../stores/todo.js";
import type { ToolRuntime } from "../types.js";
import { emitPlanUpdate, emitTodoUpdate, jsonResult, textResult } from "./common.js";

const OPS = ["init", "start", "done", "rm", "drop", "append", "view"] as const;

/**
 * OMP-style session todo. Main agent only — workers must not receive this tool.
 */
export function createTodoTool(runtime: ToolRuntime): ToolDefinition<any> {
  return {
    name: "todo",
    label: "Todo",
    description:
      "Session task map (OMP-style). Single op per call: init/start/done/drop/rm/append/view. Tasks are identified by verbatim content (not task-1 IDs). At most one in_progress; done auto-promotes the next pending. Todo never blocks finish_scan.",
    promptSnippet: "Track phased work with init/start/done; content strings are IDs",
    promptGuidelines: [
      "For multi-step work, call todo(op='init') with phases covering the whole request before deep testing.",
      "Task labels: 5–10 words, what not how. Phase names: short nouns (Recon, Injection, Auth).",
      "After finishing a step, todo(op='done', task='exact content') immediately; the next pending auto-starts.",
      "Same turn: after init or done, continue acting (http/browser/poc) — do not burn a turn on bookkeeping only.",
      "Lost exact task text? todo(op='view') — never invent task-N ids.",
      "Todo is a progress map only; open items do not block finish_scan(completed).",
    ],
    parameters: Type.Object({
      op: Type.String(),
      list: Type.Optional(
        Type.Array(
          Type.Object({
            phase: Type.String(),
            items: Type.Array(Type.String()),
          }),
        ),
      ),
      task: Type.Optional(Type.String()),
      phase: Type.Optional(Type.String()),
      items: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_toolCallId: string, params: any) {
      if (!runtime.todo) {
        return textResult("error: todo store is not available on this runtime");
      }
      const op = String(params.op || "").trim().toLowerCase() as TodoOpName;
      if (!OPS.includes(op as (typeof OPS)[number])) {
        return textResult(`error: op must be one of ${OPS.join(", ")}`);
      }

      const input: TodoParams = {
        op,
        list: normalizeList(params.list),
        task: params.task != null ? String(params.task) : undefined,
        phase: params.phase != null ? String(params.phase) : undefined,
        items: Array.isArray(params.items) ? params.items.map((x: unknown) => String(x)) : undefined,
      };

      const result = runtime.todo.apply(input);
      if (result.errors.length > 0) {
        return jsonResult(
          {
            ok: false,
            isError: true,
            summary: formatTodoSummary(result.phases, result.errors, true),
            errors: result.errors,
            phases: result.phases,
          },
          { isError: true },
        );
      }

      // Project into plan for platform Tasks panel without requiring a frontend redesign.
      if (!result.readOnly) {
        projectTodoIntoPlan(runtime);
        await emitTodoUpdate(runtime, op);
        await emitPlanUpdate(runtime, `todo.${op}`);
      }

      const openCount = runtime.todo.openCount();
      return jsonResult({
        ok: true,
        op,
        summary: formatTodoSummary(result.phases, [], result.readOnly),
        phases: result.phases,
        open_count: openCount,
        completed_tasks: result.completedTasks,
        storage: "session",
        guidance:
          openCount > 0
            ? "Mark tasks done as you finish them; open todo items do not block finish_scan."
            : "Todo list has no open items. Finish when engagement outcome and evidence are ready.",
      });
    },
  };
}

function normalizeList(
  raw: unknown,
): Array<{ phase: string; items: string[] }> | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const row = entry as Record<string, unknown>;
      const phase = String(row.phase || "").trim();
      const items = Array.isArray(row.items) ? row.items.map((x) => String(x).trim()).filter(Boolean) : [];
      if (!phase || !items.length) return null;
      return { phase, items };
    })
    .filter((x): x is { phase: string; items: string[] } => Boolean(x));
}

/** Upsert todo-derived nodes so plan_tree_updated shows the user-facing map. */
export function projectTodoIntoPlan(runtime: ToolRuntime): void {
  if (!runtime.todo) return;
  for (const node of runtime.todo.toPlanNodes()) {
    runtime.plan.upsert({
      node_id: node.node_id,
      title: node.title,
      status: node.status,
      kind: node.kind,
      level: node.level,
      parent_id: node.parent_id,
      priority: node.priority,
      source: "todo",
    });
  }
}
