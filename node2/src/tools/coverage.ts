import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { CoverageStatus, ToolRuntime } from "../types.js";
import { jsonResult, textResult } from "./common.js";

const statuses = ["tried", "passed", "failed", "blocked", "skipped"] as const;

export function createCoverageTool(runtime: ToolRuntime): ToolDefinition<any> {
  return {
    name: "coverage",
    label: "Coverage",
    description: "Track tested endpoint/parameter/vulnerability-class tuples. Use it to avoid repeating the same probes and to find untested attack surface.",
    promptSnippet: "Track endpoint/parameter/vulnerability coverage",
    promptGuidelines: [
      "Use coverage(action='untested') before broad probing and coverage(action='mark') after each meaningful test.",
    ],
    parameters: Type.Object({
      action: Type.String(),
      endpoint: Type.Optional(Type.String()),
      param: Type.Optional(Type.String()),
      vuln_class: Type.Optional(Type.String()),
      status: Type.Optional(Type.String()),
      notes: Type.Optional(Type.String()),
      candidates: Type.Optional(Type.Array(Type.Object({ endpoint: Type.String(), param: Type.String() }))),
      vuln_classes: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_toolCallId: string, params: any) {
      if (params.action === "mark") {
        if (!params.endpoint || !params.param || !params.vuln_class) {
          return textResult("error: mark requires endpoint, param, vuln_class");
        }
        const status = statuses.includes(params.status as CoverageStatus) ? (params.status as CoverageStatus) : "tried";
        return jsonResult(await runtime.coverage.mark({
          endpoint: params.endpoint,
          param: params.param,
          vulnClass: params.vuln_class,
          status,
          notes: params.notes,
        }));
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
      return textResult("error: action must be mark, list, untested, or summary");
    },
  };
}
