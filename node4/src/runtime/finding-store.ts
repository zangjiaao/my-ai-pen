/**
 * Finding/Candidate Store (Spec #116 FR5 / #112).
 * Store-first product SoT for vuln intelligence; result.json is projection only.
 */

import { pathKey } from "./subagent-booking.js";

export type FindingStatus =
  | "open"
  | "feedback_pending"
  | "feedback_ok"
  | "feedback_reject"
  | "booked"
  | "withdrawn"
  | "superseded";

export type FindingRecord = {
  id: string;
  title: string;
  description?: string;
  severity?: string;
  location: string;
  proof_excerpt?: string;
  poc?: string;
  class_key?: string;
  status: FindingStatus;
  package_id?: string;
  plan_node_id?: string;
  stage_id?: string;
  agent_id?: string;
  platform_vuln_id?: string;
  issues?: string[];
  sources?: string[];
  prior?: boolean;
  created_at: string;
  updated_at: string;
};

export type FindingUpsertInput = {
  id?: string;
  title: string;
  description?: string;
  severity?: string;
  location: string;
  proof_excerpt?: string;
  poc?: string;
  class_key?: string;
  package_id?: string;
  plan_node_id?: string;
  stage_id?: string;
  agent_id?: string;
  platform_vuln_id?: string;
  prior?: boolean;
  source?: string;
};

function nowIso(): string {
  return new Date().toISOString();
}

function slug(s: string): string {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "x";
}

