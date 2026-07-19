import { mkdir, writeFile, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ToolRuntime } from "../types.js";
import {
  assessBookingChainQuality,
  FINDING_TOOL_DESCRIPTION,
} from "../runtime/booking-harness.js";
import {
  bookTimeEvidenceData,
  emitCaseEvidence,
  extractObservationHighlight,
  jsonResult,
  proofGroundedInRecentWork,
  textResult,
} from "./common.js";

const MIN_POC_LEN = 40;
const MIN_DESC_LEN = 16;
const MIN_PROOF_LEN = 24;
const MIN_OUTPUT_PROOF = 32;

/**
 * How many *other* findings may already cite the same evidence_id (legacy path).
 */
export const MAX_OTHER_FINDINGS_PER_EVIDENCE = 2;

/**
 * Extract demonstrable material from a stored evidence record (legacy / support).
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

  const stdoutRaw = String(
    data.stdout ??
      data.body_preview ??
      data.body ??
      data.response_body ??
      data.html ??
      data.text ??
      data.preview ??
      data.content ??
      data.observation ??
      data.proof ??
      "",
  ).trim();
  const stderr = String(data.stderr ?? "").trim();
  const url = String(data.url ?? data.path_or_url ?? data.path ?? "").trim();
  const method = String(data.method ?? "").trim();
  const status = data.status ?? data.status_code ?? data.statusCode ?? data.exitCode ?? data.exit_code;
  const command = String(data.command ?? data.file ?? "").trim();
  const filePath = String(data.path || data.file || "").trim();
  const isAgentScriptPath =
    /(?:^|\/)scripts\//.test(filePath) || /_probe\.(py|js|mjs)$/i.test(filePath) || /\.py$/i.test(command);
  const summary = String(rec.summary ?? "").trim();
  const requestBody = String(
    data.request_body ?? data.requestBody ?? (method && method.toUpperCase() !== "GET" ? data.body : ""),
  ).trim();
  const locationHeader = pickHeader(
    data.headers ?? data.response_headers ?? data.responseHeaders,
    "location",
  );
  const observation = String(
    data.observation || data.proof_highlight || extractObservationHighlight(stdoutRaw) || "",
  ).trim();
  const stdout = stdoutRaw;

  const lines: string[] = [];
  if (method || url) {
    lines.push(
      [method, url, status != null && status !== "" ? `→ ${status}` : ""].filter(Boolean).join(" "),
    );
  }
  if (requestBody) lines.push(`request: ${requestBody.slice(0, 240)}`);
  if (locationHeader) lines.push(`Location: ${locationHeader.slice(0, 200)}`);
  if (observation) {
    lines.push(observation.slice(0, 1200));
  } else if (stdout) {
    lines.push(stdout.slice(0, 900));
  } else if (stderr) {
    lines.push(`stderr: ${stderr.slice(0, 400)}`);
  }
  if (filePath && !isAgentScriptPath) lines.push(`path: ${filePath.slice(0, 240)}`);
  if (command && !observation) lines.push(`$ ${command.slice(0, 240)}`);
  const excerpt = lines.join("\n").trim();

  const hasOutputProof = stdout.length >= MIN_OUTPUT_PROOF || observation.length >= MIN_OUTPUT_PROOF;
  const hasShortHttpBody = Boolean(url && status != null && status !== "") && stdout.length >= 8;
  const hasErrorProof = stderr.length >= MIN_OUTPUT_PROOF && Number(status) !== 0;
  const hasRedirectProof = Boolean(url && status != null && status !== "" && locationHeader);
  const hasFileMaterial =
    (String(data.kind || "") === "file" ||
      String(data.kind || "") === "source_excerpt" ||
      (Boolean(filePath) && !isAgentScriptPath)) &&
    (stdout.length >= 16 || observation.length >= 16);

  if (hasOutputProof || hasShortHttpBody || hasErrorProof || hasRedirectProof || hasFileMaterial) {
    return { ok: true, excerpt: excerpt || summary.slice(0, 500) };
  }

  return {
    ok: false,
    excerpt: excerpt || summary.slice(0, 300),
    reason:
      "no demonstrable observation (response body / payload reflection / proving stdout) — re-run a probe that captures the proving result",
  };
}

export function pocDemonstratesIssue(poc: string): { ok: boolean; reason?: string } {
  const text = String(poc || "").trim();
  if (text.length < MIN_POC_LEN) {
    return {
      ok: false,
      reason: `poc too short (≥${MIN_POC_LEN} chars) — include request/payload/steps AND the observed proving result`,
    };
  }
  const hasAction =
    /\b(get|post|put|patch|delete|curl|http|payload|param|inject|upload|request|send|probe|login|cookie|header|write|read|cat|dump|save|visit|open|browse|navigate|submit|click|fetch|access)\b/i.test(
      text,
    ) ||
    /https?:\/\//i.test(text) ||
    /['"`][^'"`]{2,}['"`]/.test(text) ||
    /[?&]=/.test(text) ||
    /\/vulnerabilities\/[\w-]+/i.test(text) ||
    /\b[\w./-]+\.(php|py|js|java|html|txt)\b/i.test(text);
  const hasObservation =
    /\b(status|response|stdout|output|result|observed|returned|returns?|got|received|exit|body|error|flag|reflected|executed|wrote|created|redirect|preview|shows?|includes?)\b/i.test(
      text,
    ) ||
    /(→|->|=>)/.test(text) ||
    /\b\d{3}\b/.test(text) ||
    /\n/.test(text);
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
      /** Proving fragment from real tool output — primary path. */
      proof: Type.Optional(Type.String()),
      observation: Type.Optional(Type.String()),
      /** Optional extra materials (rarely needed). */
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

      const proofText = String(params.proof || params.observation || "").trim();
      const legacyIds = Array.isArray(params.evidence_ids)
        ? params.evidence_ids.map(String).filter(Boolean).filter((id, i, arr) => arr.indexOf(id) === i)
        : [];

      // Primary path: agent supplies proof at booking time → system creates Case evidence.
      if (proofText) {
        if (proofText.length < MIN_PROOF_LEN) {
          return textResult(
            `error: proof too short (≥${MIN_PROOF_LEN} chars) — paste the proving observation from tool output`,
          );
        }
        const grounded = proofGroundedInRecentWork(proofText, runtime.lifecycle.recentObservations);
        if (!grounded.ok) {
          return textResult(`error: ${grounded.reason}`);
        }

        const evidencePayload = bookTimeEvidenceData({
          title,
          location,
          proofText,
          match: grounded.match,
          recent: runtime.lifecycle.recentObservations,
        });
        const how = String(evidencePayload.how_captured || "probe");
        const summary = `${title} @ ${location}`.slice(0, 160);
        const evidenceId = await emitCaseEvidence(runtime, "finding", summary, evidencePayload, {
          role: "proof",
          evidenceType:
            evidencePayload.method && evidencePayload.url
              ? "http_exchange"
              : evidencePayload.command
                ? "tool_output"
                : "tool_output",
        });

        const evidenceIds = [evidenceId, ...legacyIds.filter((id) => id !== evidenceId)];
        const proofExcerpts = [
          {
            evidence_id: evidenceId,
            excerpt: proofText.slice(0, 1200),
            role: "proof" as const,
            step: 1,
            how_captured: how,
          },
        ];

        return finalizeFinding(runtime, {
          title,
          location,
          poc,
          description,
          kind: normalizeKind(params.finding_kind),
          severity: String(params.severity || "medium"),
          evidenceIds,
          proofExcerpts,
          proofText,
          howCaptured: how,
        });
      }

      // Legacy: evidence_ids only (smokes / older agents). Prefer proof path.
      if (!legacyIds.length) {
        return textResult(
          "error: proof required — after probing, call finding(confirm) with proof= the proving fragment from tool output (Case evidence is created from it). Do not hunt evidence_ids.",
        );
      }

      const priorFindings = await loadFindings(runtime.findingsDir);
      const reuseCounts = countEvidenceReuse(priorFindings);
      const proofExcerpts: Array<{
        evidence_id: string;
        excerpt: string;
        role: "proof" | "support";
        step: number;
      }> = [];
      let provingCount = 0;

      for (let i = 0; i < legacyIds.length; i += 1) {
        const eid = legacyIds[i]!;
        const raw = await runtime.evidence.read(eid);
        if (!raw) return textResult(`error: evidence not found: ${eid}`);

        const proof = extractProofMaterial(raw);
        const support = proof.ok ? null : extractSupportMaterial(raw);
        if (!proof.ok && !support?.ok) {
          return textResult(
            `error: evidence ${eid} is empty or unusable (${proof.reason || support?.reason || "no content"}).`,
          );
        }

        const role: "proof" | "support" = proof.ok ? "proof" : "support";
        if (role === "proof") provingCount += 1;
        const excerpt = (proof.ok ? proof.excerpt : support!.excerpt).slice(0, 1200);

        const prior = reuseCounts.get(eid) || 0;
        if (prior >= MAX_OTHER_FINDINGS_PER_EVIDENCE) {
          return textResult(
            `error: evidence ${eid} is already linked to ${prior} other findings — use a claim-specific proof string instead.`,
          );
        }

        proofExcerpts.push({ evidence_id: eid, excerpt, role, step: i + 1 });
      }

      if (provingCount < 1) {
        return textResult(
          `error: no proving evidence — provide proof= with a real observation for ${location}.`,
        );
      }

      const sharedUnrelatedProof = proofExcerpts.filter((p) => {
        if (p.role !== "proof") return false;
        const prior = reuseCounts.get(p.evidence_id) || 0;
        return prior >= 1 && !evidenceExcerptSupportsLocation(p.excerpt, location);
      });
      const exclusiveOrLocatedProof = proofExcerpts.some((p) => {
        if (p.role !== "proof") return false;
        const prior = reuseCounts.get(p.evidence_id) || 0;
        return prior === 0 || evidenceExcerptSupportsLocation(p.excerpt, location);
      });
      if (sharedUnrelatedProof.length && !exclusiveOrLocatedProof) {
        return textResult(
          `error: proving evidence does not support ${location}. Quote a claim-specific observation in proof=.`,
        );
      }

      return finalizeFinding(runtime, {
        title,
        location,
        poc,
        description,
        kind: normalizeKind(params.finding_kind),
        severity: String(params.severity || "medium"),
        evidenceIds: legacyIds,
        proofExcerpts,
        proofText: proofExcerpts[0]?.excerpt || "",
      });
    },
  };
}

