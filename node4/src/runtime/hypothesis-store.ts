/**
 * Optional Expert Graph hypothesis queue (Spec #274 / docs/specs/hypothesis-evidence.md).
 * Run-local Product-state working memory — not Finding Store, not platform ledger.
 * Main commits only; Sub returns structured outcomes.
 */

import type { FindingStore } from "./finding-store.js";

export type HypothesisStatus = "active" | "confirmed" | "killed" | "deferred";

export type HypothesisRow = {
  id: string;
  status: HypothesisStatus;
  statement: string;
  signal: string;
  prove_if: string;
  disprove_if: string;
  revisit_if?: string;
  priority?: string | number;
  evidence_refs?: string[];
  package_ids?: string[];
  payload?: Record<string, unknown>;
  updated_at: string;
  created_at: string;
};

export type HypothesisUpsertInput = {
  id?: string;
  statement: string;
  signal: string;
  prove_if: string;
  disprove_if: string;
  revisit_if?: string;
  priority?: string | number;
  evidence_refs?: string[];
  package_ids?: string[];
  payload?: Record<string, unknown>;
};

export type HypothesisCommitInput = {
  id: string;
  status: "confirmed" | "killed" | "deferred";
  evidence_refs?: string[];
  revisit_if?: string;
  notes?: string;
};

/** Sub package structured outcome — never mutates the queue by itself. */
export type HypothesisPackageOutcome = {
  hypothesis_id?: string;
  result: "proved" | "disproved" | "inconclusive";
  evidence_refs?: string[];
  notes?: string;
  suggested_revisit_if?: string;
};

/** Promote summary for Handoff / Case materials (cross-Graph continuity). */
export type HypothesisPromoteSummary = {
  active_n: number;
  confirmed_n: number;
  killed_n: number;
  deferred_n: number;
  /** Compact gist rows (ids + statement stems). */
  gists: Array<{
    id: string;
    status: HypothesisStatus;
    statement: string;
    signal?: string;
    revisit_if?: string;
  }>;
};

export type HypothesisSeedGist = {
  id?: string;
  status?: HypothesisStatus | string;
  statement: string;
  signal?: string;
  prove_if?: string;
  disprove_if?: string;
  revisit_if?: string;
  priority?: string | number;
  payload?: Record<string, unknown>;
};

function nowIso(): string {
  return new Date().toISOString();
}

