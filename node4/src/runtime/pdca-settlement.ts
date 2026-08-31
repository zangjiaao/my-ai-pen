/**
 * Spec #519 — Case-driven PDCA: compact live overlay, changelog TurnDelta,
 * and host-owned terminal consistency (false-completion veto).
 *
 * Overlay is derived Product state, not a writable ledger.
 * Agent natural stop is an implicit settle proposal; this module owns the verdict.
 */

import { isSurfaceActionable, coerceSurfaceCoverage } from "../stores/surface-coverage.js";
import { hasOpenApproval } from "./approvals.js";
import { HARNESS_CONTINUE_NOTICE } from "./harness-channel.js";
import type { ToolRuntime } from "../types.js";
import { mergeStashIntoCaseList } from "../tools/workset.js";

export const PDCA_IDENTITY_CAP = 12;
export const PDCA_DELTA_CAP = 20;
export const DEFAULT_PDCA_MAX_NO_PROGRESS = 2;

export type PdcaVerdict = "replan" | "paused" | "completed" | "incomplete" | "blocked";

/** In-loop PDCA already decided; post-loop must not re-settle these. */
export function isTerminalPdcaVerdict(verdict: PdcaVerdict | undefined): boolean {
  return verdict === "blocked" || verdict === "completed" || verdict === "paused";
}

export type PdcaIdentityKind =
  | "surface"
  | "hypothesis"
  | "finding"
  | "package"
  | "worker"
  | "decision"
  | "workset";

export type PdcaIdentity = {
  kind: PdcaIdentityKind;
  id: string;
  summary?: string;
};

export type LiveStateOverlay = {
  surfaces: {
    untested: number;
    tested: number;
    skipped: number;
    actionable: PdcaIdentity[];
    omitted: number;
  };
  hypotheses: {
    active: PdcaIdentity[];
    deferred: PdcaIdentity[];
    omitted: number;
  };
  todos: { open: number };
  packages: {
    running: PdcaIdentity[];
    omitted: number;
  };
  pendingWorkerReconciliation: PdcaIdentity[];
  pendingWorkerOmitted: number;
  findings: {
    booked: number;
    feedbackOkUnbooked: PdcaIdentity[];
    omitted: number;
  };
  pendingUserDecision: boolean;
  /** Spec #540 — proposed t_host rows waiting for user adopt (live index only; not Agent unresolved). */
  admission: PdcaIdentity[];
  admissionOmitted: number;
};

export type TurnDeltaEntry = {
  action: "added" | "removed" | "changed";
  entity_type: string;
  entity_id: string;
  summary: string;
};

export type TurnDelta = {
  entries: TurnDeltaEntry[];
  omitted: number;
};

export type OverlayProjectionInput = {
  surfaces?: Array<{
    id?: string;
    location?: string;
    path_key?: string;
    status?: string;
    coverage?: string;
  }>;
  hypotheses?: Array<{ id: string; status: string; statement?: string }>;
  todoOpenCount?: number;
  runningPackages?: Array<{ id: string; summary?: string }>;
  pendingWorkers?: Array<{ id: string; summary?: string }>;
  findings?: Array<{ id: string; status: string; title?: string; location?: string }>;
  pendingUserDecision?: boolean;
  /** Spec #540 — Case Workset open refs (pending admission). */
  worksetOpen?: Array<{
    id?: string;
    family?: string;
    title?: string;
    status?: string;
    host?: string;
    location?: string;
  }>;
};

export type TerminalConsistencyResult = {
  verdict: PdcaVerdict;
  unresolved: PdcaIdentity[];
  reason: string;
};

export type ParticipantTurnSettlement = TerminalConsistencyResult & {
  delta: TurnDelta;
  nextNoProgressStreak: number;
  replanPrompt?: string;
};