/**
 * Host/port for platform ledger linking.
 * Prefer full URL in location; else task.target / scope.allow (authorized Scope).
 */
export function resolveAffectedHostPort(
  location: string,
  task: { target?: Record<string, unknown>; scope?: Record<string, unknown> },
): { host: string; port?: string; source: string } {
  const fromLoc = parseHostPort(location);
  if (fromLoc.host) return { ...fromLoc, source: "location" };
  const target = task.target && typeof task.target === "object" ? task.target : {};
  const tval = String(
    (target as { value?: unknown }).value
      ?? (target as { url?: unknown }).url
      ?? (target as { host?: unknown }).host
      ?? "",
  ).trim();
  const fromTarget = parseHostPort(tval);
  if (fromTarget.host) return { ...fromTarget, source: "task_target" };
  const allow = task.scope && typeof task.scope === "object"
    ? (task.scope as { allow?: unknown }).allow
    : undefined;
  if (Array.isArray(allow)) {
    for (const item of allow) {
      const fromAllow = parseHostPort(String(item || "").trim());
      if (fromAllow.host) return { ...fromAllow, source: "scope_allow" };
    }
  }
  return { host: "", source: "none" };
}

export function parseHostPort(raw: string): { host: string; port?: string } {
  const s = String(raw || "").trim();
  if (!s) return { host: "" };
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : s.startsWith("//") ? `http:${s}` : "";
    if (withScheme || s.includes("://")) {
      const u = new URL(withScheme || s);
      const host = (u.hostname || "").toLowerCase();
      const port = u.port || undefined;
      if (host) return { host, port };
    }
  } catch {
    // fall through
  }
  // host:port bare
  const m = s.match(
    /^(?:https?:\/\/)?((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}|localhost|host\.docker\.internal|\d{1,3}(?:\.\d{1,3}){3})(?::(\d{1,5}))?/i,
  );
  if (m) {
    return { host: m[1]!.toLowerCase(), port: m[2] };
  }
  return { host: "" };
}

