/**
 * Spec #125 host stage settlement — sole stage outcome projector for Expert Graph.
 *
 * Business SoT: Finding Store + package terminals + surface ledger (+ package evidence).
 * Agent-authored result.json is ignored even if present with ok: true.
 * Honesty declaration is host-owned from package terminals (silent partial impossible).
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ToolRuntime } from "../types.js";
import type { FindingRecord, FindingStore } from "./finding-store.js";
import {
  ensureProcessQuality,
  type ProcessQualityState,
} from "./package-honesty-host.js";
import {
  evaluateHonestPartial,
  filterPackageTerminalsForStage,
  type PackageAttemptRecord,
} from "./package-settlement-law.js";
import {
  normalizeSubagentResult,
  type SubagentCandidate,
  type SubagentFactNote,
  type SubagentStructuredResult,
  type SubagentSurface,
} from "./subagent-result.js";

/** Package terminals that must be declared for honest partial (host-owned). */
export function packageNeedsHostDeclaration(p: PackageAttemptRecord): boolean {
  return (
    p.terminal === "failed" ||
    p.terminal === "never_started" ||
    p.terminal === "aborted" ||
    (p.terminal === "success" && Boolean(p.salvaged))
  );
}

/** Host-owned declare keys — exact package keys only (no fuzzy match). */
export function hostDeclareFailedKeys(packages: PackageAttemptRecord[]): string[] {
  return packages.filter(packageNeedsHostDeclaration).map((p) => p.package_key);
}

export type HostStageSettlementInput = {
  stageId: string;
  runtime: ToolRuntime;
  /**
   * Optional narrative fields from the stage session (summary/facts/notes).
   * Never used for honesty ok or as a substitute for Store/ledger surfaces/candidates.
   */
  narrative?: {
    summary?: string;
    facts?: SubagentFactNote[];
    notes?: string;
    deadends?: string[];
  };
  /** When true (default), host auto-declares packages needing declaration. */
  hostDeclare?: boolean;
  /**
   * Optional workdir for settlement audit JSON (forensics only — not gate input).
   */
  auditWorkDir?: string;
};

export type HostStageSettlement = {
  structured: SubagentStructuredResult;
  honesty: ReturnType<typeof evaluateHonestPartial>;
  host_declared_keys: string[];
  feedback_ok_ids: string[];
  package_count: number;
  running_packages: string[];
  agent_result_json_ignored: true;
};

function storeCandidatesToProjection(rows: FindingRecord[]): SubagentCandidate[] {
  const out: SubagentCandidate[] = [];
  for (const r of rows) {
    if (r.prior) continue;
    if (r.status === "withdrawn" || r.status === "superseded") continue;
    out.push({
      title: r.title,
      location: r.location,
      claim: r.description,
      proof_excerpt: r.proof_excerpt,
      poc_hint: r.poc,
    });
  }
  return out.slice(0, 80);
}

function surfacesFromLedger(runtime: ToolRuntime): SubagentSurface[] {
  const ledger = runtime.surfaceLedger;
  if (!ledger) return [];
  // Prefer in-memory cache; load may be async elsewhere — use all() when warm.
  const items = ledger.all();
  return items.slice(0, 80).map((s) => ({
    location: s.location,
    kind: s.kind,
    params: s.params,
    auth: s.auth,
    note: s.note,
  }));
}

function candidatesFromEvidenceCache(
  runtime: ToolRuntime,
  stageId: string,
): SubagentCandidate[] {
  const packs = runtime.lifecycle?.subagentEvidenceCache || [];
  const out: SubagentCandidate[] = [];
  for (const pack of packs) {
    for (const c of pack.candidates || []) {
      if (c.title || c.location || c.proof_excerpt) {
        out.push({
          title: c.title,
          location: c.location,
          claim: c.claim,
          proof_excerpt: c.proof_excerpt,
          poc_hint: c.poc_hint,
        });
      }
    }
  }
  void stageId;
  return out.slice(0, 80);
}

