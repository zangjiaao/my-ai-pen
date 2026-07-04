import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { CoverageStatus, ToolRuntime } from "../types.js";
import { emitPlanUpdate, jsonResult, textResult } from "./common.js";

const statuses = ["tried", "passed", "failed", "blocked", "skipped"] as const;

export function createCoverageTool(runtime: ToolRuntime): ToolDefinition<any> {
  return {
    name: "coverage",
    label: "Coverage",
    description: "Track tested endpoint/parameter/vulnerability-class tuples and maintain the Plan Tree/TODO notebook. Use it to avoid repeating probes and to remember attack surface, planned tests, blockers, and reporting work.",
    promptSnippet: "Track endpoint/parameter coverage and maintain Plan Tree TODOs",
    promptGuidelines: [
      "Use coverage(action='untested') before broad probing and coverage(action='mark') after each meaningful test.",
      "Use coverage(action='plan') to add or update Plan Tree TODOs for discovered attack surface, planned vulnerability tests, blockers, and report tasks.",
      "Keep plan nodes current: pending for queued work, running for active work, done for completed tests, blocked for missing access/tooling.",
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
      if (params.action === "summary") {
        return jsonResult(await runtime.coverage.summary());
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
          endpoint: params.endpoint,
          parameter: params.param,
          vuln_type: params.vuln_class,
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
      return textResult("error: action must be mark, list, untested, summary, plan, or plan_list");
    },
  };
}
