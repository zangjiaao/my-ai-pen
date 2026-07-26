/**
 * Graph-start prior seed + dual-use helpers (Spec #139 D2 / NC-Prior).
 * Host seeds Scope open findings into Finding Store (prior=true, no bookable proof).
 */

import type { FindingRecord, FindingStore } from "./finding-store.js";
import { findingPathKey } from "./finding-store.js";
import type { CaseContext, CaseFindingLine } from "./case-context.js";

export type PriorSeedResult = {
  prior_n: number;
  empty_prior: boolean;
  ids: string[];
  /** Compact snapshot for Hard Graph stage prompts. */
  snapshot: Array<{
    id: string;
    title: string;
    location: string;
    severity?: string;
    class_key?: string;
    platform_vuln_id?: string;
    pathKey: string;
  }>;
};

function normalizeTitleStem(title: string): string {
  return String(title || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

/** Class unit for pathKey∩class avoid (NC-Prior). */
export function priorClassKey(row: {
  class_key?: string;
  title?: string;
}): string {
  const ck = String(row.class_key || "")
    .trim()
    .toLowerCase();
  if (ck) return ck;
  return normalizeTitleStem(row.title || "") || "unknown";
}

/** Avoid unit pathKey ∩ class. */
export function priorAvoidUnit(location: string, classOrTitle: { class_key?: string; title?: string }): string {
  const pk = findingPathKey(location) || "loc";
  return `${pk}∩${priorClassKey(classOrTitle)}`;
}

/**
 * Map case_context / platform findings_summary open rows into importPriors inputs.
 * Strips proof; preserves severity/title/location.
 */
export function openFindingsToPriorInputs(
  findings: CaseFindingLine[] | undefined | null,
): Array<{
  platform_vuln_id?: string;
  title: string;
  location: string;
  severity?: string;
  description?: string;
  class_key?: string;
}> {
  if (!Array.isArray(findings) || !findings.length) return [];
  const out: Array<{
    platform_vuln_id?: string;
    title: string;
    location: string;
    severity?: string;
    description?: string;
    class_key?: string;
  }> = [];
  for (const f of findings) {
    const title = String(f.title || "").trim();
    const location = String(f.location || f.url || "").trim();
    if (!title || !location) continue;
    const status = String(f.status || "open").toLowerCase();
    // Only open/unfixed-style statuses — skip fixed/false_positive when present
    if (status === "fixed" || status === "false_positive" || status === "closed") continue;
    out.push({
      platform_vuln_id: f.id ? String(f.id) : undefined,
      title,
      location,
      severity: f.severity ? String(f.severity) : undefined,
      description: f.description ? String(f.description) : undefined,
    });
  }
  return out;
}

/**
 * Host graph-start seed: import open Scope findings into Store as priors.
 */
export function seedPriorsAtGraphStart(
  store: FindingStore,
  caseContext: CaseContext | undefined | null,
): PriorSeedResult {
  const inputs = openFindingsToPriorInputs(caseContext?.findings_summary);
  const records = store.importPriors(inputs);
  const snapshot = records.map((r) => ({
    id: r.id,
    title: r.title,
    location: r.location,
    severity: r.severity,
    class_key: r.class_key,
    platform_vuln_id: r.platform_vuln_id,
    pathKey: findingPathKey(r.location),
  }));
  return {
    prior_n: records.length,
    empty_prior: records.length === 0,
    ids: records.map((r) => r.id),
    snapshot,
  };
}

/** Format prior snapshot for Hard Graph stage system/user prompts. */
export function formatPriorSnapshotInjection(seed: PriorSeedResult | undefined | null): string {
  if (!seed) return "";
  if (seed.empty_prior || seed.prior_n === 0) {
    return [
      "<prior-finding-store>",
      "empty_prior: true",
      "No open Scope findings were seeded into Finding Store. Do not invent retest work from memory.",
      "Discovery packages proceed without prior path∩class avoid constraints from ledger priors.",
      "</prior-finding-store>",
    ].join("\n");
  }
  const lines = seed.snapshot.slice(0, 40).map((p) => {
    const sev = p.severity || "?";
    const ck = p.class_key || priorClassKey(p);
    return `- id=${p.id} sev=${sev} class=${ck} pathKey=${p.pathKey} loc=${p.location} title=${p.title.slice(0, 80)}`;
  });
  return [
    "<prior-finding-store>",
    `empty_prior: false`,
    `prior_n: ${seed.prior_n}`,
    "Dual use:",
    "1) Schedule re-verify packages with prior Store id(s) + this-run fresh proof (historical proof stripped).",
    "2) Discovery packages must not target prior pathKey∩class — host hard-fails spawn on collision.",
    "Priors are not a whole-class skip list: other paths, other classes on same path, new roles remain in scope.",
    "Prior rows:",
    ...lines,
    "</prior-finding-store>",
  ].join("\n");
}

/**
 * Host hard-fail for discovery package spawn when target collides with prior/booked path∩class.
 * Re-verify packages (explicit prior Store ids) are allowed through.
 */
export function checkDiscoveryAvoidCollision(input: {
  store: FindingStore;
  targetLocation: string;
  title?: string;
  class_key?: string;
  /** When set, package is re-verify and may hit prior paths. */
  priorStoreIds?: string[];
  packageKind?: "discovery" | "re-verify" | string;
}): { ok: true } | { ok: false; error: string } {
  const kind = String(input.packageKind || "").toLowerCase();
  const priorIds = (input.priorStoreIds || []).map((x) => String(x || "").trim()).filter(Boolean);
  if (kind === "re-verify" || priorIds.length > 0) {
    return { ok: true };
  }
  const unit = priorAvoidUnit(input.targetLocation, {
    class_key: input.class_key,
    title: input.title,
  });
  for (const r of input.store.snapshot()) {
    if (!r.prior && r.status !== "booked" && r.status !== "feedback_ok") continue;
    const existing = priorAvoidUnit(r.location, r);
    if (existing === unit) {
      return {
        ok: false,
        error:
          `discovery package targets prior/booked pathKey∩class (${unit}). ` +
          `Use a re-verify package with prior Store id=${r.id}, or change target path/class. ` +
          `(Spec #139 NC-Prior host hard-fail)`,
      };
    }
  }
  return { ok: true };
}

/** List prior avoid units for package handoff already_done. */
export function listPriorAvoidUnits(store: FindingStore): string[] {
  const out: string[] = [];
  for (const r of store.snapshot()) {
    if (!r.prior && r.status !== "booked") continue;
    out.push(priorAvoidUnit(r.location, r));
  }
  return [...new Set(out)].slice(0, 80);
}

export function priorRows(store: FindingStore): FindingRecord[] {
  return store.snapshot().filter((r) => r.prior);
}

/**
 * Package spawn policy for NC-Prior dual-use:
 * inject prior pathKey∩class into already_done; host hard-fail discovery collision.
 * Mutates pkg.already_done in place when inject applies.
 */
export function applyPriorAvoidOnPackage(
  store: FindingStore,
  pkg: {
    target: string;
    already_done: string;
    this_turn_goal?: string;
    title?: string;
    class_key?: string;
    prior_finding_ids?: string[];
    package_kind?: string;
  },
): { ok: true } | { ok: false; error: string } {
  const avoidUnits = listPriorAvoidUnits(store);
  if (avoidUnits.length && !/prior pathKey|pathKey∩class/i.test(pkg.already_done)) {
    pkg.already_done =
      `${pkg.already_done}\n\n## Prior pathKey∩class (do not rediscover)\n` +
      avoidUnits.map((u) => `- ${u}`).join("\n");
  }
  // Re-verify without ids is incomplete dual-use surface
  const kind = String(pkg.package_kind || "").toLowerCase();
  if (kind === "re-verify") {
    const ids = (pkg.prior_finding_ids || []).map((x) => String(x || "").trim()).filter(Boolean);
    if (!ids.length) {
      return {
        ok: false,
        error:
          "re-verify package requires prior_finding_ids (Store id(s)) — dual-use re-verify surface (Spec #139 NC-Prior)",
      };
    }
  }
  return checkDiscoveryAvoidCollision({
    store,
    targetLocation: pkg.target,
    title: pkg.title || pkg.this_turn_goal,
    class_key: pkg.class_key,
    priorStoreIds: pkg.prior_finding_ids,
    packageKind: pkg.package_kind,
  });
}
