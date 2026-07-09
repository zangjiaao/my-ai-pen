import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  conversionMetrics,
  materialUntestedHighPriority,
  missingRiskFamiliesFromCoverage,
  nextVerifyGuidance,
} from "../runtime/detection-conversion.js";
import type { CoverageStatus, ToolRuntime } from "../types.js";
import { emitPlanUpdate, jsonResult, textResult } from "./common.js";

const statuses = ["observed", "tried", "passed", "failed", "blocked", "skipped"] as const;

export function createCoverageTool(runtime: ToolRuntime): ToolDefinition<any> {
  return {
    name: "coverage",
    label: "Coverage",
    description: "Track tested endpoint/parameter/vulnerability-class tuples and maintain the compact user-facing workflow plan. Use it to avoid repeating probes and to remember attack surface, planned tests, blockers, and summary work. Actions: mark, list, untested, priority_candidates, family_gaps, conversion, summary, plan, plan_list.",
    promptSnippet: "Track endpoint/parameter coverage and maintain the workflow plan",
    promptGuidelines: [
      "Use coverage(action='priority_candidates') or family_gaps/conversion after recon to pick the next high-priority observed tests and missing risk families.",
      "Use coverage(action='untested') before broad probing and coverage(action='mark') after each meaningful test.",
      "Use coverage(action='plan') to add or update user-facing workflow plan items. Use stable node_id values.",
      "Use parent_id exactly to group plan items: workflow-recon, workflow-testing, workflow-verification, or workflow-summary.",
      "Keep plan nodes current: pending for queued work, running for active work, done for completed work, blocked for missing access/tooling, skipped for deliberately ignored low-value work.",
    ],
    parameters: Type.Object({
      action: Type.String(),
      endpoint: Type.Optional(Type.String()),
      param: Type.Optional(Type.String()),
      vuln_class: Type.Optional(Type.String()),
      status: Type.Optional(Type.String()),
      notes: Type.Optional(Type.String()),
      node_id: Type.Optional(Type.String()),
      title: Type.Optional(Type.String()),
      parent_id: Type.Optional(Type.String()),
      kind: Type.Optional(Type.String()),
      method: Type.Optional(Type.String()),
      result: Type.Optional(Type.String()),
      priority: Type.Optional(Type.Number()),
      candidates: Type.Optional(Type.Array(Type.Object({ endpoint: Type.String(), param: Type.String() }))),
      vuln_classes: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_toolCallId: string, params: any) {
      if (params.action === "mark") {
        if (!params.endpoint || !params.param || !params.vuln_class) {
          return textResult("error: mark requires endpoint, param, vuln_class");
        }
        const status = statuses.includes(params.status as CoverageStatus) ? (params.status as CoverageStatus) : "tried";
        const row = await runtime.coverage.mark({
          endpoint: params.endpoint,
          param: params.param,
          vulnClass: params.vuln_class,
          status,
          notes: params.notes,
        });
        runtime.plan.coverageMark({
          endpoint: params.endpoint,
          param: params.param,
          vulnClass: params.vuln_class,
          status,
          notes: params.notes,
        });
        await emitPlanUpdate(runtime, "coverage.mark");
        return jsonResult(row);
      }
      if (params.action === "list") {
        return jsonResult(await runtime.coverage.list({
          endpoint: params.endpoint,
          param: params.param,
          vulnClass: params.vuln_class,
        }));
      }
      if (params.action === "untested") {
        return jsonResult(await runtime.coverage.untested(params.candidates || [], params.vuln_classes || []));
      }
      if (params.action === "priority_candidates") {
        const rows = await runtime.coverage.list();
        const untested = materialUntestedHighPriority(rows);
        const familyGaps = missingRiskFamiliesFromCoverage(rows);
        return jsonResult({
          count: untested.length,
          candidates: untested,
          missing_risk_families: familyGaps,
          guidance: nextVerifyGuidance(untested, [], familyGaps),
        });
      }
      if (params.action === "family_gaps") {
        const rows = await runtime.coverage.list();
        const familyGaps = missingRiskFamiliesFromCoverage(rows);
        return jsonResult({
          count: familyGaps.length,
          missing_risk_families: familyGaps,
          guidance: nextVerifyGuidance([], [], familyGaps),
        });
      }
      if (params.action === "conversion") {
        const rows = await runtime.coverage.list();
        return jsonResult(conversionMetrics(rows));
      }
      if (params.action === "summary") {
        const summary = await runtime.coverage.summary();
        const rows = await runtime.coverage.list();
        return jsonResult({
          ...summary,
          conversion: conversionMetrics(rows),
          priority_untested: materialUntestedHighPriority(rows).slice(0, 20),
          missing_risk_families: missingRiskFamiliesFromCoverage(rows),
        });
      }
      if (params.action === "plan") {
        if (!params.title) return textResult("error: plan requires title");
        const node = runtime.plan.upsert({
          node_id: params.node_id,
          title: params.title,
          status: params.status,
          kind: params.kind || "task",
          level: "work_item",
          parent_id: params.parent_id,
          method: params.method,
          endpoint: params.endpoint,
          parameter: params.param,
          vuln_type: params.vuln_class,
          result: params.result,
          notes: params.notes,
          priority: params.priority,
          source: "agent",
        });
        await emitPlanUpdate(runtime, "coverage.plan");
        return jsonResult(node);
      }
      if (params.action === "plan_list") {
        return jsonResult(runtime.plan.snapshot());
      }
      return textResult("error: action must be mark, list, untested, priority_candidates, family_gaps, conversion, summary, plan, or plan_list");
    },
  };
}
