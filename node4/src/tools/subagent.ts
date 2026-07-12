import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { runShell } from "./shell.js";
import type { ToolRuntime } from "../types.js";
import { jsonResult, textResult } from "./common.js";

/**
 * Agent-facing subagent tool. Default worker runs a bounded shell probe when
 * `command` is set; otherwise records assignment-only structured yield.
 * Smokes inject via SubagentHost.spawn directly.
 */
export function createSubagentTool(runtime: ToolRuntime): ToolDefinition<any> {
  return {
    name: "subagent",
    label: "Subagent",
    description:
      "Spawn a child work package under this task workspace. Returns structured result + evidence_id for booking. Optional goal_id attaches a long-task goal. Prefer for separable recon/exploit packages. Params: assignment (required), goal_id?, command? (optional shell for the child).",
    parameters: Type.Object({
      assignment: Type.String(),
      goal_id: Type.Optional(Type.String()),
      command: Type.Optional(Type.String()),
      timeout_seconds: Type.Optional(Type.Number()),
    }),
    async execute(_id: string, params: any) {
      if (!runtime.subagents) return textResult("error: subagent host not available");
      const assignment = String(params.assignment || "").trim();
      if (!assignment) return textResult("error: assignment required");
      const goalId = params.goal_id != null ? String(params.goal_id).trim() : undefined;
      if (goalId && !runtime.goals.get(goalId)) {
        return textResult(`error: goal not found: ${goalId} (create with goal op=create first)`);
      }
      const command = params.command != null ? String(params.command).trim() : "";
      const timeoutSec = Math.min(Math.max(Number(params.timeout_seconds || 120), 1), 300);

      const result = await runtime.subagents.spawn({
        assignment,
        goalId: goalId || undefined,
        worker: async (ctx) => {
          if (command) {
            const shellOut = await runShell(command, ctx.taskDir, timeoutSec * 1000, runtime.lifecycle.abortSignal);
            return {
              ok: !shellOut.timedOut && !shellOut.aborted && shellOut.exitCode === 0,
              summary: shellOut.timedOut
                ? "child shell timed out"
                : `child shell exit=${shellOut.exitCode}`,
              data: {
                kind: "shell",
                command,
                cwd: ctx.taskDir,
                workDir: ctx.workDir,
                exitCode: shellOut.exitCode,
                stdout: shellOut.stdout.slice(0, 80_000),
                stderr: shellOut.stderr.slice(0, 20_000),
                timedOut: shellOut.timedOut,
                aborted: shellOut.aborted,
              },
            };
          }
          return {
            ok: true,
            summary: "child recorded assignment (no command)",
            data: { kind: "assignment_only", assignment: ctx.assignment, workDir: ctx.workDir },
          };
        },
      });

      return jsonResult({
        ok: result.ok,
        subagent_id: result.subagentId,
        summary: result.summary,
        data: result.data,
        evidence_id: result.evidenceId,
        goal_id: result.goalId,
        artifact_path: result.artifactPath,
        guidance: "Use evidence_id with finding(confirm) when the child proved a bookable issue.",
      });
    },
  };
}
