/**
 * Worker tool: dispatch an in-process subagent with a role-scoped tool allowlist.
 * Shares parent ToolRuntime (traffic/coverage/actors/evidence). Main agent keeps finish_scan.
 */
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { PlatformMessage, ToolRuntime, WorkerRunRecord } from "../types.js";
import {
  classifyWorkerOutcome,
  planStatusForWorkerOutcome,
  runWorkerSession,
  type WorkerLaunchContext,
  type WorkerOutcome,
} from "../runtime/worker-runner.js";
import { listWorkerRoles, resolveWorkerRole } from "../runtime/worker-roles.js";
import { emitPlanUpdate, jsonResult, textResult } from "./common.js";

export function createWorkerTool(runtime: ToolRuntime): ToolDefinition<any> {
  const roles = listWorkerRoles();
  return {
    name: "worker",
    label: "Worker",
    description:
      "Run a focused in-process subagent (shared traffic/coverage/actors/evidence) for a work package. Roles: recon, access-control, injection, xss, general. Workers cannot finish_scan or nest workers. Prefer worker for parallelizable packages from the workflow brief or coverage(next_work).",
    promptSnippet: "Dispatch a role-scoped pentest worker subagent",
    promptGuidelines: [
      "After workflow_run returns work packages (or next_work items), dispatch them with worker(role=..., task=...) instead of doing everything in the main session when packages are separable.",
      "Use recon first when surface is thin; use access-control for dual-actor IDOR; injection for login/search SQLi; xss for browser XSS; general for mixed packages.",
      "Main agent remains responsible for overall next_work prioritization and finish_scan.",
      "Do not nest workers inside workers.",
    ],
    parameters: Type.Object({
      role: Type.Optional(Type.String()),
      task: Type.String(),
      max_turns: Type.Optional(Type.Number()),
    }),
    async execute(_toolCallId: string, params: any) {
      const role = resolveWorkerRole(params.role);
      const task = String(params.task || "").trim();
      if (!task) return textResult("error: task is required");

      const launch = (runtime as ToolRuntime & { workerLaunch?: WorkerLaunchContext }).workerLaunch;
      if (!launch) {
        return textResult(
          "error: worker launch context is not configured on this runtime (only available in full session runs)",
        );
      }

      const workerId = `worker-${role.id}-${Date.now().toString(36)}`;
      const planNodeId = `plan-${workerId}`;
      const startedAt = new Date().toISOString();

      runtime.plan.upsert({
        node_id: planNodeId,
        title: `Worker ${role.id}: ${task.slice(0, 80)}`,
        status: "running",
        kind: "worker",
        level: "work_item",
        parent_id: "plan-objective-analysis-test-plan",
        notes: task.slice(0, 400),
        priority: 220,
        source: "worker",
      });

      await runtime.platform.send({
        type: "worker_started",
        conversation_id: runtime.task.conversationId,
        task_id: runtime.task.taskId,
        worker_id: workerId,
        role: role.id,
        role_label: role.label,
        task: task.slice(0, 500),
        plan_node_id: planNodeId,
        started_at: startedAt,
      } as PlatformMessage);
      await launch.noteWorker?.("worker_started", {
        worker_id: workerId,
        role: role.id,
        task: task.slice(0, 300),
      });
      await emitPlanUpdate(runtime, "worker.start");

      let result;
      try {
        result = await runWorkerSession({
          runtime,
          launch,
          role: role.id,
          task,
          workerId,
          maxTurns: params.max_turns !== undefined ? Number(params.max_turns) : undefined,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result = {
          ok: false,
          outcome: classifyWorkerOutcome(false, message),
          workerId,
          role: role.id,
          summary: "",
          toolCallCount: 0,
          error: message,
          durationMs: Date.now() - Date.parse(startedAt) || 0,
        };
      }

      const outcome: WorkerOutcome = result.outcome || classifyWorkerOutcome(result.ok, result.error);
      const planStatus = planStatusForWorkerOutcome(outcome);
      const endedAt = new Date().toISOString();
      const outcomeLabel =
        outcome === "completed" ? "done" : outcome === "timeout" ? "timeout" : outcome === "aborted" ? "aborted" : "failed";
      const notesBody = (result.error || result.summary || "").slice(0, 420);
      runtime.plan.upsert({
        node_id: planNodeId,
        title: `Worker ${role.id} [${outcomeLabel}]: ${task.slice(0, 50)}`,
        status: planStatus,
        kind: "worker",
        level: "work_item",
        parent_id: "plan-objective-analysis-test-plan",
        notes: `[${outcomeLabel}] ${notesBody}`.slice(0, 500),
        priority: 220,
        source: "worker",
        result: outcome === "completed" ? "confirmed" : outcome === "timeout" ? "blocked" : "inconclusive",
      });

      const runRecord: WorkerRunRecord = {
        workerId,
        role: result.role,
        task: task.slice(0, 400),
        ok: result.ok,
        outcome,
        at: endedAt,
        durationMs: result.durationMs,
        toolCallCount: result.toolCallCount,
        summary: (result.summary || "").slice(0, 500),
        error: result.error,
      };
      if (!runtime.lifecycle.workerRuns) runtime.lifecycle.workerRuns = [];
      runtime.lifecycle.workerRuns.push(runRecord);

      if (result.usage) {
        await launch.mergeWorkerUsage?.(result.usage);
      } else {
        // Still count the worker agent even when the provider reported no tokens.
        await launch.mergeWorkerUsage?.({
          requests: 0,
          input_tokens: 0,
          output_tokens: 0,
          cached_tokens: 0,
          cache_write_tokens: 0,
          reasoning_tokens: 0,
          total_tokens: 0,
          cost: 0,
          agent_count: 1,
          tool_calls: result.toolCallCount,
        });
      }

      await runtime.platform.send({
        type: "worker_finished",
        conversation_id: runtime.task.conversationId,
        task_id: runtime.task.taskId,
        worker_id: workerId,
        role: result.role,
        role_label: role.label,
        ok: result.ok,
        outcome,
        status: planStatus,
        task: task.slice(0, 500),
        plan_node_id: planNodeId,
        tool_call_count: result.toolCallCount,
        duration_ms: result.durationMs,
        summary: (result.summary || "").slice(0, 800),
        error: result.error,
        usage: result.usage,
        started_at: startedAt,
        ended_at: endedAt,
      } as PlatformMessage);
      await launch.noteWorker?.("worker_finished", {
        worker_id: workerId,
        role: result.role,
        ok: result.ok,
        outcome,
        tool_call_count: result.toolCallCount,
        duration_ms: result.durationMs,
      });
      await emitPlanUpdate(runtime, "worker.end");

      return jsonResult({
        ok: result.ok,
        outcome,
        status: planStatus,
        worker_id: workerId,
        role: result.role,
        role_label: role.label,
        tool_call_count: result.toolCallCount,
        duration_ms: result.durationMs,
        summary: result.summary,
        error: result.error,
        usage: result.usage,
        worker_runs: runtime.lifecycle.workerRuns?.length ?? 0,
        available_roles: roles.map((item) => ({ id: item.id, label: item.label, description: item.description })),
        next:
          outcome === "timeout"
            ? "Worker timed out. Re-dispatch a narrower package or finish remaining probes in the main session before finish_scan."
            : outcome === "failed"
              ? "Worker failed. Inspect error, re-dispatch or continue with http/verifier, then update coverage."
              : "Integrate worker findings into coverage/next_work; dispatch more packages or call finish_scan only when assess gates are satisfied (use incomplete if work remains).",
      });
    },
  };
}
