import { mkdir, writeFile, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ToolRuntime } from "../types.js";
import { jsonResult, textResult } from "./common.js";

export function createFindingTool(runtime: ToolRuntime): ToolDefinition<any> {
  return {
    name: "finding",
    label: "Finding",
    description:
      "ONLY product conclusion path for vuln/flag/auth. Requires evidence_ids from real tool output. Chat prose is not a product finding. Booking does NOT end the engagement — keep testing.",
    parameters: Type.Object({
      action: Type.String(),
      title: Type.Optional(Type.String()),
      severity: Type.Optional(Type.String()),
      finding_kind: Type.Optional(Type.String()),
      location: Type.Optional(Type.String()),
      url: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
      evidence_ids: Type.Optional(Type.Array(Type.String())),
      poc: Type.Optional(Type.String()),
    }),
    async execute(_id: string, params: any) {
      const action = String(params.action || "confirm").toLowerCase();
      if (action === "list") {
        const rows = await loadFindings(runtime.findingsDir);
        return jsonResult({ findings: rows });
      }
      if (action !== "confirm") return textResult("error: action must be confirm or list");
      const title = String(params.title || "").trim();
      if (!title) return textResult("error: title required");
      const evidenceIds = Array.isArray(params.evidence_ids) ? params.evidence_ids.map(String).filter(Boolean) : [];
      if (!evidenceIds.length) return textResult("error: evidence_ids required");
      for (const eid of evidenceIds) {
        if (!(await runtime.evidence.read(eid))) return textResult(`error: evidence not found: ${eid}`);
      }
      const kind = normalizeKind(params.finding_kind);
      const id = `f_${Date.now()}_${randomBytes(3).toString("hex")}`;
      const record = {
        id,
        action: "confirm",
        title,
        severity: String(params.severity || "medium"),
        finding_kind: kind,
        location: params.location || params.url || "",
        url: params.url || params.location || "",
        description: String(params.description || ""),
        poc: String(params.poc || ""),
        evidence_ids: evidenceIds,
        created_at: new Date().toISOString(),
      };
      await mkdir(runtime.findingsDir, { recursive: true });
      await writeFile(join(runtime.findingsDir, `${id}.json`), JSON.stringify(record, null, 2), "utf8");
      await runtime.platform.send({
        type: "vuln_found",
        conversation_id: runtime.task.conversationId,
        task_id: runtime.task.taskId,
        title,
        severity: record.severity,
        finding_kind: kind,
        location: record.location,
        evidence_ids: evidenceIds,
        description: record.description,
      });
      return jsonResult({ ok: true, finding: record });
    },
  };
}

export async function loadConfirmedFindings(findingsDir: string): Promise<{ titles: string[]; evidenceIds: string[]; count: number }> {
  const rows = await loadFindings(findingsDir);
  const confirmed = rows.filter((r) => String(r.action || "").toLowerCase() === "confirm" || String(r.action || "").toLowerCase() === "confirmed");
  const titles = confirmed.map((r) => String(r.title || "").trim()).filter(Boolean);
  const evidenceIds = [...new Set(confirmed.flatMap((r) => (Array.isArray(r.evidence_ids) ? r.evidence_ids.map(String) : [])))];
  return { titles, evidenceIds, count: titles.length };
}

async function loadFindings(dir: string): Promise<Array<Record<string, unknown>>> {
  try {
    const names = await readdir(dir);
    const out: Array<Record<string, unknown>> = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      out.push(JSON.parse(await readFile(join(dir, name), "utf8")));
    }
    return out;
  } catch {
    return [];
  }
}

function normalizeKind(value: unknown): string {
  const raw = String(value || "vuln").toLowerCase();
  if (raw === "flag" || raw === "auth") return raw;
  return "vuln";
}
