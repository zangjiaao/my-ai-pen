import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { FinishScanState, PlatformMessage, ToolRuntime } from "../types.js";
import { emitPlanUpdate, jsonResult, textResult } from "./common.js";

const statuses = ["completed", "incomplete", "blocked"] as const;

export function createFinishScanTool(runtime: ToolRuntime): ToolDefinition<any> {
  return {
    name: "finish_scan",
    label: "Finish Scan",
    description:
      "Finish the authorized scan lifecycle. This is the only valid way to request final task completion after workflow, recon, testing, evidence, and reporting are done.",
    promptSnippet: "Finish the scan lifecycle with a final status and concise report",
    promptGuidelines: [
      "Call finish_scan exactly once when the scan is ready to end.",
      "Use status='completed' only after pentest-web completed, tools are idle, and all confirmed findings have valid evidence_ids.",
      "Use status='incomplete' or status='blocked' when login, scope, tooling, time, or runtime gates prevent completion.",
      "Include a concise summary, confirmed finding titles, coverage gaps, blockers, and evidence_ids that support the final report.",
    ],
    parameters: Type.Object({
      status: Type.String(),
      summary: Type.String(),
      confirmed_findings: Type.Optional(Type.Array(Type.String())),
      coverage_gaps: Type.Optional(Type.Array(Type.String())),
      blockers: Type.Optional(Type.Array(Type.String())),
      evidence_ids: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(toolCallId: string, params: any) {
      const status = normalizeStatus(params.status);
      if (!status) return textResult("error: status must be completed, incomplete, or blocked");
      const summary = String(params.summary || "").trim();
      if (!summary) return textResult("error: summary is required");

      const evidenceIds = stringArray(params.evidence_ids);
      const missingEvidenceIds = [];
      for (const id of evidenceIds) {
        if (!(await runtime.evidence.read(id))) missingEvidenceIds.push(id);
      }
      if (missingEvidenceIds.length > 0) {
        return textResult(`error: evidence_ids not found: ${missingEvidenceIds.join(", ")}`);
      }

      const state: FinishScanState = {
        status,
        summary,
        confirmedFindings: stringArray(params.confirmed_findings),
        coverageGaps: stringArray(params.coverage_gaps),
        blockers: stringArray(params.blockers),
        evidenceIds,
        calledAt: new Date().toISOString(),
        toolCallId,
      };
      runtime.lifecycle.finishScan = state;

      const dir = join(runtime.workspaceDir, runtime.task.taskId);
      await mkdir(dir, { recursive: true });
      const path = join(dir, "finish-scan.json");
      await writeFile(path, JSON.stringify(state, null, 2), "utf8");

      await runtime.platform.send({
        type: "finish_scan_requested",
        conversation_id: runtime.task.conversationId,
        task_id: runtime.task.taskId,
        status,
        summary,
        confirmed_findings: state.confirmedFindings,
        coverage_gaps: state.coverageGaps,
        blockers: state.blockers,
        evidence_ids: evidenceIds,
      } as PlatformMessage);
      await emitPlanUpdate(runtime, "finish_scan");

      return jsonResult({ ok: true, path, finish_scan: state }, { finishScanStatus: status });
    },
  };
}

function normalizeStatus(value: unknown): FinishScanState["status"] | undefined {
  const raw = String(value || "").trim().toLowerCase();
  if (statuses.includes(raw as FinishScanState["status"])) return raw as FinishScanState["status"];
  return undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || "").trim()).filter(Boolean);
}
