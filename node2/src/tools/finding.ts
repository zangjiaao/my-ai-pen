import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { PlatformMessage, ToolRuntime } from "../types.js";
import { jsonResult, textResult } from "./common.js";

export function createFindingTool(runtime: ToolRuntime): ToolDefinition<any> {
  return {
    name: "finding",
    label: "Finding",
    description: "Record candidate, confirmed, or rejected findings. Confirmed findings require at least one evidence_id from http, scan, browser, or poc output.",
    promptSnippet: "Record candidate/confirmed/rejected findings",
    promptGuidelines: [
      "Use finding(action='candidate') for plausible issues; use finding(action='confirm') only with evidence_id proving end-to-end reproduction.",
    ],
    parameters: Type.Object({
      action: Type.String(),
      title: Type.String(),
      severity: Type.Optional(Type.String()),
      url: Type.Optional(Type.String()),
      evidence_ids: Type.Optional(Type.Array(Type.String())),
      impact: Type.Optional(Type.String()),
      reproduction: Type.Optional(Type.String()),
      remediation: Type.Optional(Type.String()),
      reason: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId: string, params: any) {
      const action = params.action;
      const evidenceIds = params.evidence_ids || [];
      if (action === "confirm" && evidenceIds.length === 0) {
        return textResult("error: confirmed finding requires evidence_ids");
      }
      const record = { ...params, evidence_ids: evidenceIds, created_at: new Date().toISOString() };
      const dir = join(runtime.workspaceDir, runtime.task.taskId, "findings");
      await mkdir(dir, { recursive: true });
      const path = join(dir, `${slug(params.title)}-${Date.now()}.json`);
      await writeFile(path, JSON.stringify(record, null, 2), "utf8");
      if (action === "confirm") {
        await runtime.platform.send({
          type: "vuln_found",
          conversation_id: runtime.task.conversationId,
          task_id: runtime.task.taskId,
          title: params.title,
          severity: params.severity || "medium",
          url: params.url,
          evidence_id: evidenceIds[0],
          evidence_ids: evidenceIds,
          impact: params.impact,
          reproduction: params.reproduction,
          remediation: params.remediation,
        } as PlatformMessage);
      }
      return jsonResult({ ok: true, path, record });
    },
  };
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 80) || "finding";
}
