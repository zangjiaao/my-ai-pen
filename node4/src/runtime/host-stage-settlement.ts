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

import { join } from "node:path";
import { writeFileInsideRoot } from "./session-workspace.js";
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
 * Host-owned honesty snapshot.
 * - Host always declares package failures (undeclared always empty).
 * - silent_partial only when illegal L2-done for unfinished/failed packages.
 * - ok when no running packages and no illegal L2-done.
 */
export type HostHonestySnapshot = {
  ok: boolean;
  silent_partial: boolean;
  undeclared_failures: [];
  illegal_l2_done: string[];
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

async function surfacesFromWorkingStore(runtime: ToolRuntime): Promise<SubagentSurface[]> {
  // Spec #371: prefer SQLite working store; legacy JSON only for partial test runtimes.
  if (runtime.surfaceSqlite) {
    try {
      await runtime.surfaceSqlite.open();
      const items = await runtime.surfaceSqlite.all();
      return items.slice(0, 80).map((s) => ({
        location: s.location,
        kind: s.kind,
        params: s.params,
        auth: s.auth,
        note: s.note,
      }));
    } catch {
      return [];
    }
  }
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
 * Spec #125 / I0.2–3: L2 marked done for unfinished/failed/salvage packages is illegal.
 * Reads Graph plan when present (Expert Graph coverage SoT).
 */
export function illegalL2DoneForPackages(
  runtime: ToolRuntime,
  packages: PackageAttemptRecord[],
  stageId: string,
): string[] {
  const plan = runtime.lifecycle?.hardGraphRun?.plan as
    | {
        toPlanTree?: () => Array<{
          node_id?: string;
          id?: string;
          status?: string;
          parent_id?: string | null;
        }>;
      }
    | undefined;
  if (!plan?.toPlanTree) return [];
  const stageParent = stageId ? `graph-stage-${stageId}` : "";
  const tree = plan.toPlanTree().filter((n) => {
    if (!stageParent) return true;
    const parent = String(n.parent_id || "");
    // Include L2 under this stage; also rows without parent if package key match later.
    return !parent || parent === stageParent;
  });
  const illegal: string[] = [];
  for (const p of packages) {
    const needsHonest =
      p.terminal === "failed" ||
      p.terminal === "never_started" ||
      p.terminal === "aborted" ||
      p.terminal === "running" ||
      (p.terminal === "success" && Boolean(p.salvaged));
    if (!needsHonest) continue;
    const key = String(p.package_key || "").trim();
    const planNode = String(p.plan_node_id || key).trim();
    if (!key) continue;
    for (const n of tree) {
      const id = String(n.node_id || n.id || "").trim();
      if (!id) continue;
      // Exact package key, plan_node_id, or pkg-* host mirror of that key.
      const matches =
        id === key ||
        id === planNode ||
        id === `pkg-${key}` ||
        id === `pkg-${planNode}`;
      if (!matches) continue;
      const st = String(n.status || "").toLowerCase();
      if (st === "done" || st === "completed" || st === "complete" || st === "skipped") {
        illegal.push(key);
        break;
      }
    }
  }
  return illegal;
}

/**
 * Project stage outcome from host state only.
 * Agent result.json is never read here.
 * Async: surface projection reads SQLite working store (#371).
 */
export async function settleHostStage(
  input: HostStageSettlementInput,
): Promise<HostStageSettlement> {
  const stageId = String(input.stageId || "").trim();
  const runtime = input.runtime;
  const pq: ProcessQualityState = ensureProcessQuality(runtime.lifecycle);
  const packages = filterPackageTerminalsForStage(pq.packageTerminals, stageId);
  // Host always owns declare — no agent-declare path, no hostDeclare flag.
  const host_declared_keys = hostDeclareFailedKeys(packages);

  const running_packages = packages
    .filter((p) => p.terminal === "running")
    .map((p) => p.package_key);

  const illegal_l2_done = illegalL2DoneForPackages(runtime, packages, stageId);

  // Host settlement ok: no in-flight packages and no illegal L2 greening of failures.
  const settlementOk = running_packages.length === 0 && illegal_l2_done.length === 0;
  const honesty: HostHonestySnapshot = {
    ok: settlementOk,
    silent_partial: illegal_l2_done.length > 0,
    undeclared_failures: [],
    illegal_l2_done,
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
  const surfaces = await surfacesFromWorkingStore(runtime);
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
  // Captain machine surface: confirmable Store ids (Spec #125 / #130).
  if (feedback_ok_ids.length) {
    summaryParts.push(`feedback_ok_ids=${feedback_ok_ids.join(",")}`);
  }
  if (illegal_l2_done.length) {
    summaryParts.push(`illegal_l2_done=${illegal_l2_done.join(",")}`);
  }
  const summaryForGate =
    realSummary || hostWorkSignal
      ? summaryParts.join(" · ") || `host settlement stage=${stageId || "unknown"}`
      : undefined;

  const deadends = [
    ...(input.narrative?.deadends || []).map((d) => String(d || "").trim()).filter(Boolean),
    ...host_declared_keys.map((k) => `failed_package:${k}`),
    ...running_packages.map((k) => `running_package:${k}`),
    ...illegal_l2_done.map((k) => `illegal_l2_done:${k}`),
  ];

  // Captain-visible confirm instruction in notes (machine + human readable).
  const captainNotes: string[] = [];
  if (input.narrative?.notes) captainNotes.push(String(input.narrative.notes));
  if (feedback_ok_ids.length) {
    captainNotes.push(
      `confirmable_feedback_ok_ids: ${feedback_ok_ids.join(",")} — use finding(confirm, finding_id=<id>)`,
    );
  }

  const structured = normalizeSubagentResult({
    ok: settlementOk,
    ...(summaryForGate ? { summary: summaryForGate } : {}),
    surfaces,
    candidates,
    facts: input.narrative?.facts || [],
    deadends,
    notes: captainNotes.length ? captainNotes.join("\n") : undefined,
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
    await writeFileInsideRoot(
      join(workDir, "host-settlement-audit.json"),
      workDir,
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
    );
  } catch {
    /* audit is best-effort */
  }
}
