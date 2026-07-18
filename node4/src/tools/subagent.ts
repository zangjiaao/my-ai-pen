import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { runShell } from "./shell.js";
import type { ToolRuntime } from "../types.js";
import { jsonResult, textResult } from "./common.js";
import {
  assertSubagentNestAllowed,
  validateSubagentHandoff,
} from "../runtime/subagent-handoff.js";

/**
 * Agent-facing subagent tool. Default worker runs a bounded shell probe when
 * `command` is set; otherwise records assignment-only structured yield.
 * Requires a full handoff package (A1); nested spawn disallowed (D3).
 * Smokes inject via SubagentHost.spawn directly for host-level tests.
 */
export function createSubagentTool(runtime: ToolRuntime): ToolDefinition<any> {
  return {
    name: "subagent",
    label: "Subagent",
    description: [
      "Spawn a child work package under this task workspace.",
      "REQUIRED handoff fields (child does not see parent chat):",
      "target (URL|IP:Port|domain+path), scope (in-scope boundary), already_done,",
      "this_turn_goal (single objective), success_criteria (evidence shape).",
      "Optional assignment= free-form notes; optional command= bounded shell in child;",
      "optional goal_id attaches a long-task goal.",
      "Nested subagent-from-subagent is DISALLOWED — children return evidence to parent only.",
      "To book: finding(confirm) with proof= quoted from child output.",
    ].join(" "),
    parameters: Type.Object({
      target: Type.String({ description: "URL | IP:Port | domain+path for this child" }),
      scope: Type.String({ description: "In-scope boundary / constraints for the child" }),
      already_done: Type.String({
        description: "What parent already finished — child must not repeat equivalent work",
      }),
      this_turn_goal: Type.String({ description: "Single objective for this child package" }),
      success_criteria: Type.String({
        description: "What evidence/shape means success (e.g. ports list, PoC stdout)",
      }),
      assignment: Type.Optional(Type.String({ description: "Optional free-form notes appended to handoff" })),
      goal_id: Type.Optional(Type.String()),
      command: Type.Optional(Type.String()),
      timeout_seconds: Type.Optional(Type.Number()),
    }),
    async execute(_id: string, params: any) {
      if (!runtime.subagents) return textResult("error: subagent host not available");

      const nest = assertSubagentNestAllowed(runtime.lifecycle.subagentDepth);
      if (!nest.ok) return textResult(nest.error, { isError: true });

      const handoff = validateSubagentHandoff({
        target: params.target,
        scope: params.scope,
        already_done: params.already_done,
        this_turn_goal: params.this_turn_goal,
        success_criteria: params.success_criteria,
        assignment: params.assignment,
      });
      if (!handoff.ok) {
        return textResult(handoff.error, {
          isError: true,
          missing: handoff.missing,
        });
      }

      const goalId = params.goal_id != null ? String(params.goal_id).trim() : undefined;
      if (goalId && !runtime.goals.get(goalId)) {
        return textResult(`error: goal not found: ${goalId} (create with goal op=create first)`);
      }
      const command = params.command != null ? String(params.command).trim() : "";
      const timeoutSec = Math.min(Math.max(Number(params.timeout_seconds || 120), 1), 300);

      const result = await runtime.subagents.spawn({
        assignment: handoff.packageText,
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
                handoff: handoff.handoff,
              },
            };
          }
          return {
            ok: true,
            summary: "child recorded handoff (no command)",
            data: {
              kind: "assignment_only",
              assignment: ctx.assignment,
              workDir: ctx.workDir,
              handoff: handoff.handoff,
            },
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
        handoff: handoff.handoff,
        guidance:
          "Quote proving fragments from child output into finding(confirm) proof= when booking. Do not nest subagent.",
      });
    },
  };
}