function mergeCandidates(
  storeRows: SubagentCandidate[],
  evidence: SubagentCandidate[],
): SubagentCandidate[] {
  const seen = new Set<string>();
  const out: SubagentCandidate[] = [];
  for (const c of [...storeRows, ...evidence]) {
    const key = `${String(c.location || "").toLowerCase()}|${String(c.title || "").toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
    if (out.length >= 80) break;
  }
  return out;
}

function feedbackOkIds(store: FindingStore, stageId: string): string[] {
  return store
    .snapshot()
    .filter(
      (r) =>
        r.status === "feedback_ok" &&
        (!r.stage_id || r.stage_id === stageId || !stageId),
    )
    .map((r) => r.id);
}

/**
 * Project stage outcome from host state only.
 * Agent result.json is never read here.
 */
export function settleHostStage(input: HostStageSettlementInput): HostStageSettlement {
  const stageId = String(input.stageId || "").trim();
  const runtime = input.runtime;
  const pq: ProcessQualityState = ensureProcessQuality(runtime.lifecycle);
  const packages = filterPackageTerminalsForStage(pq.packageTerminals, stageId);
  const hostDeclare = input.hostDeclare !== false;
  const host_declared_keys = hostDeclare ? hostDeclareFailedKeys(packages) : [];

  const honesty = evaluateHonestPartial({
    packages,
    // Host-owned declare: silent partial cannot form when host settles.
    declared_failed_keys: host_declared_keys,
    // Never trust agent ok:true as full-success claim under host settlement.
    claims_full_success: false,
    l2_done_for_keys: packages
      .filter((p) => p.terminal === "success" && !p.salvaged)
      .map((p) => p.package_key),
  });

  const running_packages = packages
    .filter((p) => p.terminal === "running")
    .map((p) => p.package_key);

  const storeRows = pq.findingStore
    .snapshot()
    .filter((r) => !r.stage_id || r.stage_id === stageId || !stageId);
  const candidates = mergeCandidates(
    storeCandidatesToProjection(storeRows),
    candidatesFromEvidenceCache(runtime, stageId),
  );
  const surfaces = surfacesFromLedger(runtime);
  const feedback_ok_ids = feedbackOkIds(pq.findingStore, stageId);

  const narrativeSummary = String(input.narrative?.summary || "").trim();
  // Spec #125: require.summary must not pass on synthetic host fillers alone.
  const realSummary = narrativeSummary.length > 0;
  const hostSummaryParts: string[] = [];
  if (realSummary) hostSummaryParts.push(narrativeSummary);
  if (packages.length) {
    const okN = packages.filter((p) => p.terminal === "success" && !p.salvaged).length;
    const failN = packages.filter(packageNeedsHostDeclaration).length;
    hostSummaryParts.push(
      `host settlement: packages success=${okN} need_declare=${failN} stage=${stageId}`,
    );
  }
  if (surfaces.length) hostSummaryParts.push(`surfaces=${surfaces.length}`);
  if (candidates.length) hostSummaryParts.push(`store_candidates=${candidates.length}`);
  if (feedback_ok_ids.length) {
    hostSummaryParts.push(`feedback_ok_ids=${feedback_ok_ids.join(",")}`);
  }
  // Display-only fallback when no narrative — does not set summaryProvided.
  const displaySummary = hostSummaryParts.length
    ? hostSummaryParts.join(" · ")
    : `host settlement stage=${stageId || "unknown"}`;

  const deadends = [
    ...(input.narrative?.deadends || []).map((d) => String(d || "").trim()).filter(Boolean),
    ...host_declared_keys.map((k) => `failed_package:${k}`),
    ...running_packages.map((k) => `running_package:${k}`),
  ];

  // ok = honesty ∧ no running packages (Spec #125 state machine)
  const settlementOk = honesty.ok && running_packages.length === 0;

  // When no real narrative summary, omit summary so summaryProvided stays false
  // (fail-closed require.summary) unless packages/surfaces already carry host work signal.
  const summaryForGate =
    realSummary || packages.length > 0 || surfaces.length > 0 || candidates.length > 0
      ? displaySummary
      : undefined;
  const structured = normalizeSubagentResult({
    ok: settlementOk,
    ...(summaryForGate ? { summary: summaryForGate } : {}),
    surfaces,
    candidates,
    facts: input.narrative?.facts || [],
    deadends,
    notes: input.narrative?.notes,
    // Captain-visible confirmable ids (machine surface for Main)
    feedback_ok_ids,
    host_declared_failed: host_declared_keys,
    package_terminals_n: packages.length,
  });

  return {
    structured,
    honesty,
    host_declared_keys,
    feedback_ok_ids,
    package_count: packages.length,
    running_packages,
    agent_result_json_ignored: true,
  };
}

/**
 * Optional forensic audit under stage workdir — not agent-facing SoT, not a gate input.
 */
export async function writeHostSettlementAudit(
  workDir: string,
  settlement: HostStageSettlement,
): Promise<void> {
  try {
    await writeFile(
      join(workDir, "host-settlement-audit.json"),
      JSON.stringify(
        {
          agent_result_json_ignored: true,
          honesty: settlement.honesty,
          host_declared_keys: settlement.host_declared_keys,
          feedback_ok_ids: settlement.feedback_ok_ids,
          package_count: settlement.package_count,
          running_packages: settlement.running_packages,
          structured: {
            ok: settlement.structured.ok,
            summary: settlement.structured.summary,
            surfaces_n: settlement.structured.surfaces.length,
            candidates_n: settlement.structured.candidates.length,
            deadends: settlement.structured.deadends,
          },
        },
        null,
        2,
      ),
      "utf8",
    );
  } catch {
    /* audit is best-effort */
  }
}