async function finalizeFinding(
  runtime: ToolRuntime,
  input: {
    title: string;
    location: string;
    poc: string;
    description: string;
    kind: string;
    severity: string;
    evidenceIds: string[];
    proofExcerpts: Array<{
      evidence_id: string;
      excerpt: string;
      role: "proof" | "support";
      step: number;
      how_captured?: string;
    }>;
    proofText: string;
    howCaptured?: string;
  },
) {
  const priorFindings = await loadFindings(runtime.findingsDir);
  const reuseCounts = countEvidenceReuse(priorFindings);
  const id = `f_${Date.now()}_${randomBytes(3).toString("hex")}`;
  const evidenceSummary = input.proofExcerpts
    .map((p) => {
      const how = p.how_captured ? `how: ${p.how_captured}\n` : "";
      return `[${p.role}]\n${how}${p.excerpt}`;
    })
    .join("\n---\n")
    .slice(0, 4000);
  const affected = resolveAffectedHostPort(input.location, runtime.task);
  const locPort = parseHostPort(input.location).port;
  const port = locPort || affected.port;
  const record = {
    id,
    action: "confirm",
    title: input.title,
    severity: input.severity,
    finding_kind: input.kind,
    location: input.location,
    url: input.location,
    description: input.description,
    poc: input.poc,
    proof: input.proofText.slice(0, 4000),
    how_captured: input.howCaptured || undefined,
    evidence_ids: input.evidenceIds,
    proof_excerpts: input.proofExcerpts,
    affected_asset: affected.host || undefined,
    port: port || undefined,
    created_at: new Date().toISOString(),
  };
  await mkdir(runtime.findingsDir, { recursive: true });
  await writeFile(join(runtime.findingsDir, `${id}.json`), JSON.stringify(record, null, 2), "utf8");
  await runtime.platform.send({
    type: "vuln_found",
    conversation_id: runtime.task.conversationId,
    task_id: runtime.task.taskId,
    status: "confirmed",
    title: input.title,
    severity: record.severity,
    finding_kind: input.kind,
    location: record.location,
    url: record.url,
    evidence_ids: input.evidenceIds,
    description: record.description,
    poc: record.poc,
    proof: record.proof,
    how_captured: record.how_captured,
    proof_excerpts: input.proofExcerpts,
    evidence_summary: evidenceSummary,
    // Platform ledger linking (Scope host when location is path-only).
    affected_asset: affected.host || undefined,
    target: affected.host || undefined,
    port: port || undefined,
  });

  const chainQuality = assessBookingChainQuality({
    evidenceIds: input.evidenceIds,
    location: input.location,
    proofExcerpts: input.proofExcerpts,
    reuseCounts,
    locationSupported: evidenceExcerptSupportsLocation,
  });
  return jsonResult({
    ok: true,
    finding: record,
    evidence_created: input.evidenceIds[0],
    how_captured: record.how_captured,
    note: "Case evidence was created from your proof at booking time (observation + how captured).",
    chain_quality: {
      chain_length: chainQuality.chain_length,
      short_chain: chainQuality.short_chain,
      shared_proof: chainQuality.shared_proof,
      warnings: chainQuality.warnings,
    },
    ...(chainQuality.nudge ? { booking_nudge: chainQuality.nudge } : {}),
  });
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

export async function loadFindings(dir: string): Promise<Array<Record<string, unknown>>> {
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

export function countEvidenceReuse(findings: Array<Record<string, unknown>>): Map<string, number> {
  const map = new Map<string, number>();
  for (const f of findings) {
    const ids = Array.isArray(f.evidence_ids) ? f.evidence_ids.map(String) : [];
    for (const id of ids) {
      if (!id) continue;
      map.set(id, (map.get(id) || 0) + 1);
    }
  }
  return map;
}

export function extractSupportMaterial(ev: unknown): { ok: boolean; excerpt: string; reason?: string } {
  if (!ev || typeof ev !== "object") {
    return { ok: false, excerpt: "", reason: "evidence record missing" };
  }
  const rec = ev as Record<string, unknown>;
  const data =
    rec.data && typeof rec.data === "object" && !Array.isArray(rec.data)
      ? (rec.data as Record<string, unknown>)
      : {};
  const summary = String(rec.summary || "").trim();
  const bits = [
    data.method && data.url
      ? `${data.method} ${data.url}${data.status != null ? ` → ${data.status}` : ""}`
      : data.url
        ? String(data.url)
        : "",
    data.observation ? String(data.observation) : "",
    data.proof ? String(data.proof) : "",
    data.excerpt ? String(data.excerpt) : "",
    data.stdout ? String(data.stdout).slice(0, 400) : "",
    data.body_preview ? String(data.body_preview).slice(0, 400) : "",
    data.command ? `$ ${String(data.command).slice(0, 200)}` : "",
    summary && !summary.startsWith("{") ? summary : "",
  ]
    .map((s) => String(s || "").trim())
    .filter(Boolean);
  const excerpt = bits.join("\n").trim();
  if (excerpt.length < 8) {
    return { ok: false, excerpt, reason: "no usable content for supporting material" };
  }
  return { ok: true, excerpt: excerpt.slice(0, 800) };
}

export function evidenceExcerptSupportsLocation(excerpt: string, location: string): boolean {
  const tokens = locationTokens(location);
  if (!tokens.length) return true;
  const hay = String(excerpt || "").toLowerCase();
  if (!hay) return false;
  return tokens.some((t) => hay.includes(t.toLowerCase()));
}

export function locationTokens(location: string): string[] {
  const raw = String(location || "").trim();
  if (!raw) return [];
  const out: string[] = [];
  try {
    if (/^https?:\/\//i.test(raw)) {
      const u = new URL(raw);
      if (u.pathname && u.pathname !== "/") out.push(u.pathname);
      for (const part of u.pathname.split("/")) {
        if (part.length >= 4) out.push(part);
      }
      for (const [k, v] of u.searchParams.entries()) {
        if (k.length >= 3) out.push(k);
        if (v.length >= 4 && v.length <= 80) out.push(v);
      }
    }
  } catch {
    // fall through
  }
  for (const part of raw.split(/[/?#&\s=]+/)) {
    const p = part.trim();
    if (p.length >= 4 && !/^https?:$/i.test(p)) out.push(p);
  }
  return [...new Set(out.map((s) => s.replace(/^\/+|\/+$/g, "")).filter((s) => s.length >= 4))].slice(0, 12);
}
