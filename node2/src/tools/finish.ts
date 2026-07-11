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
import { allowCompletedDespiteCoverageGaps } from "../runtime/finish-settlement.js";
import {
  alignSummaryFindingCount,
  loadAggregatedConfirmedFindings,
} from "../runtime/findings-aggregate.js";
import {
  assessWorkerDispatchGate,
  loadWorkPackagesFromTaskDir,
} from "../runtime/work-packages.js";
import {
  assessOpenWorkerPackageGate,
  unresolvedWorkerPackages,
} from "../runtime/worker-packages.js";
import type { FinishScanState, PlatformMessage, ToolRuntime } from "../types.js";
import { emitPlanUpdate, jsonResult, textResult } from "./common.js";

const statuses = ["completed", "incomplete", "blocked"] as const;

export function createFinishScanTool(runtime: ToolRuntime): ToolDefinition<any> {
  return {
    name: "finish_scan",
    label: "Finish Scan",
    description:
      "Finish the authorized task lifecycle (Harness v2). Evidence-oriented: open todo/checklist never blocks completed. Assess with disk-confirmed findings may complete even if coverage navigation still has soft gaps.",
    promptSnippet: "Finish the task lifecycle with a final status and concise report",
    promptGuidelines: [
      "Call finish_scan exactly once when the task is ready to end.",
      "Open todo items and coverage(plan) checklist do NOT block finish_scan(completed).",
      "For assess: prefer status='completed' when you have evidence-backed findings (or a clear no-finding after real attempts). Use incomplete when work remains without evidence outcomes.",
      "For verify/retest/consult: status='completed' when the engagement goal is done — full-site conversion gates do not apply.",
      "Workers are optional; zero workers does not block completed.",
      "confirmed_findings is optional narrative; finish_scan loads and dedupes confirmed findings from the findings/ directory as the authoritative list.",
      "Include a concise summary, coverage gaps, blockers, and evidence_ids that support the final report.",
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

      const taskDir = join(runtime.workspaceDir, runtime.task.taskId);
      const findingsDir = join(taskDir, "findings");
      const aggregated = await loadAggregatedConfirmedFindings(findingsDir);
      const llmTitles = stringArray(params.confirmed_findings);
      // Disk-confirmed findings are authoritative; LLM titles are optional hints only.
      const confirmedFindings = aggregated.titles.length > 0 ? aggregated.titles : [];

      const evidenceIds = uniqueStrings([...stringArray(params.evidence_ids), ...aggregated.evidenceIds]);
      const missingEvidenceIds = [];
      for (const id of evidenceIds) {
        if (!(await runtime.evidence.read(id))) missingEvidenceIds.push(id);
      }
      if (missingEvidenceIds.length > 0) {
        return textResult(`error: evidence_ids not found: ${missingEvidenceIds.join(", ")}`);
      }

      // Harness v2: open intentional checklist / todo never hard-blocks completed.
      const openChecklist = runtime.plan.openIntentionalChecklist?.() || [];
      const todoOpen = runtime.todo?.openCount?.() ?? 0;

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
        confirmedFindings,
        actorCount,
        actorAuthCount,
        engagement: engagementInfo.engagement,
        surfaceInventory,
      });
      // Evidence-oriented: disk-confirmed findings allow completed despite soft coverage gaps.
      // Without findings, keep assess conversion gates so completed is not empty-booked.
      const hasEvidenceFindings = confirmedFindings.length > 0;
      if (
        status === "completed" &&
        !allowCompletedDespiteCoverageGaps({
          eligibilityAllowed: eligibility.allowed,
          confirmedFindingCount: confirmedFindings.length,
        })
      ) {
        const metrics = conversionMetrics(coverageRows);
        const queue = formatDiscoveryQueuePayload(coverageRows, {
          familyGaps: eligibility.missingRiskFamilies,
          surfaceInventory,
          actorCount,
          actorAuthCount,
          confirmedEvidenceIds: evidenceIds,
          limit: 8,
        });
        const rejectCount = Number(runtime.lifecycle.finishCompletedRejects || 0) + 1;
        runtime.lifecycle.finishCompletedRejects = rejectCount;
        const thrash = rejectCount >= 2;
        return jsonResult({
          ok: false,
          blocked: true,
          guidance: thrash
            ? "finish_scan(completed) rejected repeatedly with no confirmed findings. Call finish_scan(status='incomplete') once, or keep probing next_work."
            : queue.guidance,
          next_work: thrash ? [] : queue.next_work,
          instruction: thrash
            ? "STOP retrying completed without evidence. Use status='incomplete' or confirm findings with evidence_ids first."
            : "Execute live probes (http/browser/poc/verifier) and finding(confirm) with evidence, or finish_scan(status='incomplete'). Open todo does not need to be empty.",
          error: "finish_scan(completed) rejected: no evidence-backed findings and coverage/assess gaps remain",
          reason: eligibility.reason,
          completed_reject_count: rejectCount,
          prefer_incomplete: thrash,
          engagement: engagementInfo,
          untested_high_priority: eligibility.untestedHighPriority.map(formatCandidate),
          weak_skips: (eligibility.weakSkips || []).map(formatCandidate),
          missing_risk_families: eligibility.missingRiskFamilies,
          surface_gaps: eligibility.surfaceGaps || [],
          surface_inventory: surfaceInventory,
          actors: actorSummary,
          conversion: metrics,
          soft_open_todo: todoOpen,
          soft_open_checklist: openChecklist.length,
          findings_aggregate: {
            raw_count: aggregated.rawCount,
            deduped_count: aggregated.dedupedCount,
            titles: confirmedFindings,
            llm_titles: llmTitles,
          },
        });
      }

      // Workers optional (Harness v2): never hard-block completed on dispatch/open packages.
      const packages = await loadWorkPackagesFromTaskDir(taskDir);
      const workerRunCount = runtime.lifecycle.workerRuns?.length ?? 0;
      const workerGate = assessWorkerDispatchGate({
        engagement: engagementInfo.engagement,
        packages,
        workerRunCount,
        status,
      });
      const openPackages = unresolvedWorkerPackages(runtime.lifecycle);
      const openGate = assessOpenWorkerPackageGate({
        engagement: engagementInfo.engagement,
        status,
        openPackages,
      });
      void workerGate;
      void openGate;

      // Rewrite free-text claim counts so the report matches the authoritative list.
      const alignedSummary = alignSummaryFindingCount(summary, aggregated.dedupedCount);

      const softGaps: string[] = [];
      if (hasEvidenceFindings && !eligibility.allowed) {
        softGaps.push(`soft_coverage_gap: ${eligibility.reason}`);
      }
      if (todoOpen > 0) softGaps.push(`soft_open_todo: ${todoOpen}`);
      if (openChecklist.length > 0) softGaps.push(`soft_open_checklist: ${openChecklist.length}`);
      if (!workerGate.allowed) softGaps.push(`soft_worker_dispatch: ${workerGate.reason}`);
      if (!openGate.allowed) softGaps.push(`soft_open_workers: ${openGate.reason}`);

      const state: FinishScanState = {
        status,
        summary: alignedSummary,
        confirmedFindings,
        llmConfirmedFindings: llmTitles.length > 0 ? llmTitles : undefined,
        findingsRawCount: aggregated.rawCount,
        findingsDedupedCount: aggregated.dedupedCount,
        coverageGaps: uniqueStrings([...stringArray(params.coverage_gaps), ...softGaps]),
        blockers: stringArray(params.blockers),
        evidenceIds,
        calledAt: new Date().toISOString(),
        toolCallId,
      };
      runtime.lifecycle.finishScan = state;
      // Successful incomplete/blocked/completed settles thrash counter.
      if (status === "incomplete" || status === "blocked" || status === "completed") {
        runtime.lifecycle.finishCompletedRejects = 0;
      }

      await mkdir(taskDir, { recursive: true });
      const path = join(taskDir, "finish-scan.json");
      await writeFile(path, JSON.stringify(state, null, 2), "utf8");

      await runtime.platform.send({
        type: "finish_scan_requested",
        conversation_id: runtime.task.conversationId,
        task_id: runtime.task.taskId,
        status,
        summary: alignedSummary,
        confirmed_findings: state.confirmedFindings,
        findings_raw_count: aggregated.rawCount,
        findings_deduped_count: aggregated.dedupedCount,
        llm_confirmed_findings: llmTitles,
        coverage_gaps: state.coverageGaps,
        blockers: state.blockers,
        evidence_ids: evidenceIds,
        worker_run_count: workerRunCount,
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
          findings_aggregate: {
            raw_count: aggregated.rawCount,
            deduped_count: aggregated.dedupedCount,
            titles: confirmedFindings,
            llm_titles: llmTitles,
          },
          worker_dispatch: {
            packages: packages.length,
            worker_runs: workerRunCount,
            gate: workerGate.reason,
          },
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

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}
