import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  conversionMetrics,
  finishCompletedEligibility,
  formatCandidate,
  nextVerifyGuidance,
} from "../runtime/detection-conversion.js";
import { resolveEffectiveEngagement } from "../runtime/engagement.js";
import type { FinishScanState, PlatformMessage, ToolRuntime } from "../types.js";
import { emitPlanUpdate, jsonResult, textResult } from "./common.js";

const statuses = ["completed", "incomplete", "blocked"] as const;

export function createFinishScanTool(runtime: ToolRuntime): ToolDefinition<any> {
  return {
    name: "finish_scan",
    label: "Finish Scan",
    description:
      "Finish the authorized task lifecycle. Completion gates depend on engagement (assess vs verify/retest/consult) derived from the workflow you ran or an explicit task.engagement field.",
    promptSnippet: "Finish the task lifecycle with a final status and concise report",
    promptGuidelines: [
      "Call finish_scan exactly once when the task is ready to end.",
      "For assess (pentest-web): status='completed' only after high-priority observed candidates, risk families, and multi-actor probes (when required) are resolved.",
      "For verify/retest/consult: status='completed' when the hypothesis/retest outcome or consultation answer is done — full-site conversion gates do not apply.",
      "Use status='incomplete' or status='blocked' when blockers prevent finishing the chosen engagement.",
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

      const coverageRows = await runtime.coverage.list();
      const actorCount = runtime.actors?.count() ?? 0;
      const engagementInfo = resolveEffectiveEngagement(runtime.task, runtime.workflowRuns);
      const eligibility = finishCompletedEligibility(coverageRows, {
        status,
        confirmedFindings: stringArray(params.confirmed_findings),
        actorCount,
        engagement: engagementInfo.engagement,
      });
      if (status === "completed" && !eligibility.allowed) {
        const metrics = conversionMetrics(coverageRows);
        return jsonResult({
          ok: false,
          blocked: true,
          error: "finish_scan(completed) rejected: coverage conversion or risk-family gaps remain",
          reason: eligibility.reason,
          engagement: engagementInfo,
          untested_high_priority: eligibility.untestedHighPriority.map(formatCandidate),
          missing_risk_families: eligibility.missingRiskFamilies,
          actors: runtime.actors?.summary?.() ?? { count: actorCount },
          conversion: metrics,
          guidance: nextVerifyGuidance(
            eligibility.untestedHighPriority,
            evidenceIds,
            eligibility.missingRiskFamilies,
          ),
        });
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

      const metrics = conversionMetrics(coverageRows);
      return jsonResult(
        {
          ok: true,
          path,
          finish_scan: state,
          conversion: metrics,
          untested_high_priority: eligibility.untestedHighPriority.map(formatCandidate),
        },
        { finishScanStatus: status },
      );
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
