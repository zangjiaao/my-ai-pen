import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  findExistingConfirmedByKey,
  preferFindingRecord,
  type PersistedFindingRecord,
} from "../runtime/findings-aggregate.js";
import type { PlatformMessage, ToolRuntime } from "../types.js";
import { emitPlanUpdate, jsonResult, targetBase, textResult } from "./common.js";

export function createFindingTool(runtime: ToolRuntime): ToolDefinition<any> {
  return {
    name: "finding",
    label: "Finding",
    description:
      "Record candidate, confirmed, or rejected findings. Confirmed findings require at least one evidence_id from http, scan, browser, verifier, or poc output. Re-confirming the same class+endpoint is a no-op update (no duplicate card).",
    promptSnippet: "Record candidate/confirmed/rejected findings",
    promptGuidelines: [
      "Use finding(action='candidate') for plausible issues; use finding(action='confirm') only with evidence_id proving end-to-end reproduction.",
      "Immediately confirm each validated issue as soon as evidence exists; do not batch confirmed findings at the end.",
      "A confirmed finding must include location/url, impact or description, reproduction steps or PoC, remediation, severity, and evidence_ids.",
      "Do not re-confirm the same vulnerability class on the same endpoint with a reworded title — the tool merges duplicates.",
    ],
    parameters: Type.Object({
      action: Type.String(),
      title: Type.String(),
      severity: Type.Optional(Type.String()),
      url: Type.Optional(Type.String()),
      location: Type.Optional(Type.String()),
      affected_asset: Type.Optional(Type.String()),
      evidence_ids: Type.Optional(Type.Array(Type.String())),
      confidence: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
      impact: Type.Optional(Type.String()),
      reproduction: Type.Optional(Type.String()),
      poc: Type.Optional(Type.String()),
      remediation: Type.Optional(Type.String()),
      reason: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId: string, params: any) {
      const action = params.action;
      const evidenceIds = params.evidence_ids || [];
      if (action === "confirm" && evidenceIds.length === 0) {
        return textResult("error: confirmed finding requires evidence_ids");
      }
      if (action === "confirm") {
        const missingEvidenceIds = [];
        for (const id of evidenceIds) {
          if (!(await runtime.evidence.read(id))) missingEvidenceIds.push(id);
        }
        if (missingEvidenceIds.length > 0) {
          return textResult(`error: evidence_ids not found: ${missingEvidenceIds.join(", ")}`);
        }
      }
      const severity = normalizeSeverity(params.severity);
      const location = stringValue(params.location || params.url || params.affected_asset);
      const affectedAsset = stringValue(params.affected_asset || params.url || targetBase(runtime));
      const description = stringValue(params.description || params.impact);
      const poc = stringValue(params.poc || params.reproduction || params.location || params.url);
      const record: PersistedFindingRecord = {
        ...params,
        action,
        title: params.title,
        severity,
        location,
        affected_asset: affectedAsset,
        evidence_ids: evidenceIds,
        created_at: new Date().toISOString(),
      };
      const dir = join(runtime.workspaceDir, runtime.task.taskId, "findings");
      await mkdir(dir, { recursive: true });

      // Suppress double-confirm (main + worker) of the same class+endpoint.
      if (action === "confirm") {
        const existing = await findExistingConfirmedByKey(dir, record);
        if (existing) {
          const merged = preferFindingRecord(existing.record, record);
          const path = join(dir, existing.fileName);
          await writeFile(path, JSON.stringify({ ...merged, updated_at: new Date().toISOString() }, null, 2), "utf8");
          return jsonResult({
            ok: true,
            deduped: true,
            path,
            record: merged,
            message:
              "Merged into existing confirmed finding for the same vulnerability class and endpoint family; no additional vuln card emitted.",
          });
        }
      }

      const path = join(dir, `${slug(params.title)}-${Date.now()}.json`);
      await writeFile(path, JSON.stringify(record, null, 2), "utf8");
      if (action === "confirm") {
        runtime.plan.findingConfirmed({
          title: params.title,
          severity,
          location,
          evidenceIds,
        });
        await runtime.platform.send({
          type: "vuln_found",
          conversation_id: runtime.task.conversationId,
          task_id: runtime.task.taskId,
          title: params.title,
          severity,
          status: "confirmed",
          url: params.url,
          location,
          affected_asset: affectedAsset,
          // Prefer a stable finding key so platform message dedupe does not collapse
          // unrelated findings that happen to share an evidence id.
          id: `finding:${slug(params.title)}:${slug(location || String(params.url || "unknown"))}`,
          evidence_id: evidenceIds[0],
          evidence_ids: evidenceIds,
          confidence: params.confidence || "high",
          description,
          impact: params.impact,
          reproduction: params.reproduction,
          poc,
          remediation: params.remediation,
        } as PlatformMessage);
        await emitPlanUpdate(runtime, "finding.confirm");
      }
      return jsonResult({ ok: true, path, record, deduped: false });
    },
  };
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 80) || "finding";
}

function normalizeSeverity(value: unknown): string {
  const raw = String(value || "medium").trim().toLowerCase();
  if (["critical", "high", "medium", "low", "info"].includes(raw)) return raw;
  return "medium";
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
