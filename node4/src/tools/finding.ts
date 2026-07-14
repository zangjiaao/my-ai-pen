import { mkdir, writeFile, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ToolRuntime } from "../types.js";
import { FINDING_TOOL_DESCRIPTION } from "../runtime/booking-harness.js";
import { jsonResult, textResult } from "./common.js";

const MIN_POC_LEN = 40;
const MIN_DESC_LEN = 16;
const MIN_OUTPUT_PROOF = 32;

/**
 * Goal: each booked finding must be backed by evidence that can *show* the issue
 * (response body / shell stdout), not merely that a request was sent.
 * Multiple findings may share one evidence record when that record's output proves each claim.
 */
export function extractProofMaterial(ev: unknown): { ok: boolean; excerpt: string; reason?: string } {
  if (!ev || typeof ev !== "object") {
    return { ok: false, excerpt: "", reason: "evidence record missing" };
  }
  const rec = ev as Record<string, unknown>;
  const data =
    rec.data && typeof rec.data === "object" && !Array.isArray(rec.data)
      ? (rec.data as Record<string, unknown>)
      : {};

  const stdout = String(
    data.stdout ?? data.body_preview ?? data.body ?? data.response_body ?? data.html ?? data.text ?? "",
  ).trim();
  const stderr = String(data.stderr ?? "").trim();
  const url = String(data.url ?? "").trim();
  const method = String(data.method ?? "").trim();
  const status = data.status ?? data.status_code ?? data.statusCode ?? data.exitCode ?? data.exit_code;
  const command = String(data.command ?? data.file ?? "").trim();
  const summary = String(rec.summary ?? "").trim();
  const requestBody = String(
    data.request_body ?? data.requestBody ?? (method && method.toUpperCase() !== "GET" ? data.body : ""),
  ).trim();
  const locationHeader = pickHeader(
    data.headers ?? data.response_headers ?? data.responseHeaders,
    "location",
  );

  const lines: string[] = [];
  if (method || url) {
    lines.push(
      [method, url, status != null && status !== "" ? `→ ${status}` : ""].filter(Boolean).join(" "),
    );
  } else if (status != null && status !== "") {
    lines.push(`status/exit=${status}`);
  }
  if (command) lines.push(`$ ${command.slice(0, 240)}`);
  if (requestBody) lines.push(`request: ${requestBody.slice(0, 240)}`);
  if (locationHeader) lines.push(`Location: ${locationHeader.slice(0, 200)}`);
  if (stdout) lines.push(stdout.slice(0, 900));
  else if (stderr) lines.push(`stderr: ${stderr.slice(0, 400)}`);
  const excerpt = lines.join("\n").trim();

  // Demonstrable effect — URL+status alone is not proof that the issue exists.
  // Accept: response/stdout long enough, short HTTP body (flags/"uid=0"), redirect Location, or error stderr.
  const hasOutputProof = stdout.length >= MIN_OUTPUT_PROOF;
  const hasShortHttpBody =
    Boolean(url && status != null && status !== "") && stdout.length >= 8;
  const hasErrorProof = stderr.length >= MIN_OUTPUT_PROOF && Number(status) !== 0;
  const hasRedirectProof = Boolean(url && status != null && status !== "" && locationHeader);

  if (hasOutputProof || hasShortHttpBody || hasErrorProof || hasRedirectProof) {
    return { ok: true, excerpt: excerpt || summary.slice(0, 500) };
  }

  return {
    ok: false,
    excerpt: excerpt || summary.slice(0, 300),
    reason:
      "no demonstrable output (response body / shell stdout / redirect Location) — re-run a probe that captures the proving result, then book with that evidence_id",
  };
}

/**
 * PoC must describe how to reproduce AND what was observed — not a title-only string.
 * Structural check only (no vuln-type keyword lists).
 */
