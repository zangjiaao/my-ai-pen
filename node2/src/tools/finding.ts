import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  findExistingConfirmedByKey,
  preferFindingRecord,
  type PersistedFindingRecord,
} from "../runtime/findings-aggregate.js";
import {
  extractFlagToken,
  inferFindingKind,
  looksLikeMixedVulnAndFlag,
} from "../runtime/finding-kind.js";
import type { PlatformMessage, ToolRuntime } from "../types.js";
import { emitPlanUpdate, jsonResult, targetBase, textResult } from "./common.js";

export function createFindingTool(runtime: ToolRuntime): ToolDefinition<any> {
  return {
    name: "finding",
    label: "Finding",
    description:
      "Record one independent high-value result per call: a vuln, an auth/key secret, or a CTF flag. Vuln/Key/Flag are separate objects — never combine them in one confirm. Confirmed findings require at least one evidence_id. Always set finding_kind (vuln|auth|flag).",
    promptSnippet: "Confirm one vuln OR one flag OR one key per finding call (separate objects)",
    promptGuidelines: [
      "Use finding(action='candidate') for plausible issues; use finding(action='confirm') only with evidence_id proving end-to-end reproduction.",
      "Immediately confirm each validated issue as soon as evidence exists; do not batch confirmed findings at the end.",
      "A confirmed finding must include location/url, a short description of the issue, reproduction or PoC, severity, and evidence_ids.",
      "finding_kind is required intent: 'vuln' | 'auth' | 'flag'. Each confirm is exactly one object type.",
      "REQUIRED when both apply: emit TWO confirms — (1) finding_kind='vuln' for the vulnerability, (2) finding_kind='flag' or 'auth' for the captured token/secret. Do not mix flag{...} into a vuln title as the only flag report.",
      "TITLE naming (strict, user-facing cards use this): short, structured, no full sentences or essays. Max ~80 characters.",
      "  vuln title: '<Class> · <METHOD path>' e.g. 'SQL Injection · POST /level9/login', 'IDOR · GET /api/Users/1', 'XSS · /search'. Class first; path second; optional param as 'param=id'.",
      "  flag title: 'Flag · <path>' e.g. 'Flag · /level9/login' (put exact flag{...} in description/poc, not as a prose title).",
      "  auth/key title: '<Subtype> · <path>' e.g. 'JWT · /api/whoami', 'Password · /login', 'API Key · /config'. Subtype in {Password, JWT, API Key, Token, Session, Secret}.",
      "Do NOT use titles like long English paragraphs, .htaccess essays, or 'Found interesting thing while testing…'. Put narrative in description.",
      "description: 1–3 sentences on what the issue is / why it matters (shown under the card). Put reproduction detail in reproduction/poc.",
      "For flags: finding_kind='flag', exact flag{...} in description or poc, location = route obtained.",
      "For keys: finding_kind='auth', secret material in description/poc with location.",
      "Do not re-confirm the same vulnerability class on the same endpoint with a reworded title — the tool merges duplicates.",
    ],
    parameters: Type.Object({
      action: Type.String(),
      title: Type.String(),
      /** vuln | auth | flag — high-value result category for the right panel. */
      finding_kind: Type.Optional(Type.String()),
      kind: Type.Optional(Type.String()),
      category: Type.Optional(Type.String()),
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
      const findingKind = inferFindingKind({
        title: params.title,
        description,
        impact: params.impact,
        poc,
        reproduction: params.reproduction,
        location,
        finding_kind: params.finding_kind || params.kind || params.category,
      });
      const flagToken = extractFlagToken(`${params.title}\n${description}\n${poc}\n${params.reproduction || ""}`);
      const record: PersistedFindingRecord = {
        ...params,
        action,
        title: params.title,
        finding_kind: findingKind,
        flag_value: flagToken,
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
          finding_kind: findingKind,
          kind: findingKind,
          category: findingKind,
          flag_value: flagToken,
          url: params.url,
          location,
          affected_asset: affectedAsset,
          // Prefer a stable finding key so platform message dedupe does not collapse
          // unrelated findings that happen to share an evidence id.
          id: `finding:${findingKind}:${slug(params.title)}:${slug(location || String(params.url || "unknown"))}`,
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
      const mixedHint =
        action === "confirm" && looksLikeMixedVulnAndFlag(record)
          ? "This record looks like a mixed vuln+flag body. Emit a second finding(action='confirm', finding_kind='flag') with the exact flag{...} so Flag is a separate object."
          : undefined;
      return jsonResult({
        ok: true,
        path,
        record,
        finding_kind: findingKind,
        flag_value: flagToken,
        deduped: false,
        ...(mixedHint ? { hint: mixedHint } : {}),
      });
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
