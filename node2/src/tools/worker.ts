/**
 * Worker tool: dispatch an in-process subagent with a role-scoped tool allowlist.
 * Shares parent ToolRuntime (traffic/coverage/actors/evidence). Main agent keeps finish_scan.
 */
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ToolRuntime } from "../types.js";
import { runWorkerSession, type WorkerLaunchContext } from "../runtime/worker-runner.js";
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

      runtime.plan.upsert({
        node_id: `plan-worker-${role.id}-${Date.now().toString(36)}`,
        title: `Worker ${role.id}: ${task.slice(0, 80)}`,
        status: "running",
        kind: "worker",
        level: "work_item",
        parent_id: "plan-objective-analysis-test-plan",
        notes: task.slice(0, 400),
        priority: 220,
        source: "worker",
      });
      await emitPlanUpdate(runtime, "worker.start");

      const result = await runWorkerSession({
        runtime,
        launch,
        role: role.id,
        task,
        maxTurns: params.max_turns !== undefined ? Number(params.max_turns) : undefined,
      });

      runtime.plan.upsert({
        node_id: `plan-worker-${role.id}-done-${Date.now().toString(36)}`,
        title: `Worker ${role.id} ${result.ok ? "done" : "failed"}`,
        status: result.ok ? "done" : "failed",
        kind: "worker",
        level: "work_item",
        parent_id: "plan-objective-analysis-test-plan",
        notes: (result.summary || result.error || "").slice(0, 500),
        priority: 220,
        source: "worker",
      });
      await emitPlanUpdate(runtime, "worker.end");

      return jsonResult({
        ok: result.ok,
        role: result.role,
        role_label: role.label,
        tool_call_count: result.toolCallCount,
        duration_ms: result.durationMs,
        summary: result.summary,
        error: result.error,
        available_roles: roles.map((item) => ({ id: item.id, label: item.label, description: item.description })),
        next:
          "Integrate worker findings into coverage/next_work; dispatch more packages or call finish_scan from the main agent when assess gates are satisfied.",
      });
    },
  };
}