export function pocDemonstratesIssue(poc: string): { ok: boolean; reason?: string } {
  const text = String(poc || "").trim();
  if (text.length < MIN_POC_LEN) {
    return {
      ok: false,
      reason: `poc too short (≥${MIN_POC_LEN} chars) — include request/payload/steps AND the observed proving result`,
    };
  }
  // Need a reproduction side and an observation side.
  const hasAction =
    /\b(get|post|put|patch|delete|curl|http|payload|param|inject|upload|request|send|probe|login|cookie|header)\b/i.test(
      text,
    ) ||
    /https?:\/\//i.test(text) ||
    /['"`][^'"`]{2,}['"`]/.test(text) ||
    /[?&]=/.test(text);
  const hasObservation =
    /\b(status|response|stdout|output|result|observed|returned|got|received|exit|body|error|flag|reflected|executed|wrote|created|redirect)\b/i.test(
      text,
    ) ||
    /\b(→|->|=>)\b/.test(text) ||
    /\b\d{3}\b/.test(text) || // HTTP status
    /\n/.test(text); // multi-line steps + result
  if (!hasAction || !hasObservation) {
    return {
      ok: false,
      reason:
        "poc must include both how to reproduce (request/payload/steps) and what was observed (status/response/stdout/effect)",
    };
  }
  return { ok: true };
}

function pickHeader(headers: unknown, name: string): string {
  if (!headers) return "";
  if (typeof headers === "string") {
    const re = new RegExp(`^${name}\\s*:\\s*(.+)$`, "im");
    const m = headers.match(re);
    return m ? m[1].trim() : "";
  }
  if (typeof headers === "object" && !Array.isArray(headers)) {
    const rec = headers as Record<string, unknown>;
    for (const [k, v] of Object.entries(rec)) {
      if (k.toLowerCase() === name.toLowerCase() && v != null) return String(v).trim();
    }
  }
  return "";
}

export function createFindingTool(runtime: ToolRuntime): ToolDefinition<any> {
  return {
    name: "finding",
    label: "Finding",
    description: FINDING_TOOL_DESCRIPTION,
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
      const location = String(params.location || params.url || "").trim();
      if (!location) {
        return textResult(
          "error: location or url required — the concrete place the issue was observed (path, endpoint, or full URL)",
        );
      }
      const poc = String(params.poc || "").trim();
      const pocCheck = pocDemonstratesIssue(poc);
      if (!pocCheck.ok) {
        return textResult(`error: ${pocCheck.reason}`);
      }
      const description = String(params.description || "").trim();
      if (description.length < MIN_DESC_LEN) {
        return textResult(
          `error: description required (≥${MIN_DESC_LEN} chars) — what is broken and what impact was demonstrated`,
        );
      }
      const evidenceIds = Array.isArray(params.evidence_ids)
        ? [...new Set(params.evidence_ids.map(String).filter(Boolean))]
        : [];
      if (!evidenceIds.length) return textResult("error: evidence_ids required");

      const proofExcerpts: Array<{ evidence_id: string; excerpt: string }> = [];
      for (const eid of evidenceIds) {
        const raw = await runtime.evidence.read(eid);
        if (!raw) return textResult(`error: evidence not found: ${eid}`);
        const proof = extractProofMaterial(raw);
        if (!proof.ok) {
          return textResult(
            `error: evidence ${eid} cannot prove this finding (${proof.reason}). ` +
              `Sharing one evidence across findings is OK only when that evidence's output demonstrates each claim.`,
          );
        }
        proofExcerpts.push({ evidence_id: eid, excerpt: proof.excerpt });
      }

      const kind = normalizeKind(params.finding_kind);
      const id = `f_${Date.now()}_${randomBytes(3).toString("hex")}`;
      const evidenceSummary = proofExcerpts
        .map((p) => p.excerpt)
        .join("\n---\n")
        .slice(0, 4000);
      const record = {
        id,
        action: "confirm",
        title,
        severity: String(params.severity || "medium"),
        finding_kind: kind,
        location,
        url: String(params.url || params.location || location),
        description,
        poc,
        evidence_ids: evidenceIds,
        proof_excerpts: proofExcerpts,
        created_at: new Date().toISOString(),
      };
      await mkdir(runtime.findingsDir, { recursive: true });
      await writeFile(join(runtime.findingsDir, `${id}.json`), JSON.stringify(record, null, 2), "utf8");
      await runtime.platform.send({
        type: "vuln_found",
        conversation_id: runtime.task.conversationId,
        task_id: runtime.task.taskId,
        status: "confirmed",
        title,
        severity: record.severity,
        finding_kind: kind,
        location: record.location,
        url: record.url,
        evidence_ids: evidenceIds,
        description: record.description,
        poc: record.poc,
        // Human-readable excerpts from linked evidence for platform detail UIs.
        proof_excerpts: proofExcerpts,
        evidence_summary: evidenceSummary,
      });
      return jsonResult({ ok: true, finding: record });
    },
  };
}

export async function loadConfirmedFindings(
  findingsDir: string,
): Promise<{ titles: string[]; evidenceIds: string[]; count: number }> {
  const rows = await loadFindings(findingsDir);
  const confirmed = rows.filter(
    (r) =>
      String(r.action || "").toLowerCase() === "confirm" ||
      String(r.action || "").toLowerCase() === "confirmed",
  );
  const titles = confirmed.map((r) => String(r.title || "").trim()).filter(Boolean);
  const evidenceIds = [
    ...new Set(
      confirmed.flatMap((r) => (Array.isArray(r.evidence_ids) ? r.evidence_ids.map(String) : [])),
    ),
  ];
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
