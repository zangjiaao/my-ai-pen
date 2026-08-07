import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { formatTodoSummary, type TodoOpName, type TodoParams } from "../stores/todo.js";
import { TODO_TOOL_DESCRIPTION } from "../runtime/todo-harness.js";
import { buildTodoPlanTreePayload, emitTodoPlanTreeUpdate } from "../runtime/plan-projection.js";
import { emitHardGraphPlanTreeUpdate } from "../runtime/hard-graph-plan.js";
import { assertTodoDoneAllowed } from "../stores/surface-ledger.js";
import {
  mayMarkL2DoneForPackage,
  lookupPackageTerminal,
  graphCoverageSourceOfTruth,
} from "../runtime/package-settlement-law.js";
import type { ToolRuntime } from "../types.js";
import { jsonResult, textResult } from "./common.js";
import {
  graphStageLocalTodoInitError,
  isWholeEngagementTodoInitOnGraph,
} from "../runtime/graph-stage-todo-scope.js";

const OPS = ["init", "start", "done", "rm", "drop", "append", "view"] as const;

export function createTodoTool(runtime: ToolRuntime): AgentTool<any> {
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
      /** Graph coverage note: deadend|skipped_roe|probed|booked|n/a — blocks bare done when ledger has open surfaces */
      note: Type.Optional(Type.String()),
      /**
       * Spec #313 Free: full todo.init replace only after explicit user permission.
       * Ignored on Graph / subagent (stage-local / private maps).
       */
      allow_replace: Type.Optional(Type.Boolean()),
    }),
    async execute(_id: string, params: any) {
      const op = String(params.op || "").trim().toLowerCase() as TodoOpName;
      if (!OPS.includes(op as (typeof OPS)[number])) return textResult(`error: op must be one of ${OPS.join(", ")}`);

      // Spec #281: Graph todo(init) = current-stage L2 only (reject Free-style whole maps).
      const graphRunEarly = runtime.lifecycle.hardGraphRun;
      if (
        op === "init" &&
        graphRunEarly?.plan &&
        graphRunEarly.stageId &&
        (runtime.lifecycle.subagentDepth || 0) < 1
      ) {
        const rawList = Array.isArray(params.list)
          ? params.list.map((e: any) => ({
              phase: String(e?.phase || "").trim(),
              items: Array.isArray(e?.items)
                ? e.items.map((x: unknown) => String(x).trim()).filter(Boolean)
                : [],
            }))
          : [];
        if (isWholeEngagementTodoInitOnGraph(rawList, graphRunEarly.stageId)) {
          const err = graphStageLocalTodoInitError(graphRunEarly.stageId);
          runtime.lifecycle.pendingTodoErrorReminder = [err];
          return textResult(err, { isError: true });
        }
      }

      // Graph: surface ledger is coverage truth — reject bare todo(done) while paths are open.
      if (op === "done" && runtime.lifecycle.pentestGraph?.mode === "graph" && runtime.surfaceLedger) {
        await runtime.surfaceLedger.load();
        const summary = runtime.surfaceLedger.summary();
        if (summary.total >= 1) {
          const gate = assertTodoDoneAllowed({
            task: params.task != null ? String(params.task) : undefined,
            phase: params.phase != null ? String(params.phase) : undefined,
            note: params.note != null ? String(params.note) : undefined,
            summary,
            hasActedMatch: (t) => runtime.surfaceLedger!.hasActedMatch(t),
            findByLocationHint: (t) => runtime.surfaceLedger!.findByLocationHint(t),
          });
          if (!gate.ok) {
            runtime.lifecycle.pendingTodoErrorReminder = [gate.error];
            return textResult(gate.error, { isError: true });
          }
          if (gate.ledgerOp) {
            if (gate.ledgerOp.op === "deadend") {
              await runtime.surfaceLedger.markDeadend(gate.ledgerOp.location, gate.ledgerOp.note);
            } else {
              await runtime.surfaceLedger.markSkipped(gate.ledgerOp.location, gate.ledgerOp.note);
            }
          }
        }
      }

      // Spec #313: Free Main Tasks = user progress SoT — gate silent init replace.
      // Graph plan path and subagent-private maps keep prior init semantics.
      const isSubagentEarly = (runtime.lifecycle.subagentDepth || 0) >= 1;
      const isFreeMainMap = !isSubagentEarly && !graphRunEarly?.plan;
      const allowReplace =
        params.allow_replace === true ||
        params.allowReplace === true ||
        String(params.allow_replace || params.allowReplace || "")
          .trim()
          .toLowerCase() === "true";

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
        free_map: isFreeMainMap || undefined,
        allow_replace: allowReplace || undefined,
      };
      // Spec #116 I0.11: cannot done L2 while anchored package failed/running/unfinished
      if (op === "done" && runtime.lifecycle.processQuality && input.task) {
        const taskName = String(input.task || "").trim();
        const pq = runtime.lifecycle.processQuality;
        const hit = lookupPackageTerminal(
          pq.packageTerminals,
          pq.packageTerminalAliasIndex,
          taskName,
        );
        if (hit) {
          const gate = mayMarkL2DoneForPackage(hit.terminal, hit.salvaged);
          if (!gate.ok) {
            return jsonResult(
              {
                ok: false,
                errors: [gate.error || "L2 done rejected for package state"],
                summary: gate.error,
              },
              { isError: true },
            );
          }
        }
      }

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
      // Spec #116 I0.21: Expert Graph coverage SoT = GraphStore only (no TodoStore∥GraphStore dual plan_tree).
      const graphRun = runtime.lifecycle.hardGraphRun;
      const coverageSot = graphCoverageSourceOfTruth(Boolean(graphRun?.plan));
      // Workers (depth >= 1) keep a private TodoStore for their own loop only.
      // Never broadcast plan_tree: same expert_id would replace Main/Graph L1+L2 on the right panel.
      const isSubagent = (runtime.lifecycle.subagentDepth || 0) >= 1;

      // Successful mutation: clear error reminder, emit todo + plan_tree for platform Tasks.
      if (!result.readOnly) {
        runtime.lifecycle.pendingTodoErrorReminder = undefined;
        await runtime.platform.send({
          type: "todo_updated",
          conversation_id: runtime.task.conversationId,
          task_id: runtime.task.taskId,
          op,
          phases: runtime.todo.snapshot(),
          open_count: runtime.todo.openCount(),
          // Hint for platform consumers: worker-local, not Case Tasks SoT
          scope: isSubagent ? "subagent_local" : "case",
        });
        if (isSubagent) {
          // Local tool result only — no plan_tree_updated, no Graph setStageTodos.
        } else if (coverageSot === "graph_store" && graphRun?.plan) {
          // Todo tool is a facade: mutate Graph L2 via setStageTodos, emit Graph plan_tree only.
          // I0.21: never emit TodoStore plan_tree on Expert Graph path (even if stageId missing).
          if (graphRun.stageId) {
            const payload = buildTodoPlanTreePayload(runtime.todo);
            graphRun.plan.setStageTodos(graphRun.stageId, payload.plan_tree);
          }
          await emitHardGraphPlanTreeUpdate(
            runtime.platform,
            runtime.task,
            graphRun.plan,
            `todo.${op}`,
          );
        } else {
          await emitTodoPlanTreeUpdate(runtime.platform, runtime.task, runtime.todo, `todo.${op}`);
        }
      }
      const plan_nodes = runtime.todo.toPlanNodes();
      // Flat work_items first so models see node_id for subagent plan_node_id without digging phases.
      const work_items = plan_nodes
        .filter((n) => n.level === "work_item")
        .map((n) => ({
          node_id: n.node_id,
          title: n.title,
          status: n.status,
          parent_id: n.parent_id || null,
        }));
      const open_count = runtime.todo.openCount();
      return jsonResult({
        ok: true,
        op,
        summary: formatTodoSummary(result.phases, [], result.readOnly),
        work_items,
        open_count,
        completed_tasks: result.completedTasks,
        phases: result.phases,
        plan_nodes,
        // Spec #116 I0.10: Expert Graph always requires plan_node_id (dispatch = ownership).
        plan_node_id_hint:
          coverageSot === "graph_store" || open_count > 1
            ? coverageSot === "graph_store"
              ? "Expert Graph: pass work_items[].node_id as subagent plan_node_id (required L2 anchor)."
              : "Pass work_items[].node_id as subagent plan_node_id so Tasks Worker chip binds to that row."
            : undefined,
      });
    },
  };
}
