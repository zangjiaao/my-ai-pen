/**
 * Spec #125 host stage settlement — sole stage outcome projector for Expert Graph.
 *
 * Business SoT: Finding Store + package terminals + surface ledger (+ package evidence).
 * Agent-authored result.json is ignored even if present with ok: true.
 * Host owns failure declaration from package terminals (silent partial impossible).
 *
 * Settlement ok under host ownership = no running packages.
 * Host-declared failure keys are metadata for deadends/audit, not an agent honesty ritual.
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
  filterPackageTerminalsForStage,
  type PackageAttemptRecord,
} from "./package-settlement-law.js";
import { hardStagePackageKey } from "./hard-graph-continuity.js";
import {
  normalizeSubagentResult,
  type SubagentCandidate,
  type SubagentFactNote,
  type SubagentStructuredResult,
  type SubagentSurface,
} from "./subagent-result.js";

/** Package terminals that host must surface as declared failures (metadata). */
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

/**
 * Host-owned honesty snapshot. Silent partial cannot form: host always declares
 * every package that needs declaration. `ok` is true iff no packages are still running.
 */
export type HostHonestySnapshot = {
  ok: boolean;
  silent_partial: false;
  undeclared_failures: [];
  illegal_l2_done: [];
  host_owned_declare: true;
  running_packages: string[];
};

export type HostStageNarrative = {
  summary?: string;
  facts?: SubagentFactNote[];
  notes?: string;
  deadends?: string[];
};

export type HostStageSettlementInput = {
  stageId: string;
  runtime: ToolRuntime;
  /**
   * Optional narrative from the stage session (summary/facts/notes).
   * Never used for honesty ok or as a substitute for Store/ledger surfaces/candidates.
   * Never deposited into Store/ledger.
   */
  narrative?: HostStageNarrative;
};

/**
 * Gate-facing structured projection plus captain-visible host fields.
 * Do not pass host fields through normalizeSubagentResult — they live here.
 */
export type HostStageProjection = {
  /** Shape accepted by evaluateStageGate / handoff merge. */
  structured: SubagentStructuredResult;
  feedback_ok_ids: string[];
  host_declared_failed: string[];
  package_terminals_n: number;
  package_count: number;
  running_packages: string[];
};

export type HostStageSettlement = HostStageProjection & {
  honesty: HostHonestySnapshot;
  host_declared_keys: string[];
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
  const items = ledger.all();
  return items.slice(0, 80).map((s) => ({
    location: s.location,
    kind: s.kind,
    params: s.params,
    auth: s.auth,
    note: s.note,
  }));
}

/**
 * Evidence cache packs for this stage only (hard-stage:<stageId> prefix).
 * Prevents other stages' package evidence from polluting settlement.
 */
function candidatesFromEvidenceCache(
  runtime: ToolRuntime,
  stageId: string,
): SubagentCandidate[] {
  const packs = runtime.lifecycle?.subagentEvidenceCache || [];
  const stagePrefix = hardStagePackageKey(stageId);
  const out: SubagentCandidate[] = [];
  for (const pack of packs) {
    const id = String(pack.subagentId || "");
    // Accept exact stage key, worker keys under stage, or packs without id only when stage empty.
    const inStage =
      !stageId ||
      id === stagePrefix ||
      id.startsWith(`${stagePrefix}:`) ||
      // Legacy packs keyed only by worker id still include candidates for current stage
      // when subagentId is empty — skip unscoped packs to avoid cross-stage pollution.
      false;
    if (!inStage) continue;
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
  // Host always owns declare — no agent-declare path, no hostDeclare flag.
  const host_declared_keys = hostDeclareFailedKeys(packages);

  const running_packages = packages
    .filter((p) => p.terminal === "running")
    .map((p) => p.package_key);

  // Host settlement ok: no in-flight packages. Declare is host-owned metadata only.
  const settlementOk = running_packages.length === 0;
  const honesty: HostHonestySnapshot = {
    ok: settlementOk,
    silent_partial: false,
    undeclared_failures: [],
    illegal_l2_done: [],
    host_owned_declare: true,
    running_packages,
  };

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
  const realSummary = narrativeSummary.length > 0;
  /**
   * summaryProvided for gates:
   * - real captain/session narrative, OR
   * - host work signal (packages started, surfaces in ledger, or store/evidence candidates)
   * Empty stage with neither narrative nor host work → no summary (fail-closed require.summary).
   */
  const hostWorkSignal =
    packages.length > 0 || surfaces.length > 0 || candidates.length > 0;
  const summaryParts: string[] = [];
  if (realSummary) summaryParts.push(narrativeSummary);
  if (packages.length) {
    const okN = packages.filter((p) => p.terminal === "success" && !p.salvaged).length;
    const failN = packages.filter(packageNeedsHostDeclaration).length;
    summaryParts.push(
      `host settlement: packages success=${okN} need_declare=${failN} stage=${stageId}`,
    );
  }
  if (surfaces.length) summaryParts.push(`surfaces=${surfaces.length}`);
  if (candidates.length) summaryParts.push(`store_candidates=${candidates.length}`);
  if (feedback_ok_ids.length) {
    summaryParts.push(`feedback_ok_ids=${feedback_ok_ids.join(",")}`);
  }
  const summaryForGate =
    realSummary || hostWorkSignal
      ? summaryParts.join(" · ") || `host settlement stage=${stageId || "unknown"}`
      : undefined;

  const deadends = [
    ...(input.narrative?.deadends || []).map((d) => String(d || "").trim()).filter(Boolean),
    ...host_declared_keys.map((k) => `failed_package:${k}`),
    ...running_packages.map((k) => `running_package:${k}`),
  ];

  // Gate shape only — host captain fields live on HostStageSettlement, not inside normalize.
  const structured = normalizeSubagentResult({
    ok: settlementOk,
    ...(summaryForGate ? { summary: summaryForGate } : {}),
    surfaces,
    candidates,
    facts: input.narrative?.facts || [],
    deadends,
    notes: input.narrative?.notes,
  });

  return {
    structured,
    honesty,
    host_declared_keys,
    feedback_ok_ids,
    host_declared_failed: host_declared_keys,
    package_terminals_n: packages.length,
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
            summaryProvided: settlement.structured.summaryProvided,
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