/** Lab flag. End-of-burst settle still runs on chat-only expert (no target yet); skip ledger-assist seats at the caller. */
export function pdcaSettleEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = String(env.NODE4_PDCA_SETTLE || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

export function emptyOverlay(): LiveStateOverlay {
  return {
    surfaces: { untested: 0, tested: 0, skipped: 0, actionable: [], omitted: 0 },
    hypotheses: { active: [], deferred: [], omitted: 0 },
    todos: { open: 0 },
    packages: { running: [], omitted: 0 },
    pendingWorkerReconciliation: [],
    pendingWorkerOmitted: 0,
    findings: { booked: 0, feedbackOkUnbooked: [], omitted: 0 },
    pendingUserDecision: false,
    admission: [],
    admissionOmitted: 0,
  };
}

function capIdentities(list: PdcaIdentity[], cap = PDCA_IDENTITY_CAP): {
  kept: PdcaIdentity[];
  omitted: number;
} {
  if (list.length <= cap) return { kept: list, omitted: 0 };
  return { kept: list.slice(0, cap), omitted: list.length - cap };
}

function surfaceId(row: {
  id?: string;
  location?: string;
  path_key?: string;
}): string {
  return String(row.id || row.path_key || row.location || "").trim();
}

export function projectLiveStateOverlay(input: OverlayProjectionInput = {}): LiveStateOverlay {
  const surfaces = Array.isArray(input.surfaces) ? input.surfaces : [];
  let untested = 0;
  let tested = 0;
  let skipped = 0;
  const actionableRaw: PdcaIdentity[] = [];
  for (const row of surfaces) {
    const cov = coerceSurfaceCoverage(row.coverage);
    if (cov === "tested") tested += 1;
    else if (cov === "skipped") skipped += 1;
    else untested += 1;
    if (isSurfaceActionable(row)) {
      const id = surfaceId(row);
      if (id) {
        actionableRaw.push({
          kind: "surface",
          id,
          summary: String(row.location || row.path_key || id),
        });
      }
    }
  }
  const actionable = capIdentities(actionableRaw);

  const hypActiveRaw: PdcaIdentity[] = [];
  const hypDeferredRaw: PdcaIdentity[] = [];
  for (const h of input.hypotheses || []) {
    const id = String(h.id || "").trim();
    if (!id) continue;
    const ident: PdcaIdentity = {
      kind: "hypothesis",
      id,
      summary: String(h.statement || "").trim() || undefined,
    };
    const st = String(h.status || "").trim().toLowerCase();
    if (st === "active") hypActiveRaw.push(ident);
    else if (st === "deferred") hypDeferredRaw.push(ident);
  }
  const hypActive = capIdentities(hypActiveRaw);
  const hypDeferred = capIdentities(hypDeferredRaw);

  const runningRaw = (input.runningPackages || [])
    .map((p) => ({
      kind: "package" as const,
      id: String(p.id || "").trim(),
      summary: p.summary,
    }))
    .filter((p) => p.id);
  const running = capIdentities(runningRaw);

  const pendingWorkers = capIdentities(
    (input.pendingWorkers || [])
      .map((w) => ({
        kind: "worker" as const,
        id: String(w.id || "").trim(),
        summary: w.summary,
      }))
      .filter((w) => w.id),
  );

  let booked = 0;
  const feedbackOkRaw: PdcaIdentity[] = [];
  for (const f of input.findings || []) {
    const st = String(f.status || "").trim().toLowerCase();
    if (st === "booked") booked += 1;
    else if (st === "feedback_ok") {
      const id = String(f.id || "").trim();
      if (id) {
        feedbackOkRaw.push({
          kind: "finding",
          id,
          summary: String(f.title || f.location || id),
        });
      }
    }
  }
  const feedbackOk = capIdentities(feedbackOkRaw);

  const admissionRaw: PdcaIdentity[] = [];
  for (const w of input.worksetOpen || []) {
    const st = String(w.status || "").trim().toLowerCase();
    const fam = String(w.family || "").trim().toLowerCase();
    if (st !== "proposed" || fam !== "t_host") continue;
    const id =
      String(w.id || "").trim() ||
      (fam === "t_host"
        ? `t_host:${String(w.host || w.title || "").trim().toLowerCase()}`
        : `t_surface:${String(w.location || w.title || "").trim().toLowerCase()}`);
    if (!id || id.endsWith(":")) continue;
    admissionRaw.push({
      kind: "workset",
      id,
      summary: String(w.title || id),
    });
  }
  const admission = capIdentities(admissionRaw);

  return {
    surfaces: {
      untested,
      tested,
      skipped,
      actionable: actionable.kept,
      omitted: actionable.omitted,
    },
    hypotheses: {
      active: hypActive.kept,
      deferred: hypDeferred.kept,
      omitted: hypActive.omitted + hypDeferred.omitted,
    },
    todos: { open: Math.max(0, input.todoOpenCount ?? 0) },
    packages: { running: running.kept, omitted: running.omitted },
    pendingWorkerReconciliation: pendingWorkers.kept,
    pendingWorkerOmitted: pendingWorkers.omitted,
    findings: {
      booked,
      feedbackOkUnbooked: feedbackOk.kept,
      omitted: feedbackOk.omitted,
    },
    pendingUserDecision: Boolean(input.pendingUserDecision),
    admission: admission.kept,
    admissionOmitted: admission.omitted,
  };
}

function identityKey(id: PdcaIdentity): string {
  return `${id.kind}:${id.id}`;
}

function setOf(list: PdcaIdentity[]): Map<string, PdcaIdentity> {
  const m = new Map<string, PdcaIdentity>();
  for (const i of list) m.set(identityKey(i), i);
  return m;
}

function diffLists(
  before: PdcaIdentity[],
  after: PdcaIdentity[],
  entityType: string,
): TurnDeltaEntry[] {
  const b = setOf(before);
  const a = setOf(after);
  const entries: TurnDeltaEntry[] = [];
  for (const [k, ident] of a) {
    if (!b.has(k)) {
      entries.push({
        action: "added",
        entity_type: entityType,
        entity_id: ident.id,
        summary: ident.summary || ident.id,
      });
    }
  }
  for (const [k, ident] of b) {
    if (!a.has(k)) {
      entries.push({
        action: "removed",
        entity_type: entityType,
        entity_id: ident.id,
        summary: ident.summary || ident.id,
      });
    }
  }
  return entries;
}

export function computeTurnDelta(
  before: LiveStateOverlay,
  after: LiveStateOverlay,
  maxEntries = PDCA_DELTA_CAP,
): TurnDelta {
  const raw: TurnDeltaEntry[] = [
    ...diffLists(before.surfaces.actionable, after.surfaces.actionable, "surface"),
    ...diffLists(before.hypotheses.active, after.hypotheses.active, "hypothesis"),
    ...diffLists(before.packages.running, after.packages.running, "package"),
    ...diffLists(
      before.pendingWorkerReconciliation,
      after.pendingWorkerReconciliation,
      "worker",
    ),
    ...diffLists(
      before.findings.feedbackOkUnbooked,
      after.findings.feedbackOkUnbooked,
      "finding",
    ),
    ...diffLists(before.admission || [], after.admission || [], "workset"),
  ];
  if (before.findings.booked !== after.findings.booked) {
    raw.push({
      action: "changed",
      entity_type: "finding",
      entity_id: "booked",
      summary: `booked ${before.findings.booked} → ${after.findings.booked}`,
    });
  }
  if (before.surfaces.tested !== after.surfaces.tested) {
    raw.push({
      action: "changed",
      entity_type: "coverage",
      entity_id: "tested",
      summary: `tested ${before.surfaces.tested} → ${after.surfaces.tested}`,
    });
  }
  if (before.pendingUserDecision !== after.pendingUserDecision) {
    raw.push({
      action: after.pendingUserDecision ? "added" : "removed",
      entity_type: "decision",
      entity_id: "user",
      summary: after.pendingUserDecision ? "pending user decision" : "user decision cleared",
    });
  }
  if (raw.length <= maxEntries) return { entries: raw, omitted: 0 };
  return { entries: raw.slice(0, maxEntries), omitted: raw.length - maxEntries };
}

export function collectUnresolved(overlay: LiveStateOverlay): PdcaIdentity[] {
  return [
    ...overlay.packages.running,
    ...overlay.pendingWorkerReconciliation,
    ...overlay.findings.feedbackOkUnbooked,
    ...overlay.surfaces.actionable,
    ...overlay.hypotheses.active,
  ];
}

export function evaluateTerminalConsistency(options: {
  overlay: LiveStateOverlay;
  aborted?: boolean;
  hadDelta?: boolean;
  noProgressStreak?: number;
  maxNoProgress?: number;
}): TerminalConsistencyResult {
  // HITL wait beats interrupt: Stop while a card is open is paused (session kept).
  // Card Cancel clears pending first, then abort → incomplete below.
  if (options.overlay.pendingUserDecision) {
    return {
      verdict: "paused",
      unresolved: [{ kind: "decision", id: "user", summary: "pending user decision" }],
      reason: "pending_user_decision",
    };
  }
  if (options.aborted) {
    return { verdict: "incomplete", unresolved: collectUnresolved(options.overlay), reason: "aborted" };
  }
  const unresolved = collectUnresolved(options.overlay);
  if (unresolved.length === 0) {
    return { verdict: "completed", unresolved: [], reason: "natural_stop" };
  }
  const maxNo = options.maxNoProgress ?? DEFAULT_PDCA_MAX_NO_PROGRESS;
  const nextStreak = options.hadDelta ? 0 : Math.max(0, options.noProgressStreak ?? 0) + 1;
  if (nextStreak >= maxNo) {
    return {
      verdict: "blocked",
      unresolved,
      reason: "no_progress_budget",
    };
  }
  return { verdict: "replan", unresolved, reason: "unresolved_state" };
}

/** Index-like harness view (capped identities). Not a Case dump. */
export function formatLiveStateHarness(overlay: LiveStateOverlay, delta?: TurnDelta): string {
  const ident = (row: PdcaIdentity) =>
    row.summary && row.summary !== row.id ? `${row.id} — ${row.summary}` : row.id;
  const lines: string[] = [
    "### Case live index",
    `Surfaces: untested=${overlay.surfaces.untested} tested=${overlay.surfaces.tested} skipped=${overlay.surfaces.skipped}` +
      (overlay.surfaces.omitted ? ` (actionable omitted=${overlay.surfaces.omitted})` : ""),
  ];
  if (overlay.surfaces.actionable.length) {
    lines.push("Actionable surfaces:");
    for (const s of overlay.surfaces.actionable) lines.push(`  - ${ident(s)}`);
  }
  if (overlay.hypotheses.active.length) {
    lines.push("Active hypotheses:");
    for (const h of overlay.hypotheses.active) lines.push(`  - ${ident(h)}`);
  }
  if (overlay.hypotheses.omitted) {
    lines.push(`  (hypotheses omitted=${overlay.hypotheses.omitted})`);
  }
  lines.push(`Findings booked=${overlay.findings.booked}`);
  if (overlay.findings.feedbackOkUnbooked.length) {
    lines.push("feedback_ok unbooked:");
    for (const f of overlay.findings.feedbackOkUnbooked) lines.push(`  - ${ident(f)}`);
  }
  if (overlay.findings.omitted) {
    lines.push(`  (findings omitted=${overlay.findings.omitted})`);
  }
  if (overlay.packages.running.length) {
    lines.push("Running packages:");
    for (const p of overlay.packages.running) lines.push(`  - ${ident(p)}`);
  }
  if (overlay.pendingWorkerReconciliation.length) {
    lines.push("Pending Worker reconciliation:");
    for (const w of overlay.pendingWorkerReconciliation) lines.push(`  - ${ident(w)}`);
  }
  if (overlay.pendingWorkerOmitted) {
    lines.push(`  (workers omitted=${overlay.pendingWorkerOmitted})`);
  }
  if (overlay.pendingUserDecision) lines.push("Pending user decision: yes");
  if ((overlay.admission || []).length) {
    lines.push("Pending admission (Workset t_host proposed — user adopt / authorize; not Agent work):");
    for (const a of overlay.admission) lines.push(`  - ${ident(a)}`);
  }
  if (overlay.admissionOmitted) {
    lines.push(`  (admission omitted=${overlay.admissionOmitted})`);
  }
  lines.push(
    "Full records stay on-demand: surface(list|get), finding(list|get), workset(list|get), platform_list_intel / platform_get_intel.",
  );
  if (delta && (delta.entries.length > 0 || delta.omitted > 0)) {
    lines.push("Turn changes:");
    for (const e of delta.entries) {
      lines.push(`  [${e.action}] ${e.entity_type} ${e.entity_id}: ${e.summary}`);
    }
    if (delta.omitted) lines.push(`  (delta omitted=${delta.omitted})`);
  }
  return lines.join("\n");
}

export function formatReplanPrompt(delta: TurnDelta, unresolved: PdcaIdentity[]): string {
  const changeLines =
    delta.entries.length > 0
      ? delta.entries.map((e) => `  [${e.action}] ${e.entity_type} ${e.entity_id}: ${e.summary}`)
      : ["  (no Product-state change this round)"];
  const residualLines = unresolved.slice(0, PDCA_IDENTITY_CAP).map((u) => {
    const extra = u.summary && u.summary !== u.id ? ` — ${u.summary}` : "";
    return `  - ${u.kind} ${u.id}${extra}`;
  });
  return [
    "### Continue",
    HARNESS_CONTINUE_NOTICE,
    "Host settlement: named Product-state work is still open. This stop is not complete.",
    "Turn changes:",
    ...changeLines,
    "Unresolved (act, disposition, or disclose):",
    ...residualLines,
    "Zero Findings is valid once remaining work is dispositioned. An empty Todo map is not completion.",
  ].join("\n");
}

export function settleParticipantTurn(options: {
  overlay: LiveStateOverlay;
  previousOverlay?: LiveStateOverlay;
  aborted?: boolean;
  noProgressStreak?: number;
  maxNoProgress?: number;
}): ParticipantTurnSettlement {
  const previous = options.previousOverlay ?? emptyOverlay();
  const delta = computeTurnDelta(previous, options.overlay);
  const hadDelta = delta.entries.length > 0;
  const maxNo = options.maxNoProgress ?? DEFAULT_PDCA_MAX_NO_PROGRESS;
  const result = evaluateTerminalConsistency({
    overlay: options.overlay,
    aborted: options.aborted,
    hadDelta,
    noProgressStreak: options.noProgressStreak,
    maxNoProgress: maxNo,
  });
  const nextNoProgressStreak =
    result.verdict === "replan"
      ? hadDelta
        ? 0
        : Math.max(0, options.noProgressStreak ?? 0) + 1
      : result.verdict === "blocked"
        ? maxNo
        : 0;
  return {
    ...result,
    delta,
    nextNoProgressStreak,
    replanPrompt:
      result.verdict === "replan" ? formatReplanPrompt(delta, result.unresolved) : undefined,
  };
}

export function persistPdcaOnRuntime(
  runtime: ToolRuntime,
  pdca: ParticipantTurnSettlement,
): void {
  runtime.lifecycle.pdcaNoProgressStreak = pdca.nextNoProgressStreak;
  runtime.lifecycle.pdcaLastDeltaEntries = pdca.delta.entries;
}

export function lastDeltaFromRuntime(runtime: ToolRuntime): TurnDelta | undefined {
  const entries = runtime.lifecycle.pdcaLastDeltaEntries;
  if (!entries?.length) return undefined;
  return { entries, omitted: 0 };
}

export function mapPdcaVerdictToHarnessStatus(
  verdict: PdcaVerdict,
): "completed" | "incomplete" | "blocked" {
  if (verdict === "completed") return "completed";
  if (verdict === "blocked") return "blocked";
  return "incomplete";
}

/** Graph may add milestones but must not complete while base honesty is dirty. */
export function applyBaseHonestyToGraphStatus(
  harnessStatus: "completed" | "incomplete" | "blocked",
  overlay: LiveStateOverlay,
): "completed" | "incomplete" | "blocked" {
  if (harnessStatus !== "completed") return harnessStatus;
  if (overlay.pendingUserDecision) return "incomplete";
  if (collectUnresolved(overlay).length > 0) return "incomplete";
  return "completed";
}

function pendingWorkersFromRuntime(runtime: ToolRuntime): Array<{ id: string; summary?: string }> {
  const out: Array<{ id: string; summary?: string }> = [];
  const panel = runtime.lifecycle.panelAgents;
  if (panel) {
    for (const row of panel.list()) {
      if (row.parent_id && row.status === "running") {
        out.push({ id: row.id, summary: row.task || "running" });
      }
    }
  }
  const last = runtime.lifecycle.lastSubagentEvidence;
  const ready = last?.acceptance?.ready_to_book || [];
  if (last && ready.length > 0) {
    const bookedLocs = new Set(
      (runtime.lifecycle.processQuality?.findingStore?.snapshot() || [])
        .filter((r) => r.status === "booked")
        .map((r) => String(r.location || "").toLowerCase()),
    );
    const stillOpen = ready.filter((c) => {
      const loc = String(c.location || "").toLowerCase();
      return !loc || !bookedLocs.has(loc);
    });
    if (stillOpen.length > 0) {
      out.push({
        id: last.subagentId,
        summary: `ready_to_book ${stillOpen.length}`,
      });
    }
  }
  return out;
}

function runningPackagesFromRuntime(runtime: ToolRuntime): Array<{ id: string; summary?: string }> {
  const terminals = runtime.lifecycle.processQuality?.packageTerminals;
  if (!terminals) return [];
  return Object.entries(terminals)
    .filter(([, p]) => p.terminal === "running")
    .map(([key, p]) => ({ id: key, summary: p.terminal }));
}

/**
 * Case Workset snapshot plus this-burst `workset(propose)` stash.
 * Assign-time `next_work.workset_open` is empty until the next task_assign.
 */
export function worksetOpenForPdcaOverlay(
  caseOpen: OverlayProjectionInput["worksetOpen"],
  stash?: import("./workset-emit.js").WorksetCandidate[],
): NonNullable<OverlayProjectionInput["worksetOpen"]> {
  const caseItems = (Array.isArray(caseOpen) ? caseOpen : []).map((w) => ({
    id: w.id,
    family: w.family,
    title: w.title,
    status: w.status || "proposed",
    host: w.host,
    location: w.location,
  }));
  return mergeStashIntoCaseList(caseItems, stash).map((row) => ({
    id: String(row.id || "").trim() || undefined,
    family: row.family,
    title: row.title,
    status: row.status || "proposed",
    host: row.host,
    location: row.location,
  }));
}

/**
 * Best-effort live projection from a ToolRuntime. Empty overlay on read failure.
 */
export async function projectOverlayFromRuntime(runtime: ToolRuntime): Promise<LiveStateOverlay> {
  let surfaces: OverlayProjectionInput["surfaces"] = [];
  try {
    const rows = await runtime.surfaceSqlite?.all?.();
    if (Array.isArray(rows)) surfaces = rows;
  } catch {
    surfaces = [];
  }
  const store = runtime.lifecycle.processQuality?.findingStore;
  const findings = store
    ? store.snapshot().map((r) => ({
        id: r.id,
        status: r.status,
        title: r.title,
        location: r.location,
      }))
    : [];
  const hyp = runtime.lifecycle.processQuality?.hypothesisStore;
  const hypotheses = hyp
    ? hyp.snapshot().map((r) => ({
        id: r.id,
        status: r.status,
        statement: r.statement,
      }))
    : [];
  let todoOpenCount = 0;
  try {
    todoOpenCount = runtime.todo?.openCount?.() ?? 0;
  } catch {
    todoOpenCount = 0;
  }
  return projectLiveStateOverlay({
    surfaces,
    hypotheses,
    todoOpenCount,
    runningPackages: runningPackagesFromRuntime(runtime),
    pendingWorkers: pendingWorkersFromRuntime(runtime),
    findings,
    pendingUserDecision:
      Boolean(runtime.lifecycle.pendingUserDecision) ||
      hasOpenApproval(runtime.task?.conversationId),
    worksetOpen: worksetOpenForPdcaOverlay(
      runtime.task?.caseContext?.next_work?.workset_open,
      runtime.lifecycle.worksetProposed,
    ),
  });
}
