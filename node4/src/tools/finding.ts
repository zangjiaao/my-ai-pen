import { mkdir, writeFile, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolRuntime } from "../types.js";
import {
  assessBookingChainQuality,
  FINDING_TOOL_DESCRIPTION,
} from "../runtime/booking-harness.js";
import {
  fallbackProofFromInjectedCandidates,
  formatBookingHelpHint,
  resolveBookingMaterialFromSubagentEvidence,
} from "../runtime/subagent-booking.js";
import { synthesizePocFromHandoffProof } from "../runtime/subagent-result.js";
import {
  bookTimeEvidenceData,
  emitCaseEvidence,
  extractObservationHighlight,
  jsonResult,
  proofGroundedInRecentWork,
  textResult,
} from "./common.js";
import { ingestPackageCandidatesToStore } from "../runtime/finding-store.js";
import { parseHostPort } from "../runtime/attack-surface.js";
export { parseHostPort } from "../runtime/attack-surface.js";
import { resolveBookSeverity } from "../runtime/finding-severity.js";

export { synthesizePocFromHandoffProof } from "../runtime/subagent-result.js";

const MIN_POC_LEN = 40;
const MIN_DESC_LEN = 16;
const MIN_PROOF_LEN = 24;
const MIN_OUTPUT_PROOF = 32;

/** Spec #275 closed enum — required on finding(confirm); reject unknown. */
export const VALID_VULN_TYPES = [
  "rce",
  "command_injection",
  "file_upload",
  "credential_exposure",
  "info_disclosure",
  "dir_listing",
  "sqli",
  "xss",
  "csrf",
  "lfi",
  "ssrf",
  "xxe",
  "idor",
  "auth_bypass",
  "session",
  "misconfig",
  "other",
] as const;

export type VulnTypeId = (typeof VALID_VULN_TYPES)[number];

export function normalizeVulnType(value: unknown): VulnTypeId | null {
  const raw = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, "_");
  if (!raw) return null;
  return (VALID_VULN_TYPES as readonly string[]).includes(raw) ? (raw as VulnTypeId) : null;
}

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

function findingConfirmFailKey(title: string, location: string): string {
  return `${String(title || "").trim().toLowerCase()}|${String(location || "").trim().toLowerCase()}`;
}

/**
 * Record a failed confirm and return judgment/anti-thrash suffix for the error string.
 */
export function noteFindingConfirmGroundFailure(
  runtime: ToolRuntime,
  title: string,
  location: string,
): string {
  const life = runtime.lifecycle || (runtime.lifecycle = {});
  const counts = (life.findingConfirmFailCounts ||= {});
  const key = findingConfirmFailKey(title, location);
  const n = (counts[key] || 0) + 1;
  counts[key] = n;
  if (n >= 2) {
    return (
      ` — judgment: bookable_unbooked (identical finding(confirm) failed ${n}× for this title+location). ` +
      `Stop thrashing the same confirm. Either re-probe for grounded proof_excerpt, match location/candidate_index to Store/handoff candidates, or record deadend/bookable_unbooked via fact — do not invent finding_id or use result.json as booking.`
    );
  }
  return (
    " — if this claim lacks matching handoff proof_excerpt, treat as bookable_unbooked (do not retry identical confirm without new evidence)."
  );
}

