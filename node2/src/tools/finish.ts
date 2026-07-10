import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  conversionMetrics,
  finishCompletedEligibility,
  formatCandidate,
  formatDiscoveryQueuePayload,
  surfaceInventoryFromTraffic,
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
      "For assess (pentest-web): status='completed' only after high-priority candidates are verified (not weak-skipped), risk families are attempted, traffic inventory is used, and multi-actor probes run when the surface is multi-user.",
      "Do not bulk-skip high-priority coverage to force completed; use status='incomplete' when work remains.",
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
      const actorSummary = runtime.actors?.summary?.() ?? { count: runtime.actors?.count() ?? 0, actors: [] as Array<{ hasAuth?: boolean }> };
      const actorCount = Number(actorSummary.count ?? runtime.actors?.count() ?? 0);
      const actorAuthCount = Array.isArray(actorSummary.actors)
        ? actorSummary.actors.filter((actor) => Boolean(actor?.hasAuth)).length
        : actorCount;
      const surfaceInventory = surfaceInventoryFromTraffic(runtime.traffic);
      const engagementInfo = resolveEffectiveEngagement(runtime.task, runtime.workflowRuns);
      const eligibility = finishCompletedEligibility(coverageRows, {
        status,
        confirmedFindings: stringArray(params.confirmed_findings),
        actorCount,
        actorAuthCount,
        engagement: engagementInfo.engagement,
        surfaceInventory,
      });
      if (status === "completed" && !eligibility.allowed) {
        const metrics = conversionMetrics(coverageRows);
        const queue = formatDiscoveryQueuePayload(coverageRows, {
          familyGaps: eligibility.missingRiskFamilies,
          surfaceInventory,
          actorCount,
          actorAuthCount,
          confirmedEvidenceIds: evidenceIds,
          limit: 8,
        });
        // Front-load discovery queue so truncated tool previews still show next live work.
        return jsonResult({
          ok: false,
          blocked: true,
          guidance: queue.guidance,
          next_work: queue.next_work,
          instruction:
            "Execute next_work live probes (verifier/http/browser/traffic) before more coverage skip/block marks. Do not bulk-skip to force completed.",
          error: "finish_scan(completed) rejected: coverage conversion, multi-actor, surface, or skip-discipline gaps remain",
          reason: eligibility.reason,
          engagement: engagementInfo,
          untested_high_priority: eligibility.untestedHighPriority.map(formatCandidate),
          weak_skips: (eligibility.weakSkips || []).map(formatCandidate),
          missing_risk_families: eligibility.missingRiskFamilies,
          surface_gaps: eligibility.surfaceGaps || [],
          surface_inventory: surfaceInventory,
          actors: actorSummary,
          conversion: metrics,
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
