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
import {
  recordOpenWorkerPackage,
  resolveOpenWorkerPackagesForSuccess,
  unresolvedWorkerPackages,
} from "../runtime/worker-packages.js";
import { listWorkerRoles, resolveWorkerRole } from "../runtime/worker-roles.js";
import { emitPlanUpdate, jsonResult, textResult } from "./common.js";

export function createWorkerTool(runtime: ToolRuntime): ToolDefinition<any> {
  const roles = listWorkerRoles();
  return {
    name: "worker",
    label: "Worker",
    description:
      "Run a focused in-process subagent (shared traffic/coverage/actors/evidence) for a narrow work package. Roles: recon, access-control, injection, xss, general. Workers cannot finish_scan or nest workers. Prefer one role and 1–2 endpoints per package.",
    promptSnippet: "Dispatch a narrow role-scoped pentest worker (1–2 endpoints)",
    promptGuidelines: [
      "After workflow_run returns work packages (or next_work items), dispatch them with worker(role=..., task=...) instead of doing everything in the main session when packages are separable.",
      "NARROW PACKAGES ONLY: one role + 1–2 endpoints/challenges per worker call. Never pack an entire level-group (e.g. L8×4 + L5) into one worker — that causes wall-clock timeout.",
      "On worker timeout: re-dispatch a narrower package (same or related role) or finish remaining probes in the main session. After repeated timeouts the package is marked failed with adjustment advice — do not endless-retry the same wide task.",
      "Use recon first when surface is thin; use access-control for dual-actor IDOR; injection for login/search SQLi; xss for browser XSS; general only for small mixed packages.",
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
      // Immediate panel_agents so Agent collaboration does not wait for a throttled checkpoint.
      await runtime.platform.send({
        type: "checkpoint_update",
        conversation_id: runtime.task.conversationId,
        task_id: runtime.task.taskId,
        checkpoint: {
          runtime: "node2-pi",
          panel_agents: [
            {
              id: "node2-main",
              name: "Main Agent",
              status: "running",
              parent_id: null,
              role: "main",
              task: runtime.task.instruction?.slice(0, 240) || "",
              current_tool: "worker",
              current_action: "dispatch",
            },
            ...(runtime.lifecycle.workerRuns || []).map((run) => ({
              id: run.workerId,
              name: `Worker ${run.role}`,
              status: run.ok ? "completed" : run.outcome === "timeout" ? "timed_out" : "failed",
              parent_id: "node2-main",
              role: run.role,
              task: run.task?.slice(0, 240) || "",
              current_action: run.outcome || (run.ok ? "done" : "failed"),
            })),
            {
              id: workerId,
              name: `Worker ${role.id}`,
              status: "running",
              parent_id: "node2-main",
              role: role.id,
              task: task.slice(0, 240),
              current_action: "running",
            },
          ],
        },
      } as PlatformMessage);

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

      let outcome: WorkerOutcome = result.outcome || classifyWorkerOutcome(result.ok, result.error);
      const maxTimeoutRetries = Number(runtime.task.workerLimits?.maxTimeoutRetries ?? process.env.NODE2_WORKER_MAX_TIMEOUT_RETRIES ?? 2);
      const endedAt = new Date().toISOString();

      // Discovery backlog: timeout/failed packages stay open until re-dispatch succeeds.
      // Repeated timeouts on the same lineage escalate to failed + adjustment advice.
      let followUpPlanId: string | undefined;
      let openAdvice: string | undefined;
      let escalatedToFailed = false;
      let timeoutAttempts = 0;
      if (outcome === "timeout" || outcome === "failed" || outcome === "aborted") {
        const recorded = recordOpenWorkerPackage(runtime.lifecycle, {
          workerId,
          role: result.role,
          task: task.slice(0, 400),
          outcome,
          maxTimeoutRetries,
        });
        escalatedToFailed = recorded.escalatedToFailed;
        openAdvice = recorded.advice || recorded.pkg.advice;
        timeoutAttempts = recorded.pkg.timeoutAttempts || 0;
        if (escalatedToFailed) outcome = "failed";
        followUpPlanId = `plan-followup-${recorded.pkg.packageId}`;
        const retriesLeft = Math.max(0, 1 + Math.max(0, Math.floor(maxTimeoutRetries)) - timeoutAttempts);
        if (escalatedToFailed || outcome === "failed" || outcome === "aborted") {
          runtime.plan.upsert({
            node_id: followUpPlanId,
            title: `Follow-up ${role.id} package [failed]`,
            status: "failed",
            kind: "task",
            level: "work_item",
            parent_id: "plan-objective-analysis-test-plan",
            notes: (openAdvice || `Package failed (${outcome}). Narrow scope or adjust node worker timeout.`).slice(0, 500),
            priority: 210,
            source: "worker",
            result: "blocked",
          });
        } else {
          runtime.plan.upsert({
            node_id: followUpPlanId,
            title: `Follow-up ${role.id} package [retry]`,
            status: "pending",
            kind: "task",
            level: "work_item",
            parent_id: "plan-objective-analysis-test-plan",
            notes: `Timeout attempt ${timeoutAttempts}; ${retriesLeft} retry budget left. Re-dispatch NARROWER worker (1–2 endpoints) or main-session probes for: ${task.slice(0, 200)}`.slice(0, 500),
            priority: 210,
            source: "worker",
            result: "blocked",
          });
        }
      } else if (outcome === "completed") {
        const resolved = resolveOpenWorkerPackagesForSuccess(runtime.lifecycle, {
          role: result.role,
          task,
          note: `resolved by successful worker ${workerId}`,
        });
        if (resolved.count > 0) {
          const idSet = new Set(resolved.packageIds);
          for (const pkg of runtime.lifecycle.openWorkerPackages || []) {
            if (!idSet.has(pkg.packageId)) continue;
            runtime.plan.upsert({
              node_id: `plan-followup-${pkg.packageId}`,
              title: `Follow-up ${pkg.role} package [resolved]`,
              status: "done",
              kind: "task",
              level: "work_item",
              parent_id: "plan-objective-analysis-test-plan",
              notes: pkg.resolveNote || "resolved by successful re-dispatch",
              priority: 210,
              source: "worker",
              result: "confirmed",
            });
          }
        }
      }

      const planStatus = planStatusForWorkerOutcome(outcome);
      const outcomeLabel =
        outcome === "completed"
          ? "done"
          : outcome === "timeout"
            ? "timeout"
            : outcome === "aborted"
              ? "aborted"
              : "failed";
      const notesBody = (openAdvice || result.error || result.summary || "").slice(0, 420);
      runtime.plan.upsert({
        node_id: planNodeId,
        title: `Worker ${role.id} [${outcomeLabel}]: ${task.slice(0, 50)}`,
        status: planStatus,
        kind: "worker",
        level: "work_item",
        parent_id: "plan-objective-analysis-test-plan",
        notes: `[${outcomeLabel}${timeoutAttempts ? ` x${timeoutAttempts}` : ""}] ${notesBody}`.slice(0, 500),
        priority: 220,
        source: "worker",
        result: outcome === "completed" ? "confirmed" : outcome === "timeout" ? "blocked" : "inconclusive",
      });

      const runRecord: WorkerRunRecord = {
        workerId,
        role: result.role,
        task: task.slice(0, 400),
        ok: result.ok && outcome === "completed",
        outcome,
        at: endedAt,
        durationMs: result.durationMs,
        toolCallCount: result.toolCallCount,
        summary: (result.summary || "").slice(0, 500),
        error: result.error || (escalatedToFailed ? openAdvice : undefined),
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
        ok: outcome === "completed",
        outcome,
        status: planStatus,
        task: task.slice(0, 500),
        plan_node_id: planNodeId,
        tool_call_count: result.toolCallCount,
        duration_ms: result.durationMs,
        summary: (result.summary || openAdvice || "").slice(0, 800),
        error: result.error || (escalatedToFailed ? openAdvice : undefined),
        timeout_attempts: timeoutAttempts || undefined,
        advice: openAdvice,
        usage: result.usage,
        started_at: startedAt,
        ended_at: endedAt,
      } as PlatformMessage);
      await launch.noteWorker?.("worker_finished", {
        worker_id: workerId,
        role: result.role,
        ok: outcome === "completed",
        outcome,
        tool_call_count: result.toolCallCount,
        duration_ms: result.durationMs,
      });
      await emitPlanUpdate(runtime, "worker.end");
      await runtime.platform.send({
        type: "checkpoint_update",
        conversation_id: runtime.task.conversationId,
        task_id: runtime.task.taskId,
        checkpoint: {
          runtime: "node2-pi",
          panel_agents: [
            {
              id: "node2-main",
              name: "Main Agent",
              status: "running",
              parent_id: null,
              role: "main",
              task: runtime.task.instruction?.slice(0, 240) || "",
              current_tool: "",
              current_action: "coordinating",
            },
            ...(runtime.lifecycle.workerRuns || []).map((run) => ({
              id: run.workerId,
              name: `Worker ${run.role}`,
              status:
                run.outcome === "completed" || run.ok
                  ? "completed"
                  : run.outcome === "timeout"
                    ? "timed_out"
                    : run.outcome === "aborted"
                      ? "stopped"
                      : "failed",
              parent_id: "node2-main",
              role: run.role,
              task: run.task?.slice(0, 240) || "",
              current_action: run.outcome || (run.ok ? "done" : "failed"),
              duration_ms: run.durationMs,
              tool_call_count: run.toolCallCount,
            })),
          ],
        },
      } as PlatformMessage);

      const openLeft = unresolvedWorkerPackages(runtime.lifecycle);
      return jsonResult({
        ok: outcome === "completed",
        outcome,
        status: planStatus,
        worker_id: workerId,
        role: result.role,
        role_label: role.label,
        tool_call_count: result.toolCallCount,
        duration_ms: result.durationMs,
        summary: result.summary,
        error: result.error || (escalatedToFailed ? openAdvice : undefined),
        advice: openAdvice,
        timeout_attempts: timeoutAttempts || undefined,
        usage: result.usage,
        worker_runs: runtime.lifecycle.workerRuns?.length ?? 0,
        open_worker_packages: openLeft.length,
        follow_up_plan_id: followUpPlanId,
        available_roles: roles.map((item) => ({ id: item.id, label: item.label, description: item.description })),
        next:
          outcome === "timeout"
            ? "Worker timed out — package is OPEN. Re-dispatch a NARROWER package (1–2 endpoints) or main-session probes; do not resend the same wide task. Check Tasks Follow-up [retry] budget."
            : escalatedToFailed
              ? "Worker package FAILED after repeated timeouts. Follow adjustment advice in plan notes (split endpoints, raise node worker timeout in 节点管理, or finish_scan(incomplete) with blockers)."
              : outcome === "failed" || outcome === "aborted"
                ? "Worker failed — package is OPEN on the backlog. Inspect error, re-dispatch narrower work or continue with http/verifier, then update coverage."
                : openLeft.length
                  ? `Worker completed, but ${openLeft.length} other timeout/failed package(s) remain open. Clear them before finish_scan(completed).`
                  : "Integrate worker findings into coverage/next_work; dispatch more packages or call finish_scan only when assess gates are satisfied (use incomplete if work remains).",
      });
    },
  };
}
