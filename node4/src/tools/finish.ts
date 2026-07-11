import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { allowCompletedDespiteCoverageGaps } from "../runtime/finish-settlement.js";
import type { FinishScanState, ToolRuntime } from "../types.js";
import { loadConfirmedFindings } from "./finding.js";
import { jsonResult, textResult } from "./common.js";

/**
 * Single finish settlement. Open todo never blocks completed.
 * completed requires evidence-backed findings OR explicit incomplete-style no-finding note is not forced —
 * empty completed without findings is rejected to avoid vacuous success.
 */
export function createFinishTool(runtime: ToolRuntime): ToolDefinition<any> {
  return {
    name: "finish_scan",
    label: "Finish",
    description:
      "End the task once. status=completed needs disk-confirmed findings with evidence (or use incomplete). Open todo does not block completed.",
    parameters: Type.Object({
      status: Type.String(),
      summary: Type.String(),
      evidence_ids: Type.Optional(Type.Array(Type.String())),
      blockers: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(toolCallId: string, params: any) {
      const status = normalizeStatus(params.status);
      if (!status) return textResult("error: status must be completed, incomplete, or blocked");
      const summary = String(params.summary || "").trim();
      if (!summary) return textResult("error: summary required");

      const aggregated = await loadConfirmedFindings(runtime.findingsDir);
      const evidenceIds = unique([
        ...(Array.isArray(params.evidence_ids) ? params.evidence_ids.map(String) : []),
        ...aggregated.evidenceIds,
      ]);
      for (const id of evidenceIds) {
        if (!(await runtime.evidence.read(id))) return textResult(`error: evidence not found: ${id}`);
      }

      // No conversion matrix. Only block vacuous completed (no findings).
      if (
        status === "completed" &&
        !allowCompletedDespiteCoverageGaps({
          eligibilityAllowed: aggregated.count > 0,
          confirmedFindingCount: aggregated.count,
        })
      ) {
        return jsonResult({
          ok: false,
          blocked: true,
          error: "finish_scan(completed) requires at least one confirmed finding with evidence, or use status=incomplete",
          open_todo: runtime.todo.openCount(),
        });
      }

      const state: FinishScanState = {
        status,
        summary,
        confirmedFindings: aggregated.titles,
        findingsDedupedCount: aggregated.count,
        evidenceIds,
        calledAt: new Date().toISOString(),
        toolCallId,
      };
      runtime.lifecycle.finishScan = state;
      await writeFile(join(runtime.taskDir, "finish-scan.json"), JSON.stringify(state, null, 2), "utf8");
      await runtime.platform.send({
        type: "finish_scan_requested",
        conversation_id: runtime.task.conversationId,
        task_id: runtime.task.taskId,
        status,
        summary,
        confirmed_findings: state.confirmedFindings,
        evidence_ids: evidenceIds,
        open_todo: runtime.todo.openCount(),
      });
      return jsonResult({
        ok: true,
        finish_scan: state,
        open_todo: runtime.todo.openCount(),
        guidance: "Open todo does not block completion. Session must emit task_complete with the same status.",
      });
    },
  };
}

function normalizeStatus(value: unknown): FinishScanState["status"] | undefined {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "completed" || raw === "incomplete" || raw === "blocked") return raw;
  return undefined;
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}