export function createFindingTool(runtime: ToolRuntime): AgentTool<any> {
  return {
    name: "finding",
    label: "Finding",
    description: FINDING_TOOL_DESCRIPTION,
    parameters: Type.Object({
      action: Type.String(),
      title: Type.Optional(Type.String()),
      severity: Type.Optional(Type.String()),
      /**
       * Spec #275: closed enum required on confirm (ledger identity).
       * rce|command_injection|file_upload|credential_exposure|info_disclosure|dir_listing|
       * sqli|xss|csrf|lfi|ssrf|xxe|idor|auth_bypass|session|misconfig|other
       */
      vuln_type: Type.Optional(Type.String()),
      finding_kind: Type.Optional(Type.String()),
      location: Type.Optional(Type.String()),
      url: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
      /** Proving fragment from real tool output — primary path. Optional when subagent candidates exist. */
      proof: Type.Optional(Type.String()),
      observation: Type.Optional(Type.String()),
      /** Optional extra materials (rarely needed). */
      evidence_ids: Type.Optional(Type.Array(Type.String())),
      poc: Type.Optional(Type.String()),
      /**
       * Optional index into last subagent candidates / acceptance.ready_to_book.
       * When set (or when location/title matches a candidate), harness uses VERBATIM proof_excerpt.
       */
      candidate_index: Type.Optional(Type.Number()),
      /**
       * Spec #116: Store finding id after Feedback feedback_ok (preferred confirm path).
       */
      finding_id: Type.Optional(Type.String()),
    }),
    async execute(_id: string, params: any) {
      const action = String(params.action || "confirm").toLowerCase();
      const store = runtime.lifecycle.processQuality?.findingStore;

      // Spec #125: Main serial path — upsert candidates into Finding Store (not result.json).
      if (action === "upsert" || action === "deposit") {
        if ((runtime.lifecycle.subagentDepth || 0) >= 1) {
          return textResult(
            "error: subagent must not finding(upsert) — workers return structured candidates; Main/host settle Store",
            { isError: true },
          );
        }
        if (!store) {
          return textResult(
            "error: Finding Store unavailable (Expert Graph processQuality required for upsert)",
            { isError: true },
          );
        }
        const title = String(params.title || "").trim();
        const location = String(params.location || params.url || "").trim();
        const proof = String(params.proof || params.proof_excerpt || params.observation || "").trim();
        if (!title || !location) {
          return textResult("error: finding(upsert) requires title and location");
        }
        const sevRaw = String(params.severity || "").trim();
        if (!sevRaw) {
          return textResult(
            "error: finding(upsert) requires severity (critical|high|medium|low|info) — silent medium banned (Spec #139 D1)",
            { isError: true },
          );
        }
        const ids = ingestPackageCandidatesToStore(
          store,
          [
            {
              title,
              location,
              claim: String(params.description || params.claim || "").trim() || undefined,
              proof_excerpt: proof || undefined,
              poc_hint: String(params.poc || "").trim() || undefined,
              severity: sevRaw,
              class_key: String(params.class_key || "").trim() || undefined,
            },
          ],
          {
            package_id: "main_serial",
            stage_id: runtime.lifecycle.hardGraphRun?.stageId,
            agent_id: "main",
            fallback_location: location,
          },
        );
        if (!ids.length) {
          return textResult(
            "error: finding(upsert) rejected — invalid severity or missing title/location (Spec #139 D1)",
            { isError: true },
          );
        }
        const feedbackOk = store
          .snapshot()
          .filter((r) => ids.includes(r.id) && r.status === "feedback_ok")
          .map((r) => ({ id: r.id, status: r.status, title: r.title }));
        return jsonResult({
          ok: true,
          action: "upsert",
          finding_ids: ids,
          feedback_ok: feedbackOk,
          hint:
            feedbackOk.length > 0
              ? `Confirm with finding(confirm, finding_id=${feedbackOk[0]!.id})`
              : "L0 rejected or pending — need proof_excerpt ≥24 chars and valid severity for feedback_ok",
        });
      }

      if (action === "list") {
        // Prefer Store snapshot when available (captain-visible feedback_ok ids).
        if (store) {
          const rows = store.snapshot();
          return jsonResult({
            findings: rows,
            feedback_ok_ids: rows.filter((r) => r.status === "feedback_ok").map((r) => r.id),
            booked_n: rows.filter((r) => r.status === "booked").length,
          });
        }
        const rows = await loadFindings(runtime.findingsDir);
        return jsonResult({ findings: rows });
      }
      if (action !== "confirm") {
        return textResult("error: action must be confirm, list, or upsert");
      }

      // Spec #116 I0.13: Sub never confirms
      if ((runtime.lifecycle.subagentDepth || 0) >= 1) {
        return textResult("error: subagent must not finding(confirm) — Main books only (Spec #116 I0.13)", {
          isError: true,
        });
      }

      // Spec #279: one base confirm contract Free and Graph.
      // finding_id optional — host mints on book when missing/foreign.
      // This-run Store feedback_ok id remains Store-first fill (Graph overlay).
      // Foreign / unknown / not-bookable ids → treat as omit (no invent-without-id hard stop).
      const rawFindingId = String(params.finding_id || params.candidate_id || "").trim();
      let storeFindingId: string | undefined;
      let findingIdAssist = "";
      let relatedPriorId: string | undefined;

      if (store && rawFindingId) {
        const gate = store.assertConfirmAllowed(rawFindingId);
        if (gate.ok) {
          storeFindingId = rawFindingId;
          if (!String(params.title || "").trim()) params.title = gate.record.title;
          if (!String(params.location || params.url || "").trim()) {
            params.location = gate.record.location;
          }
          if (!String(params.description || "").trim() && gate.record.description) {
            params.description = gate.record.description;
          }
          if (!String(params.proof || "").trim() && gate.record.proof_excerpt) {
            params.proof = gate.record.proof_excerpt;
          }
          if (!String(params.poc || "").trim() && gate.record.poc) {
            params.poc = gate.record.poc;
          }
          // Spec #139 D1: fill severity from Store when tool omits (same pattern as proof fill)
          if (!String(params.severity || "").trim() && gate.record.severity) {
            params.severity = gate.record.severity;
          }
        } else {
          // Not in this Case bookable set (foreign platform UUID, random id, non-feedback_ok).
          findingIdAssist =
            "finding_id not in this Case bookable set — treated as omit; host mints on book (Spec #279)";
          if (looksLikePlatformUuid(rawFindingId)) {
            relatedPriorId = rawFindingId;
          }
        }
      }

      // Spec #139 D1 / NC-Severity: fail closed — no silent medium
      const storeSev =
        store && storeFindingId ? store.get(storeFindingId)?.severity : undefined;
      const sevResolved = resolveBookSeverity({
        toolSeverity: params.severity,
        storeSeverity: storeSev,
      });
      if (!sevResolved.ok) {
        return textResult(`error: ${sevResolved.error}`, { isError: true });
      }
      params.severity = sevResolved.severity;

      // Spec #275: closed vuln_type required on confirm (ledger identity).
      const vulnType = normalizeVulnType(params.vuln_type);
      if (!vulnType) {
        return textResult(
          `error: vuln_type required (closed enum: ${VALID_VULN_TYPES.join("|")}) — missing/unknown type is rejected; do not invent free-text types`,
          { isError: true },
        );
      }
      params.vuln_type = vulnType;

      const title = String(params.title || "").trim();
      if (!title) return textResult("error: title required");
      let location = String(params.location || params.url || "").trim();
      if (!location) {
        return textResult(
          "error: location or url required — the concrete place the issue was observed (path, endpoint, or full URL)",
        );
      }
      // Path-bearing location is part of Spec #275 file-level identity (with vuln_type).
      // Reject payload-only strings with no URL/path token.
      const hasPathToken =
        /https?:\/\//i.test(location) ||
        /\/[A-Za-z0-9._~-]{1,}/.test(location) ||
        /^[A-Za-z0-9._-]+:\d{1,5}\//.test(location);
      if (!hasPathToken) {
        return textResult(
          "error: location must include a request path or URL (e.g. /vulnerabilities/exec/ or https://host/path) — not payload-only text; put the payload in poc=",
        );
      }
      const description = String(params.description || "").trim();
      if (description.length < MIN_DESC_LEN) {
        return textResult(
          `error: description required (≥${MIN_DESC_LEN} chars) — what is broken and what impact was demonstrated`,
        );
      }

      const candidateIndex =
        params.candidate_index != null && Number.isFinite(Number(params.candidate_index))
          ? Number(params.candidate_index)
          : undefined;
      let poc = String(params.poc || "").trim();
      let proofText = String(params.proof || params.observation || "").trim();
      let bookSourceNote = "";

      // Verbatim path: fill/replace proof+poc from last subagent candidates when matched.
      const material = resolveBookingMaterialFromSubagentEvidence(runtime, {
        title,
        location,
        proof: proofText,
        poc,
        candidate_index: candidateIndex,
      });
      if (material) {
        // Always prefer candidate verbatim proof when a candidate matched (anti-paraphrase).
        proofText = material.proof;
        if (!poc || !pocDemonstratesIssue(poc).ok) {
          poc = material.poc || poc;
        }
        bookSourceNote = material.note || "";
      }

      let pocCheck = pocDemonstratesIssue(poc);
      if (!pocCheck.ok && material?.poc) {
        poc = material.poc;
        pocCheck = pocDemonstratesIssue(poc);
      }
      if (!pocCheck.ok) {
        // Last try: ready_to_book poc from fallback
        const fb = fallbackProofFromInjectedCandidates(runtime, { title, location });
        if (fb?.poc && pocDemonstratesIssue(fb.poc).ok) {
          poc = fb.poc;
          if (!proofText || proofText.length < MIN_PROOF_LEN) proofText = fb.proof;
          bookSourceNote = fb.note;
          pocCheck = pocDemonstratesIssue(poc);
        }
      }
      // Hard handoff: candidate matched with proof but no usable poc_hint — synthesize steps+observation.
      if (!pocCheck.ok && material?.proof && material.proof.length >= MIN_PROOF_LEN) {
        const synth = synthesizePocFromHandoffProof(location, material.proof);
        const synthCheck = pocDemonstratesIssue(synth);
        if (synthCheck.ok) {
          poc = synth;
          pocCheck = synthCheck;
          bookSourceNote =
            (bookSourceNote ? `${bookSourceNote}; ` : "") + "poc synthesized from handoff proof_excerpt";
        }
      }
      if (!pocCheck.ok) {
        return textResult(`error: ${pocCheck.reason}`);
      }

      const legacyIds = Array.isArray(params.evidence_ids)
        ? params.evidence_ids.map(String).filter(Boolean).filter((id, i, arr) => arr.indexOf(id) === i)
        : [];

      // If still no proof, try candidate fill once more without agent proof
      if (!proofText || proofText.length < MIN_PROOF_LEN) {
        const fb = fallbackProofFromInjectedCandidates(runtime, { title, location });
        if (fb) {
          proofText = fb.proof;
          bookSourceNote = fb.note;
        }
      }

      // Primary path: proof (agent or harness-filled from candidate) → Case evidence.
      if (proofText) {
        if (proofText.length < MIN_PROOF_LEN) {
          return textResult(
            `error: proof too short (≥${MIN_PROOF_LEN} chars) — paste the proving observation from tool output, or pass candidate_index / matching location from last subagent ready_to_book`,
          );
        }
        let grounded = proofGroundedInRecentWork(proofText, runtime.lifecycle.recentObservations, {
          location,
        });
        if (!grounded.ok) {
          // Auto-swap to candidate verbatim if agent paraphrased
          const fb = fallbackProofFromInjectedCandidates(runtime, { title, location });
          if (fb && fb.proof !== proofText) {
            const g2 = proofGroundedInRecentWork(fb.proof, runtime.lifecycle.recentObservations, {
              location,
            });
            if (g2.ok) {
              proofText = fb.proof;
              if (!pocDemonstratesIssue(poc).ok && fb.poc) poc = fb.poc;
              grounded = g2;
              bookSourceNote = fb.note;
            }
          }
        }
        if (!grounded.ok) {
          return textResult(
            `error: ${grounded.reason}` +
              formatBookingHelpHint(runtime) +
              noteFindingConfirmGroundFailure(runtime, title, location),
          );
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

        const finalized = await finalizeFinding(runtime, {
          title,
          location,
          poc,
          description,
          kind: normalizeKind(params.finding_kind),
          severity: String(params.severity),
          vulnType: String(params.vuln_type),
          evidenceIds,
          proofExcerpts,
          proofText,
          howCaptured: how,
          storeFindingId: storeFindingId || undefined,
          relatedPriorId,
        });
        // Coverage ledger: mark matching surface booked (SQLite SoT #371 / #382; legacy fallback for tests)
        try {
          if (runtime.surfaceSqlite) {
            await runtime.surfaceSqlite.open();
            const affected = resolveAffectedHostPort(location, runtime.task);
            const locPort = parseHostPort(location).port;
            const bookPort = locPort || affected.port;
            await runtime.surfaceSqlite.markBooked(location, {
              host: affected.host || undefined,
              port: bookPort || undefined,
              proof: proofText || undefined,
              proofExcerpts,
            });
          } else {
            await runtime.surfaceLedger?.markBooked(location);
          }
        } catch {
          /* non-fatal */
        }
        // Attach booking assist note for model/debug (json path only)
        const assistNote = [bookSourceNote, findingIdAssist].filter(Boolean).join("; ");
        if (assistNote && finalized && typeof finalized === "object") {
          try {
            const content = (finalized as { content?: Array<{ type?: string; text?: string }> }).content;
            const textItem = content?.find((c) => c.type === "text");
            if (textItem?.text?.trim().startsWith("{")) {
              const obj = JSON.parse(textItem.text);
              obj.booking_assist = assistNote;
              textItem.text = JSON.stringify(obj, null, 2);
            }
          } catch {
            /* ignore */
          }
        }
        return finalized;
      }

      // Legacy: evidence_ids only (smokes / older agents). Prefer proof path.
      if (!legacyIds.length) {
        return textResult(
          "error: proof required — after subagent, pass location matching a candidate path (query ignored) or candidate_index=N; harness fills VERBATIM proof_excerpt." +
            formatBookingHelpHint(runtime) +
            noteFindingConfirmGroundFailure(runtime, title, location),
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
        severity: String(params.severity),
        vulnType: String(params.vuln_type),
        evidenceIds: legacyIds,
        proofExcerpts,
        proofText: proofExcerpts[0]?.excerpt || "",
        storeFindingId: storeFindingId || undefined,
        relatedPriorId,
      });
    },
  };
}

/** Platform-style UUID (cross-Case prior); not a run-local Store find-* id. */
export function looksLikePlatformUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    String(value || "").trim(),
  );
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