function normalizeTitle(t: string): string {
  return String(t || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Title soft-overlap for L0 when class_key missing (Spec #112 A1). */
export function titlesSoftMatch(a: string, b: string): boolean {
  const x = normalizeTitle(a);
  const y = normalizeTitle(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.includes(y) || y.includes(x)) return true;
  const xs = new Set(x.split(" ").filter((w) => w.length >= 3));
  const ys = new Set(y.split(" ").filter((w) => w.length >= 3));
  if (!xs.size || !ys.size) return false;
  let hit = 0;
  for (const w of xs) if (ys.has(w)) hit++;
  return hit / Math.min(xs.size, ys.size) >= 0.6;
}

export function findingPathKey(location: string): string {
  return pathKey(location);
}

export function newFindingId(input: { location: string; title: string; class_key?: string }): string {
  const pk = findingPathKey(input.location) || "loc";
  const ck = input.class_key ? slug(input.class_key) : slug(input.title);
  return `find-${slug(pk)}-${ck}-${Date.now().toString(36)}`;
}

/**
 * L0 duplicate decision: merge | create (Spec #112).
 * Same path_key + different class_key (both set) → create.
 * Same path_key + same class or title soft-match → merge.
 */
export function shouldMergeFindings(
  existing: Pick<FindingRecord, "location" | "title" | "class_key" | "status">,
  incoming: Pick<FindingUpsertInput, "location" | "title" | "class_key">,
): boolean {
  if (existing.status === "withdrawn" || existing.status === "superseded") return false;
  const ep = findingPathKey(existing.location);
  const ip = findingPathKey(incoming.location);
  if (!ep || !ip || ep !== ip) return false;
  const ec = String(existing.class_key || "").trim().toLowerCase();
  const ic = String(incoming.class_key || "").trim().toLowerCase();
  if (ec && ic && ec !== ic) return false;
  if (ec && ic && ec === ic) return true;
  return titlesSoftMatch(existing.title, incoming.title);
}

export class FindingStore {
  private readonly byId = new Map<string, FindingRecord>();

  snapshot(): FindingRecord[] {
    return [...this.byId.values()].map((r) => ({ ...r }));
  }

  get(id: string): FindingRecord | undefined {
    const r = this.byId.get(String(id || "").trim());
    return r ? { ...r } : undefined;
  }

  clear(): void {
    this.byId.clear();
  }

  /** Count by status (I1 finding family). */
  counts(): {
    open_n: number;
    feedback_pending_n: number;
    feedback_ok_n: number;
    reject_n: number;
    booked_n: number;
    prior_n: number;
  } {
    let open_n = 0;
    let feedback_pending_n = 0;
    let feedback_ok_n = 0;
    let reject_n = 0;
    let booked_n = 0;
    let prior_n = 0;
    for (const r of this.byId.values()) {
      if (r.prior) prior_n++;
      if (r.status === "open") open_n++;
      else if (r.status === "feedback_pending") feedback_pending_n++;
      else if (r.status === "feedback_ok") feedback_ok_n++;
      else if (r.status === "feedback_reject") reject_n++;
      else if (r.status === "booked") booked_n++;
    }
    return { open_n, feedback_pending_n, feedback_ok_n, reject_n, booked_n, prior_n };
  }

  /**
   * Upsert with mandatory L0 merge (I0.17). Returns canonical id.
   */
  upsert(input: FindingUpsertInput): { id: string; merged: boolean; record: FindingRecord } {
    const title = String(input.title || "").trim();
    const location = String(input.location || "").trim();
    if (!title || !location) {
      throw new Error("finding upsert requires title and location");
    }

    const explicitId = String(input.id || "").trim();
    if (explicitId && this.byId.has(explicitId)) {
      return this.updateExisting(explicitId, input, false);
    }

    for (const existing of this.byId.values()) {
      if (shouldMergeFindings(existing, input)) {
        return this.updateExisting(existing.id, input, true);
      }
    }

    const id = explicitId || newFindingId({ location, title, class_key: input.class_key });
    const ts = nowIso();
    const record: FindingRecord = {
      id,
      title,
      description: input.description,
      severity: input.severity,
      location,
      proof_excerpt: input.proof_excerpt,
      poc: input.poc,
      class_key: input.class_key,
      status: "open",
      package_id: input.package_id,
      plan_node_id: input.plan_node_id,
      stage_id: input.stage_id,
      agent_id: input.agent_id,
      platform_vuln_id: input.platform_vuln_id,
      prior: Boolean(input.prior),
      sources: input.source ? [input.source] : [],
      created_at: ts,
      updated_at: ts,
    };
    this.byId.set(id, record);
    return { id, merged: false, record: { ...record } };
  }

  private updateExisting(
    id: string,
    input: FindingUpsertInput,
    merged: boolean,
  ): { id: string; merged: boolean; record: FindingRecord } {
    const cur = this.byId.get(id)!;
    const sources = [...(cur.sources || [])];
    if (input.source && !sources.includes(input.source)) sources.push(input.source);
    if (input.package_id && !sources.includes(`pkg:${input.package_id}`)) {
      sources.push(`pkg:${input.package_id}`);
    }
    const next: FindingRecord = {
      ...cur,
      title: String(input.title || cur.title).trim() || cur.title,
      description: input.description ?? cur.description,
      severity: input.severity ?? cur.severity,
      location: String(input.location || cur.location).trim() || cur.location,
      proof_excerpt: input.proof_excerpt ?? cur.proof_excerpt,
      poc: input.poc ?? cur.poc,
      class_key: input.class_key ?? cur.class_key,
      package_id: input.package_id ?? cur.package_id,
      plan_node_id: input.plan_node_id ?? cur.plan_node_id,
      stage_id: input.stage_id ?? cur.stage_id,
      agent_id: input.agent_id ?? cur.agent_id,
      platform_vuln_id: input.platform_vuln_id ?? cur.platform_vuln_id,
      prior: cur.prior || Boolean(input.prior),
      sources,
      // Reject → open again on re-upsert (U1)
      status: cur.status === "feedback_reject" || cur.status === "feedback_ok" ? "open" : cur.status === "booked" ? "booked" : "open",
      updated_at: nowIso(),
    };
    if (cur.status === "booked") {
      // Keep booked unless explicitly reopened via reject path — do not demote booked on merge
      next.status = "booked";
    }
    this.byId.set(id, next);
    return { id, merged, record: { ...next } };
  }

  /** Auto-enqueue Feedback after package settlement (I0.19). */
  enqueueFeedback(ids?: string[]): FindingRecord[] {
    const out: FindingRecord[] = [];
    const list = ids?.length
      ? ids.map((i) => this.byId.get(i)).filter(Boolean) as FindingRecord[]
      : [...this.byId.values()].filter((r) => r.status === "open");
    for (const r of list) {
      if (r.status !== "open" && r.status !== "feedback_reject") continue;
      const next = { ...r, status: "feedback_pending" as const, updated_at: nowIso() };
      this.byId.set(r.id, next);
      out.push({ ...next });
    }
    return out;
  }

  /**
   * L0 mechanical Feedback (Spec #116): proof_excerpt present → feedback_ok; else reject.
   * Production must call this after enqueue — confirm hard-requires feedback_ok.
   */
  applyMechanicalL0Feedback(ids?: string[]): FindingRecord[] {
    const targets = ids?.length
      ? ids
      : [...this.byId.values()]
          .filter((r) => r.status === "feedback_pending" || r.status === "open")
          .map((r) => r.id);
    const out: FindingRecord[] = [];
    for (const id of targets) {
      const cur = this.byId.get(String(id || "").trim());
      if (!cur) continue;
      if (cur.status === "booked" || cur.status === "feedback_ok") {
        out.push({ ...cur });
        continue;
      }
      if (cur.status === "open") {
        this.enqueueFeedback([cur.id]);
      }
      const hasProof = Boolean(String(cur.proof_excerpt || "").trim());
      const res = this.setFeedbackResult(
        cur.id,
        hasProof ? "ok" : "reject",
        hasProof ? undefined : ["L0: missing proof_excerpt"],
      );
      if (res.ok) out.push(res.record);
    }
    return out;
  }

  setFeedbackResult(
    id: string,
    result: "ok" | "reject",
    issues?: string[],
  ): { ok: true; record: FindingRecord } | { ok: false; error: string } {
    const cur = this.byId.get(String(id || "").trim());
    if (!cur) return { ok: false, error: "finding id not found" };
    if (cur.status === "booked") return { ok: false, error: "already booked" };
    // L0: no proof → cannot be feedback_ok
    if (result === "ok" && !String(cur.proof_excerpt || "").trim()) {
      return { ok: false, error: "feedback_ok requires proof_excerpt" };
    }
    const next: FindingRecord = {
      ...cur,
      status: result === "ok" ? "feedback_ok" : "feedback_reject",
      issues: result === "reject" ? issues || ["rejected"] : undefined,
      updated_at: nowIso(),
    };
    this.byId.set(cur.id, next);
    return { ok: true, record: { ...next } };
  }

  /**
   * Main confirm gate (I0.14–16). Returns error if not allowed.
   */
  assertConfirmAllowed(id: string): { ok: true; record: FindingRecord } | { ok: false; error: string } {
    const raw = String(id || "").trim();
    if (!raw) return { ok: false, error: "confirm requires Store finding id" };
    const cur = this.byId.get(raw);
    if (!cur) return { ok: false, error: "unknown finding id — invent-without-id forbidden" };
    if (cur.status !== "feedback_ok") {
      return { ok: false, error: `confirm only for feedback_ok (status=${cur.status})` };
    }
    if (!String(cur.proof_excerpt || "").trim()) {
      return { ok: false, error: "feedback_ok row missing proof_excerpt" };
    }
    return { ok: true, record: { ...cur } };
  }

  markBooked(id: string, platformVulnId?: string): FindingRecord | undefined {
    const cur = this.byId.get(String(id || "").trim());
    if (!cur) return undefined;
    const next: FindingRecord = {
      ...cur,
      status: "booked",
      platform_vuln_id: platformVulnId || cur.platform_vuln_id,
      updated_at: nowIso(),
    };
    this.byId.set(cur.id, next);
    return { ...next };
  }

  /** Import platform priors (R1) — Scope-related rows. */
  importPriors(
    priors: Array<{
      platform_vuln_id?: string;
      title: string;
      location: string;
      severity?: string;
      description?: string;
      class_key?: string;
    }>,
  ): FindingRecord[] {
    const out: FindingRecord[] = [];
    for (const p of priors) {
      const { record } = this.upsert({
        ...p,
        prior: true,
        source: "platform_prior",
      });
      out.push(record);
    }
    return out;
  }
}

/** Sub must never confirm (I0.13) — role check helper. */
export function actorMayConfirm(role: "main" | "sub" | string): boolean {
  return String(role || "").toLowerCase() === "main";
}

/**
 * Production package→Store path (Spec #116): upsert candidates, enqueue Feedback, L0 mechanical ok/reject.
 * Must be called from subagent settlement — confirm hard-requires feedback_ok afterward.
 */
export function ingestPackageCandidatesToStore(
  store: FindingStore,
  candidates: Array<{
    title?: string;
    location?: string;
    claim?: string;
    proof_excerpt?: string;
    poc_hint?: string;
  }>,
  meta: {
    package_id?: string;
    plan_node_id?: string;
    stage_id?: string;
    agent_id?: string;
    fallback_location?: string;
  },
): string[] {
  const ids: string[] = [];
  for (const c of candidates) {
    if (!c.location && !c.title) continue;
    try {
      const up = store.upsert({
        title: c.title || "candidate",
        location: c.location || meta.fallback_location || "unknown",
        description: c.claim,
        proof_excerpt: c.proof_excerpt,
        poc: c.poc_hint,
        package_id: meta.package_id,
        plan_node_id: meta.plan_node_id,
        stage_id: meta.stage_id,
        agent_id: meta.agent_id,
        source: meta.package_id,
      });
      ids.push(up.id);
    } catch {
      /* skip malformed */
    }
  }
  if (ids.length) {
    store.enqueueFeedback(ids);
    store.applyMechanicalL0Feedback(ids);
  }
  return ids;
}
