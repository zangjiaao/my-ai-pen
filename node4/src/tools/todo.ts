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
import {
  consumePlatformTodoReplaceGrant,
  platformTodoReplaceAllowed,
} from "../runtime/todo-replace-grant.js";

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

      // Graph: surface SQLite working store is coverage truth (#371) — reject bare todo(done) while paths are open.
      // Prefer surfaceSqlite; fall back to legacy JSON ledger only for partial test runtimes.
      if (op === "done" && runtime.lifecycle.pentestGraph?.mode === "graph") {
        const sqlite = runtime.surfaceSqlite;
        const legacy = runtime.surfaceLedger;
        if (sqlite) {
          await sqlite.open();
          const summary = await sqlite.summary();
          if (summary.total >= 1) {
            const gate = await assertTodoDoneAllowed({
              task: params.task != null ? String(params.task) : undefined,
              phase: params.phase != null ? String(params.phase) : undefined,
              note: params.note != null ? String(params.note) : undefined,
              summary,
              hasActedMatch: (t) => sqlite.hasActedMatch(t),
              findByLocationHint: (t) => sqlite.findByLocationHint(t),
            });
            if (!gate.ok) {
              runtime.lifecycle.pendingTodoErrorReminder = [gate.error];
              return textResult(gate.error, { isError: true });
            }
            if (gate.ledgerOp) {
              if (gate.ledgerOp.op === "deadend") {
                await sqlite.markDeadend(gate.ledgerOp.location, gate.ledgerOp.note);
              } else {
                await sqlite.markSkipped(gate.ledgerOp.location, gate.ledgerOp.note);
              }
            }
          }
        } else if (legacy) {
          await legacy.load();
          const summary = legacy.summary();
          if (summary.total >= 1) {
            const gate = await assertTodoDoneAllowed({
              task: params.task != null ? String(params.task) : undefined,
              phase: params.phase != null ? String(params.phase) : undefined,
              note: params.note != null ? String(params.note) : undefined,
              summary,
              hasActedMatch: (t) => legacy.hasActedMatch(t),
              findByLocationHint: (t) => legacy.findByLocationHint(t),
            });
            if (!gate.ok) {
              runtime.lifecycle.pendingTodoErrorReminder = [gate.error];
              return textResult(gate.error, { isError: true });
            }
            if (gate.ledgerOp) {
              if (gate.ledgerOp.op === "deadend") {
                await legacy.markDeadend(gate.ledgerOp.location, gate.ledgerOp.note);
              } else {
                await legacy.markSkipped(gate.ledgerOp.location, gate.ledgerOp.note);
              }
            }
          }
        }
      }

      // Spec #313: Free Main Tasks = user progress SoT — gate silent init replace.
      // Graph plan path and subagent-private maps keep prior init semantics.
      // L3: full replace only with platform-issued grant (user confirm), not agent self-attest.
      const isSubagentEarly = (runtime.lifecycle.subagentDepth || 0) >= 1;
      const isFreeMainMap = !isSubagentEarly && !graphRunEarly?.plan;
      // Spec #313 L3: platform grant required for Free replace (agent allow_replace alone denied).
      const platformGrant = platformTodoReplaceAllowed({
        taskTodoReplaceAllowed: runtime.task.todoReplaceAllowed === true,
        conversationId: runtime.task.conversationId,
      });
      // Platform alone is enough once user confirmed; agent flag without platform is not.
      const allowReplace = platformGrant === true;
      // Spec #321 E2: capture seal *before* apply — after successful init the new map is unsealed.
      const priorLiveSealed = isFreeMainMap && runtime.todo.getTaskMap().isSealed;

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
      // Spec #313 L3 / #321 E3: one-shot grant consumed only when open+grant replace used it.
      // E2 sealed→init is grant-free — do not burn the grant.
      if (
        op === "init" &&
        isFreeMainMap &&
        allowReplace &&
        !priorLiveSealed &&
        !result.readOnly &&
        !result.errors.length
      ) {
        consumePlatformTodoReplaceGrant({
          task: runtime.task,
          clearTaskFlag: () => {
            runtime.task.todoReplaceAllowed = false;
          },
        });
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
            {
              // Spec #321: Graph L2 mutations stay on the same live map (E5).
              taskMap: runtime.todo.getTaskMap(),
            },
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
      // Request identity first (task/phase/completed_tasks) so Main tool rows and 4k
      // result_text truncation still know *which* item was start/done — not only "op".
      return jsonResult({
        ok: true,
        op,
        task: input.task || undefined,
        phase: input.phase || undefined,
        note: input.note != null ? String(params.note || "").trim() || undefined : undefined,
        completed_tasks: result.completedTasks,
        open_count,
        summary: formatTodoSummary(result.phases, [], result.readOnly),
        // Bulky fields last — wire truncates result_text (~4k); keep identity above.
        work_items,
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