async function finalizeFinding(
  runtime: ToolRuntime,
  input: {
    title: string;
    location: string;
    poc: string;
    description: string;
    kind: string;
    severity: string;
    /** Spec #275 closed enum — required identity field on wire */
    vulnType: string;
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
    /** Spec #116 Store id after successful confirm → mark booked */
    storeFindingId?: string;
    /** Spec #279: optional link when re-confirming a foreign/cross-Case prior UUID */
    relatedPriorId?: string;
  },
) {
  const priorFindings = await loadFindings(runtime.findingsDir);
  const reuseCounts = countEvidenceReuse(priorFindings);
  // Spec #279: host mints finding id at confirm (Agent must not invent UUIDs).
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
    vuln_type: input.vulnType,
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
    related_prior_id: input.relatedPriorId || undefined,
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
    vuln_type: input.vulnType,
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
    // Prefer this-run Store id when present; else host-minted local id (Spec #279).
    finding_id: input.storeFindingId || id,
    related_prior_id: input.relatedPriorId || undefined,
  });

  // Spec #116 I0.15 path: successful confirm marks Store booked (platform-visible via vuln_found).
  if (input.storeFindingId && runtime.lifecycle.processQuality?.findingStore) {
    runtime.lifecycle.processQuality.findingStore.markBooked(input.storeFindingId, id);
  }

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
    // Spec #275: session confirm success ≠ ledger New. Never claim 新增 from confirm tally.
    note:
      "Case evidence was created from your proof at booking time. " +
      "User-visible narration may describe **New** ledger rows only (platform `created=true` / Case Findings / platform_list_vulnerabilities). " +
      "Do **not** claim 新增/新发现 from local finding(confirm) success count alone — rediscover updates an existing identity silently. " +
      "Identity = vuln_type + file-level location (title wording does not create a new row).",
    ledger: {
      // Platform outcome is fire-and-forget on this path; created is unknown until list/query.
      created: null as boolean | null,
      vuln_type: input.vulnType,
    },
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