function newId(): string {
  return `hyp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function asStringList(v: unknown, max = 40): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v
    .map((x) => String(x ?? "").trim())
    .filter(Boolean)
    .slice(0, max);
  return out.length ? out : undefined;
}

/** Parse optional Sub package hypothesis_outcomes[] (structured settlement only). */
export function parseHypothesisPackageOutcomes(raw: unknown): HypothesisPackageOutcome[] {
  if (!Array.isArray(raw)) return [];
  const out: HypothesisPackageOutcome[] = [];
  for (const item of raw.slice(0, 40)) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const result = String(o.result || "").trim().toLowerCase();
    if (result !== "proved" && result !== "disproved" && result !== "inconclusive") continue;
    out.push({
      hypothesis_id: String(o.hypothesis_id || o.hypothesisId || "").trim() || undefined,
      result: result as HypothesisPackageOutcome["result"],
      evidence_refs: asStringList(o.evidence_refs ?? o.evidenceRefs),
      notes: String(o.notes || "").trim().slice(0, 2000) || undefined,
      suggested_revisit_if:
        String(o.suggested_revisit_if || o.suggestedRevisitIf || "").trim().slice(0, 1000) ||
        undefined,
    });
  }
  return out;
}

/**
 * Map a Sub package outcome to a Main commit suggestion.
 * Host never auto-commits; Main must call commit / apply_package_outcome.
 */
export function suggestedCommitFromPackageOutcome(
  outcome: HypothesisPackageOutcome,
): { status: "confirmed" | "killed" | "deferred"; revisit_if?: string } | null {
  if (outcome.result === "proved") return { status: "confirmed" };
  if (outcome.result === "disproved") {
    return {
      status: "killed",
      revisit_if: outcome.suggested_revisit_if,
    };
  }
  if (outcome.result === "inconclusive") {
    return {
      status: "deferred",
      revisit_if: outcome.suggested_revisit_if,
    };
  }
  return null;
}

export class HypothesisStore {
  private readonly byId = new Map<string, HypothesisRow>();

  snapshot(): HypothesisRow[] {
    return [...this.byId.values()].map((r) => ({ ...r, payload: r.payload ? { ...r.payload } : undefined }));
  }

  get(id: string): HypothesisRow | undefined {
    const r = this.byId.get(String(id || "").trim());
    return r ? { ...r, payload: r.payload ? { ...r.payload } : undefined } : undefined;
  }

  clear(): void {
    this.byId.clear();
  }

  counts(): {
    active_n: number;
    confirmed_n: number;
    killed_n: number;
    deferred_n: number;
    total_n: number;
  } {
    let active_n = 0;
    let confirmed_n = 0;
    let killed_n = 0;
    let deferred_n = 0;
    for (const r of this.byId.values()) {
      if (r.status === "active") active_n++;
      else if (r.status === "confirmed") confirmed_n++;
      else if (r.status === "killed") killed_n++;
      else if (r.status === "deferred") deferred_n++;
    }
    return {
      active_n,
      confirmed_n,
      killed_n,
      deferred_n,
      total_n: this.byId.size,
    };
  }

  list(filter?: { status?: HypothesisStatus | HypothesisStatus[] }): HypothesisRow[] {
    const statuses = filter?.status
      ? new Set(Array.isArray(filter.status) ? filter.status : [filter.status])
      : null;
    return this.snapshot().filter((r) => !statuses || statuses.has(r.status));
  }

  /**
   * Create or update a row. Upsert always lands as active (re-activate deferred/killed for rework).
   * Main-only at tool boundary.
   */
  upsert(input: HypothesisUpsertInput): HypothesisRow {
    const statement = String(input.statement || "").trim();
    const signal = String(input.signal || "").trim();
    const prove_if = String(input.prove_if || "").trim();
    const disprove_if = String(input.disprove_if || "").trim();
    if (!statement || !signal || !prove_if || !disprove_if) {
      throw new Error("hypothesis upsert requires statement, signal, prove_if, disprove_if");
    }
    const explicitId = String(input.id || "").trim();
    const now = nowIso();
    if (explicitId && this.byId.has(explicitId)) {
      const prev = this.byId.get(explicitId)!;
      const next: HypothesisRow = {
        ...prev,
        statement,
        signal,
        prove_if,
        disprove_if,
        revisit_if: input.revisit_if != null ? String(input.revisit_if).trim() || undefined : prev.revisit_if,
        priority: input.priority !== undefined ? input.priority : prev.priority,
        evidence_refs: input.evidence_refs ?? prev.evidence_refs,
        package_ids: input.package_ids ?? prev.package_ids,
        payload: input.payload !== undefined ? { ...input.payload } : prev.payload,
        status: "active",
        updated_at: now,
      };
      this.byId.set(explicitId, next);
      return { ...next };
    }
    const id = explicitId || newId();
    const row: HypothesisRow = {
      id,
      status: "active",
      statement,
      signal,
      prove_if,
      disprove_if,
      revisit_if: input.revisit_if ? String(input.revisit_if).trim() || undefined : undefined,
      priority: input.priority,
      evidence_refs: input.evidence_refs,
      package_ids: input.package_ids,
      payload: input.payload ? { ...input.payload } : undefined,
      created_at: now,
      updated_at: now,
    };
    this.byId.set(id, row);
    return { ...row };
  }

  /**
   * Main lifecycle commit: active → confirmed | killed | deferred.
   * Confirmed ≠ booked. Killed/Deferred never become ledger vulns.
   */
  commit(input: HypothesisCommitInput): HypothesisRow {
    const id = String(input.id || "").trim();
    const row = this.byId.get(id);
    if (!row) throw new Error(`hypothesis not found: ${id}`);
    if (input.status !== "confirmed" && input.status !== "killed" && input.status !== "deferred") {
      throw new Error("hypothesis commit status must be confirmed|killed|deferred");
    }
    const now = nowIso();
    const next: HypothesisRow = {
      ...row,
      status: input.status,
      evidence_refs: input.evidence_refs?.length
        ? [...(row.evidence_refs || []), ...input.evidence_refs].slice(0, 40)
        : row.evidence_refs,
      revisit_if:
        input.revisit_if != null
          ? String(input.revisit_if).trim() || undefined
          : row.revisit_if,
      updated_at: now,
    };
    this.byId.set(id, next);
    return { ...next };
  }

  /**
   * Main-mediated seed of a confirmed hypothesis into Finding Store (open path).
   * Does NOT confirm or book. Confirmed ≠ booked.
   * Killed/Deferred refuse.
   */
  seedConfirmedToStore(
    store: FindingStore,
    hypothesisId: string,
    locationFallback?: string,
  ): { ok: true; finding_id: string } | { ok: false; error: string } {
    const row = this.byId.get(String(hypothesisId || "").trim());
    if (!row) return { ok: false, error: `hypothesis not found: ${hypothesisId}` };
    if (row.status !== "confirmed") {
      return {
        ok: false,
        error: `only confirmed hypotheses may seed Finding Store (status=${row.status}); killed/deferred never ledger`,
      };
    }
    const payload = row.payload || {};
    const title =
      String(payload.title || "").trim() || row.statement.slice(0, 120);
    const location =
      String(payload.location || payload.url || "").trim() ||
      String(locationFallback || "").trim();
    if (!location) {
      return {
        ok: false,
        error: "seed requires location in payload.location (or locationFallback)",
      };
    }
    const severity = String(payload.severity || "").trim();
    if (!severity) {
      return {
        ok: false,
        error:
          "seed requires payload.severity (critical|high|medium|low|info) — silent medium banned (Spec #139 D1)",
      };
    }
    const proof = String(
      payload.proof_excerpt || payload.proof || (row.evidence_refs || [])[0] || "",
    ).trim();
    try {
      const result = store.upsert({
        title,
        location,
        description: row.statement,
        severity,
        proof_excerpt: proof || undefined,
        class_key: payload.class_key != null ? String(payload.class_key) : undefined,
        source: `hypothesis:${row.id}`,
      });
      return { ok: true, finding_id: result.id };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}

/** Budgeted queue projection for stage/Main prompts when mode is on. */
export function formatHypothesisQueueInjection(
  store: HypothesisStore | undefined | null,
  options?: { maxRows?: number },
): string {
  if (!store) return "";
  const max = options?.maxRows ?? 24;
  const counts = store.counts();
  const active = store.list({ status: "active" }).slice(0, max);
  const killed = store.list({ status: "killed" }).slice(0, 8);
  const deferred = store.list({ status: "deferred" }).slice(0, 8);
  const confirmed = store.list({ status: "confirmed" }).slice(0, 8);
  const line = (r: HypothesisRow) =>
    `- [${r.status}] id=${r.id} signal=${r.signal.slice(0, 80)} | ${r.statement.slice(0, 120)} | prove_if=${r.prove_if.slice(0, 80)} | disprove_if=${r.disprove_if.slice(0, 80)}${r.revisit_if ? ` | revisit_if=${r.revisit_if.slice(0, 60)}` : ""}`;
  return [
    "<hypothesis-queue>",
    `active_n=${counts.active_n} confirmed_n=${counts.confirmed_n} killed_n=${counts.killed_n} deferred_n=${counts.deferred_n}`,
    "SOT: host Product-state queue (not Finding Store; not chat). Main commits only; Sub returns proved|disproved|inconclusive outcomes.",
    "Confirmed ≠ booked — book only via Store feedback_ok → finding(confirm, finding_id).",
    "Prefer diverse actives with disprove conditions; bind package goals to prove/disprove when applicable.",
    "### active",
    ...(active.length ? active.map(line) : ["(none)"]),
    "### confirmed (not yet booked unless Store path done)",
    ...(confirmed.length ? confirmed.map(line) : ["(none)"]),
    "### killed",
    ...(killed.length ? killed.map(line) : ["(none)"]),
    "### deferred",
    ...(deferred.length ? deferred.map(line) : ["(none)"]),
    "</hypothesis-queue>",
  ].join("\n");
}

/** Informational book-stage projection: confirmed not yet represented as Store feedback_ok/booked. */
export function formatConfirmedNotSeededProjection(
  hyp: HypothesisStore | undefined | null,
  findingStore: FindingStore | undefined | null,
): string {
  if (!hyp) return "";
  const confirmed = hyp.list({ status: "confirmed" });
  if (!confirmed.length) return "";
  const storeTitles = new Set(
    (findingStore?.snapshot() || []).map((r) => r.title.toLowerCase().slice(0, 80)),
  );
  const pending = confirmed.filter((r) => !storeTitles.has(r.statement.toLowerCase().slice(0, 80)));
  if (!pending.length) return "";
  return [
    "<hypothesis-confirmed-not-seeded>",
    "Informational only — book stage still consumes Finding Store only for L0/completion.",
    ...pending.slice(0, 20).map((r) => `- id=${r.id} ${r.statement.slice(0, 100)}`),
    "Main may hypothesis(seed_store) then complete Store book-path; do not confirm from queue alone.",
    "</hypothesis-confirmed-not-seeded>",
  ].join("\n");
}

/** Promote summary for close-out / Case materials. */
export function buildHypothesisPromoteSummary(
  store: HypothesisStore | undefined | null,
  options?: { maxGists?: number },
): HypothesisPromoteSummary {
  const empty: HypothesisPromoteSummary = {
    active_n: 0,
    confirmed_n: 0,
    killed_n: 0,
    deferred_n: 0,
    gists: [],
  };
  if (!store) return empty;
  const counts = store.counts();
  const max = options?.maxGists ?? 40;
  const gists = store
    .snapshot()
    .slice(0, max)
    .map((r) => ({
      id: r.id,
      status: r.status,
      statement: r.statement.slice(0, 160),
      signal: r.signal.slice(0, 80),
      revisit_if: r.revisit_if?.slice(0, 120),
    }));
  return {
    active_n: counts.active_n,
    confirmed_n: counts.confirmed_n,
    killed_n: counts.killed_n,
    deferred_n: counts.deferred_n,
    gists,
  };
}

/**
 * Copy-in re-seed into a **new** run-local store from promote gists / Delivery.
 * Does not mutate a shared multi-run table.
 */
export function reseedHypothesisQueue(
  target: HypothesisStore,
  gists: HypothesisSeedGist[] | undefined | null,
): { seeded_n: number; ids: string[] } {
  if (!Array.isArray(gists) || !gists.length) return { seeded_n: 0, ids: [] };
  const ids: string[] = [];
  for (const g of gists.slice(0, 80)) {
    const statement = String(g.statement || "").trim();
    if (!statement) continue;
    const status = String(g.status || "active").toLowerCase() as HypothesisStatus;
    const row = target.upsert({
      id: g.id && !target.get(g.id) ? String(g.id) : undefined,
      statement,
      signal: String(g.signal || "reseed").trim() || "reseed",
      prove_if: String(g.prove_if || "prove on re-verify").trim(),
      disprove_if: String(g.disprove_if || "disprove on re-verify").trim(),
      revisit_if: g.revisit_if,
      priority: g.priority,
      payload: g.payload,
    });
    if (status === "confirmed" || status === "killed" || status === "deferred") {
      target.commit({
        id: row.id,
        status,
        revisit_if: g.revisit_if,
      });
    }
    ids.push(row.id);
  }
  return { seeded_n: ids.length, ids };
}

/** True only when stage flag is explicit true (missing/false = off). Authoring SOT. */
export function isHypothesisWorkModeOn(stage: {
  hypothesis_work_mode?: unknown;
}): boolean {
  return stage.hypothesis_work_mode === true;
}

/**
 * Runtime mirror for Main tools: hardGraphRun.hypothesisWorkMode set by stage executor.
 * Single read path — do not re-cast lifecycle elsewhere.
 */
export function isHypothesisRuntimeModeOn(runtime: {
  lifecycle?: { hardGraphRun?: { hypothesisWorkMode?: boolean } };
}): boolean {
  return runtime.lifecycle?.hardGraphRun?.hypothesisWorkMode === true;
}

/**
 * Fail-closed graph load: any stage with hypothesis_work_mode true requires pack availability.
 * Canonical name for load-time gate (also re-exported as validateHypothesisWorkModeForGraph).
 */
export function assertHypothesisModeGraphLoad(input: {
  stages: Array<{ id?: string; hypothesis_work_mode?: unknown }>;
  packHypothesisAvailable: boolean;
}): { ok: true } | { ok: false; error: string } {
  const flagged = input.stages.filter((s) => s.hypothesis_work_mode === true);
  if (!flagged.length) return { ok: true };
  if (!input.packHypothesisAvailable) {
    const ids = flagged.map((s) => s.id || "?").join(", ");
    return {
      ok: false,
      error:
        `hypothesis_work_mode enabled on stage(s) [${ids}] but pack capabilities.hypothesis_work_mode is not true ` +
        `(fail-closed — Spec #274)`,
    };
  }
  return { ok: true };
}
