import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ToolRuntime } from "../types.js";
import { loadConfirmedFindings } from "./finding.js";
import { jsonResult, textResult } from "./common.js";

/**
 * Non-terminal engagement note (legacy name finish_scan for platform compat).
 * Does NOT end the agent loop and does NOT force task_complete.
 */
export function createFinishTool(runtime: ToolRuntime): ToolDefinition<any> {
  return {
    name: "finish_scan",
    label: "Status",
    description:
      "OPTIONAL non-terminal status note for the engagement. Does NOT end the task. Does NOT complete billing. Keep testing until the harness stops you. Book conclusions only via finding+evidence.",
    parameters: Type.Object({
      status: Type.Optional(Type.String()),
      summary: Type.String(),
      evidence_ids: Type.Optional(Type.Array(Type.String())),
      blockers: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(toolCallId: string, params: any) {
      const summary = String(params.summary || "").trim();
      if (!summary) return textResult("error: summary required");
      const kindRaw = String(params.status || "progress").toLowerCase();
      const kind = kindRaw === "blocked" ? "blocked" : kindRaw === "summary" ? "summary" : "progress";

      const aggregated = await loadConfirmedFindings(runtime.findingsDir);
      const note = {
        kind,
        summary,
        calledAt: new Date().toISOString(),
        toolCallId,
        confirmedFindings: aggregated.titles,
        findingsDedupedCount: aggregated.count,
        evidenceIds: aggregated.evidenceIds,
        blockers: Array.isArray(params.blockers) ? params.blockers.map(String) : [],
        non_terminal: true,
      };
      runtime.lifecycle.lastStatusNote = note;
      if (kind === "blocked") runtime.lifecycle.agentBlocked = true;

      await writeFile(join(runtime.taskDir, "status.json"), JSON.stringify(note, null, 2), "utf8");
      // Protocol compat: still emit finish_scan_requested but mark non_terminal.
      await runtime.platform.send({
        type: "finish_scan_requested",
        conversation_id: runtime.task.conversationId,
        task_id: runtime.task.taskId,
        status: kind === "blocked" ? "blocked" : "progress",
        summary,
        non_terminal: true,
        confirmed_findings: aggregated.titles,
        open_todo: runtime.todo.openCount(),
      });
      return jsonResult({
        ok: true,
        non_terminal: true,
        status_note: note,
        guidance:
          "This note does not end the engagement. Continue testing. Product conclusions require finding(confirm)+evidence_ids. Harness ends the session on budget/continue-cap.",
      });
    },
  };
}

/** Alias factory name for status */
export const createStatusTool = createFinishTool;
