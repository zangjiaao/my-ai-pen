import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  attackSurfaceGaps,
  bulkSkipResolutionGaps,
  conversionMetrics,
  formatDiscoveryQueuePayload,
  isSubstantiveSkipNotes,
  materialUntestedHighPriority,
  missingRiskFamiliesFromCoverage,
  multiActorTestingGaps,
  surfaceInventoryFromTraffic,
  weakSkipHighPriority,
} from "../runtime/detection-conversion.js";
import type { CoverageStatus, ToolRuntime } from "../types.js";
import { emitPlanUpdate, jsonResult, textResult } from "./common.js";

const statuses = ["observed", "tried", "passed", "failed", "blocked", "skipped"] as const;

export function createCoverageTool(runtime: ToolRuntime): ToolDefinition<any> {
  return {
    name: "coverage",
    label: "Coverage",
    description:
      "Track tested endpoint/parameter/vuln-class tuples (navigation/memory). Prefer the todo tool for user-facing Tasks. Actions: mark, list, untested, priority_candidates, next_work, family_gaps, surface_quality, conversion, summary, plan, plan_list.",
    promptSnippet: "Track coverage and fetch mid-run next_work (todo owns Tasks UI)",
    promptGuidelines: [
      "Prefer todo for user-facing progress (Harness v2). coverage is navigation/memory, not a finish gate ceremony.",
      "After recon and early findings, coverage(action='next_work') can suggest live probes — then act with http/browser/poc.",
      "Use coverage(action='mark') after meaningful tests. Skips need substantive notes.",
      "coverage(plan) is legacy; open plan items do NOT block finish_scan(completed).",
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
        const notes = typeof params.notes === "string" ? params.notes : undefined;
        if ((status === "skipped" || status === "blocked") && !isSubstantiveSkipNotes(notes)) {
          return jsonResult({
            ok: false,
            error:
              "skipped/blocked marks require substantive notes (≥24 chars with a concrete reason such as credentials, scope, tooling, duplicate pattern, or not applicable). " +
              "Weak skips do not satisfy finish_scan(completed).",
            status,
            notes: notes || null,
          });
        }
        const row = await runtime.coverage.mark({
          endpoint: params.endpoint,
          param: params.param,
          vulnClass: params.vuln_class,
          status,
          notes,
        });
        runtime.plan.coverageMark({
          endpoint: params.endpoint,
          param: params.param,
          vulnClass: params.vuln_class,
          status,
          notes,
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
        const familyGaps = collectAssessGaps(runtime, rows);
        const inventory = surfaceInventoryFromTraffic(runtime.traffic);
        const actorSummary = runtime.actors?.summary?.() ?? { count: 0, actors: [] as Array<{ hasAuth?: boolean }> };
        const actorAuthCount = Array.isArray(actorSummary.actors)
          ? actorSummary.actors.filter((actor) => Boolean(actor?.hasAuth)).length
          : 0;
        const queue = formatDiscoveryQueuePayload(rows, {
          familyGaps,
          surfaceInventory: inventory,
          actorCount: Number(actorSummary.count || 0),
          actorAuthCount,
        });
        return jsonResult({
          count: untested.length,
          candidates: untested,
          weak_skips: weakSkipHighPriority(rows),
          missing_risk_families: familyGaps,
          next_work: queue.next_work,
          guidance: queue.guidance,
        });
      }
      if (params.action === "next_work") {
        const rows = await runtime.coverage.list();
        const inventory = surfaceInventoryFromTraffic(runtime.traffic);
        const actorSummary = runtime.actors?.summary?.() ?? { count: 0, actors: [] as Array<{ hasAuth?: boolean }> };
        const actorAuthCount = Array.isArray(actorSummary.actors)
          ? actorSummary.actors.filter((actor) => Boolean(actor?.hasAuth)).length
          : 0;
        const familyGaps = collectAssessGaps(runtime, rows);
        const queue = formatDiscoveryQueuePayload(rows, {
          familyGaps,
          surfaceInventory: inventory,
          actorCount: Number(actorSummary.count || 0),
          actorAuthCount,
          limit: 12,
        });
        return jsonResult({
          ok: true,
          action: "next_work",
          count: queue.count,
          next_work: queue.next_work,
          guidance: queue.guidance,
          surface_inventory: inventory,
          actors: actorSummary,
          instruction:
            "Execute next_work[0..2] with live verifier/http/browser/traffic tools before any further coverage skip/block marks or finish_scan(completed).",
        });
      }
      if (params.action === "family_gaps") {
        const rows = await runtime.coverage.list();
        const familyGaps = collectAssessGaps(runtime, rows);
        const inventory = surfaceInventoryFromTraffic(runtime.traffic);
        const actorSummary = runtime.actors?.summary?.() ?? { count: 0, actors: [] as Array<{ hasAuth?: boolean }> };
        const actorAuthCount = Array.isArray(actorSummary.actors)
          ? actorSummary.actors.filter((actor) => Boolean(actor?.hasAuth)).length
          : 0;
        const queue = formatDiscoveryQueuePayload(rows, {
          familyGaps,
          surfaceInventory: inventory,
          actorCount: Number(actorSummary.count || 0),
          actorAuthCount,
        });
        return jsonResult({
          count: familyGaps.length,
          missing_risk_families: familyGaps,
          next_work: queue.next_work,
          guidance: queue.guidance,
        });
      }
      if (params.action === "surface_quality") {
        const rows = await runtime.coverage.list();
        const inventory = surfaceInventoryFromTraffic(runtime.traffic);
        const actorSummary = runtime.actors?.summary?.() ?? { count: 0, actors: [] as Array<{ hasAuth?: boolean }> };
        const actorAuthCount = Array.isArray(actorSummary.actors)
          ? actorSummary.actors.filter((actor) => Boolean(actor?.hasAuth)).length
          : 0;
        const surface = attackSurfaceGaps(rows, inventory);
        const multiActor = multiActorTestingGaps(rows, Number(actorSummary.count || 0), actorAuthCount);
        const bulk = bulkSkipResolutionGaps(rows);
        const families = missingRiskFamiliesFromCoverage(rows);
        const allGaps = [...surface, ...multiActor, ...bulk, ...families];
        const queue = formatDiscoveryQueuePayload(rows, {
          familyGaps: allGaps,
          surfaceInventory: inventory,
          actorCount: Number(actorSummary.count || 0),
          actorAuthCount,
        });
        return jsonResult({
          surface_inventory: inventory,
          actors: actorSummary,
          attack_surface_gaps: surface,
          multi_actor_gaps: multiActor,
          bulk_skip_gaps: bulk,
          missing_risk_families: families,
          weak_skips: weakSkipHighPriority(rows),
          priority_untested: materialUntestedHighPriority(rows).slice(0, 20),
          next_work: queue.next_work,
          guidance: queue.guidance,
        });
      }
      if (params.action === "conversion") {
        const rows = await runtime.coverage.list();
        return jsonResult(conversionMetrics(rows));
      }
      if (params.action === "summary") {
        const summary = await runtime.coverage.summary();
        const rows = await runtime.coverage.list();
        const inventory = surfaceInventoryFromTraffic(runtime.traffic);
        const actorSummary = runtime.actors?.summary?.() ?? { count: 0, actors: [] as Array<{ hasAuth?: boolean }> };
        const actorAuthCount = Array.isArray(actorSummary.actors)
          ? actorSummary.actors.filter((actor) => Boolean(actor?.hasAuth)).length
          : 0;
        const familyGaps = collectAssessGaps(runtime, rows);
        const queue = formatDiscoveryQueuePayload(rows, {
          familyGaps,
          surfaceInventory: inventory,
          actorCount: Number(actorSummary.count || 0),
          actorAuthCount,
        });
        return jsonResult({
          ...summary,
          conversion: conversionMetrics(rows),
          priority_untested: materialUntestedHighPriority(rows).slice(0, 20),
          weak_skips: weakSkipHighPriority(rows),
          missing_risk_families: familyGaps,
          surface_inventory: inventory,
          next_work: queue.next_work,
          guidance: queue.guidance,
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
        const openChecklist = runtime.plan.openIntentionalChecklist?.() || [];
        return jsonResult({
          ok: true,
          node,
          open_checklist: openChecklist.map((item) => ({
            node_id: item.node_id,
            title: item.title,
            status: item.status,
            kind: item.kind,
          })),
          open_count: openChecklist.length,
          guidance:
            openChecklist.length > 0
              ? "Legacy plan rows still open — prefer the todo tool for Tasks. Open plan items do not block finish_scan(completed)."
              : "No open legacy plan rows. Prefer todo for progress; finish when evidence and engagement allow.",
        });
      }
      if (params.action === "plan_list") {
        const rows = runtime.plan.snapshot();
        const openChecklist = runtime.plan.openIntentionalChecklist?.() || [];
        return jsonResult({
          plan: rows,
          open_checklist: openChecklist.map((item) => ({
            node_id: item.node_id,
            title: item.title,
            status: item.status,
            kind: item.kind,
          })),
          open_count: openChecklist.length,
        });
      }
      return textResult(
        "error: action must be mark, list, untested, priority_candidates, next_work, family_gaps, surface_quality, conversion, summary, plan, or plan_list",
      );
    },
  };
}

function collectAssessGaps(runtime: ToolRuntime, rows: Awaited<ReturnType<ToolRuntime["coverage"]["list"]>>) {
  const inventory = surfaceInventoryFromTraffic(runtime.traffic);
  const actorSummary = runtime.actors?.summary?.() ?? { count: 0, actors: [] as Array<{ hasAuth?: boolean }> };
  const actorAuthCount = Array.isArray(actorSummary.actors)
    ? actorSummary.actors.filter((actor) => Boolean(actor?.hasAuth)).length
    : 0;
  return [
    ...missingRiskFamiliesFromCoverage(rows),
    ...attackSurfaceGaps(rows, inventory),
    ...multiActorTestingGaps(rows, Number(actorSummary.count || 0), actorAuthCount),
    ...bulkSkipResolutionGaps(rows),
  ];
}
