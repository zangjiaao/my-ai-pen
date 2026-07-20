/**
 * Make "verbatim book from child evidence" the path of least resistance.
 * Multi-package candidate cache + pathname-only matching + booking help hints.
 */

import type { ToolRuntime } from "../types.js";
import type { RecentObservation } from "../tools/common.js";
import type { AcceptanceEvaluation, SubagentCandidate } from "./subagent-result.js";

export type LastSubagentEvidence = {
  subagentId: string;
  nodeType?: string;
  candidates: SubagentCandidate[];
  acceptance?: AcceptanceEvaluation;
  at: number;
};

/** Indexed candidate across packages for stable candidate_index / matching. */
export type CachedCandidate = SubagentCandidate & {
  subagentId: string;
  nodeType?: string;
  /** Index within that package's candidates array */
  packageIndex: number;
  /** Global index in evidence cache (for hints) */
  globalIndex: number;
};

const MAX_CACHED_PACKAGES = 12;
const MAX_CACHED_CANDIDATES = 80;

function norm(s: string): string {
  return String(s || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Pathname-only key: ignore query/hash and normalize %20 vs + encoding noise.
 * /vulnerabilities/sqli/?id=1'... → /vulnerabilities/sqli
 */
export function pathKey(loc: string): string {
  let s = String(loc || "").trim();
  if (!s) return "";
  try {
    // Decode once for %2F etc.; tolerate malformed
    try {
      s = decodeURIComponent(s.replace(/\+/g, "%20"));
    } catch {
      s = s.replace(/\+/g, " ");
    }
    if (/^https?:\/\//i.test(s)) {
      const u = new URL(s);
      let path = u.pathname || "/";
      path = path.replace(/\/+$/, "") || "/";
      return path.toLowerCase();
    }
  } catch {
    /* fall through */
  }
  // strip query/hash
  s = s.split("?")[0]!.split("#")[0]!;
  try {
    s = decodeURIComponent(s.replace(/\+/g, "%20"));
  } catch {
    s = s.replace(/\+/g, " ");
  }
  const m = s.match(/(\/[\w./%-]+)/);
  let path = (m?.[1] || s).replace(/\/+$/, "") || s;
  return path.toLowerCase();
}

export function pathsMatch(a: string, b: string): boolean {
  const x = pathKey(a);
  const y = pathKey(b);
  if (!x || !y) return false;
  if (x === y) return true;
  // prefix: /vulnerabilities/sqli matches longer paths under same module
  if (x.startsWith(y + "/") || y.startsWith(x + "/")) return true;
  // shared module segment e.g. both contain /vulnerabilities/sqli
  const segs = (p: string) => p.split("/").filter(Boolean);
  const xs = segs(x);
  const ys = segs(y);
  if (xs.length >= 2 && ys.length >= 2) {
    // last two segments equal
    if (xs.slice(-2).join("/") === ys.slice(-2).join("/")) return true;
  }
  return false;
}

function titleLooseMatch(a: string, b: string): boolean {
  const x = norm(a).replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ");
  const y = norm(b).replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ");
  if (!x || !y) return false;
  if (x.includes(y) || y.includes(x)) return true;
  const xs = new Set(x.split(" ").filter((t) => t.length >= 3));
  const ys = y.split(" ").filter((t) => t.length >= 3);
  let hit = 0;
  for (const t of ys) if (xs.has(t)) hit += 1;
  return hit >= 2;
}

function rebuildGlobalIndex(runtime: ToolRuntime): CachedCandidate[] {
  const packages = runtime.lifecycle.subagentEvidenceCache || [];
  const out: CachedCandidate[] = [];
  let g = 0;
  for (const pack of packages) {
    (pack.candidates || []).forEach((c, packageIndex) => {
      if (String(c.proof_excerpt || "").trim().length < 24) return;
      out.push({
        ...c,
        subagentId: pack.subagentId,
        nodeType: pack.nodeType,
        packageIndex,
        globalIndex: g++,
      });
    });
  }
  runtime.lifecycle.subagentCandidateIndex = out;
  return out;
}

function collectCandidates(runtime: ToolRuntime): CachedCandidate[] {
  if (runtime.lifecycle.subagentCandidateIndex?.length) {
    return runtime.lifecycle.subagentCandidateIndex;
  }
  return rebuildGlobalIndex(runtime);
}

export type BookingMaterial = {
  proof: string;
  poc: string;
  source: "agent" | "candidate" | "mixed";
  candidate_index?: number;
  package_index?: number;
  subagent_id?: string;
  note?: string;
};

/**
 * Resolve proof/poc for finding(confirm) so Main can book without paraphrasing.
 *
 * Priority:
 * 1. explicit candidate_index into **global** multi-package cache
 * 2. pathname match (query-insensitive)
 * 3. title loose match
 * 4. single ready_to_book from last package
 */
export function resolveBookingMaterialFromSubagentEvidence(
  runtime: ToolRuntime,
  input: {
    title: string;
    location: string;
    proof?: string;
    poc?: string;
    candidate_index?: number;
  },
): BookingMaterial | null {
  const agentProof = String(input.proof || "").trim();
  const agentPoc = String(input.poc || "").trim();
  const last = runtime.lifecycle.lastSubagentEvidence;
  const ready = last?.acceptance?.ready_to_book || [];
  const candidates = collectCandidates(runtime);
  if (!candidates.length && !ready.length) return null;

  let picked: CachedCandidate | SubagentCandidate | null = null;
  let pickedGlobal: number | undefined;
  let pickedPackage: number | undefined;
  let pickedSub: string | undefined;

  if (typeof input.candidate_index === "number" && Number.isFinite(input.candidate_index)) {
    const idx = Math.floor(input.candidate_index);
    // Prefer global cache index
    const byGlobal = candidates.find((c) => c.globalIndex === idx) || candidates[idx];
    if (byGlobal) {
      picked = byGlobal;
      pickedGlobal = byGlobal.globalIndex;
      pickedPackage = byGlobal.packageIndex;
      pickedSub = byGlobal.subagentId;
    } else if (last?.candidates?.[idx]) {
      picked = last.candidates[idx]!;
      pickedPackage = idx;
      pickedSub = last.subagentId;
    }
  }

  if (!picked && input.location) {
    for (const c of candidates) {
      if (pathsMatch(input.location, c.location || "")) {
        picked = c;
        pickedGlobal = c.globalIndex;
        pickedPackage = c.packageIndex;
        pickedSub = c.subagentId;
        break;
      }
    }
  }

  if (!picked && input.title) {
    for (const c of candidates) {
      if (titleLooseMatch(input.title, c.title || c.claim || "")) {
        picked = c;
        pickedGlobal = c.globalIndex;
        pickedPackage = c.packageIndex;
        pickedSub = c.subagentId;
        break;
      }
    }
  }

  if (!picked && ready.length === 1) {
    const r = ready[0]!;
    picked = {
      title: r.title,
      location: r.location,
      proof_excerpt: r.proof_excerpt,
      poc_hint: r.poc_hint,
    };
    pickedPackage = r.index;
    pickedSub = last?.subagentId;
  }

  if (!picked) return null;

  const candProof = String(picked.proof_excerpt || "").trim();
  const candPoc = String(picked.poc_hint || "").trim();
  if (candProof.length < 24) return null;

  const proof = candProof;
  const poc = agentPoc.length >= 40 ? agentPoc : candPoc || agentPoc;
  const source: BookingMaterial["source"] =
    agentProof && agentProof !== candProof ? "mixed" : "candidate";

  return {
    proof,
    poc,
    source,
    candidate_index: pickedGlobal ?? pickedPackage,
    package_index: pickedPackage,
    subagent_id: pickedSub,
    note: `proof filled from subagent${pickedSub ? ` ${pickedSub}` : ""} candidate${
      pickedGlobal != null ? ` global#${pickedGlobal}` : pickedPackage != null ? ` #${pickedPackage}` : ""
    } (verbatim proof_excerpt)`,
  };
}

export function fallbackProofFromInjectedCandidates(
  runtime: ToolRuntime,
  input: { title: string; location: string },
): { proof: string; poc: string; note: string } | null {
  const material = resolveBookingMaterialFromSubagentEvidence(runtime, {
    title: input.title,
    location: input.location,
  });
  if (!material) return null;
  return {
    proof: material.proof,
    poc: material.poc,
    note: material.note || "fallback verbatim candidate proof",
  };
}

/**
 * Short hint for finding errors: list ready candidates so Main can pass candidate_index / location.
 */
export function formatBookingHelpHint(runtime: ToolRuntime, limit = 5): string {
  const list = collectCandidates(runtime);
  if (!list.length) {
    const last = runtime.lifecycle.lastSubagentEvidence;
    if (last?.acceptance?.needs_more_evidence?.length) {
      return (
        " — no ready candidates in cache; last package needs_more_evidence — re-dispatch with gaps, do not invent proof"
      );
    }
    return " — no subagent candidates cached; re-dispatch LLM child (no command=) requiring candidates[].proof_excerpt";
  }
  const lines = list.slice(0, limit).map((c) => {
    const loc = pathKey(c.location || "") || "(no path)";
    const title = String(c.title || c.claim || "?").slice(0, 40);
    const pe = String(c.proof_excerpt || "").slice(0, 48).replace(/\s+/g, " ");
    return `  [${c.globalIndex}] ${loc} | ${title} | proof≈"${pe}…"`;
  });
  return (
    ` — try candidate_index=N or location matching path below:\n` + lines.join("\n")
  );
}

export function rememberSubagentEvidence(
  runtime: ToolRuntime,
  pack: LastSubagentEvidence,
): void {
  runtime.lifecycle.lastSubagentEvidence = {
    ...pack,
    at: pack.at || Date.now(),
  };
  // Multi-package cache: append; drop empty-candidate shell noise unless it is the only pack
  const cache = (runtime.lifecycle.subagentEvidenceCache ||= []);
  if (pack.candidates?.length) {
    cache.push({
      ...pack,
      at: pack.at || Date.now(),
    });
    while (cache.length > MAX_CACHED_PACKAGES) cache.shift();
    // cap total candidates
    rebuildGlobalIndex(runtime);
    while ((runtime.lifecycle.subagentCandidateIndex || []).length > MAX_CACHED_CANDIDATES) {
      cache.shift();
      rebuildGlobalIndex(runtime);
    }
  } else {
    // still refresh index from existing cache (do not wipe on empty shell package)
    rebuildGlobalIndex(runtime);
  }
}

/** Test helper */
export function candidatesFromObservations(recent: RecentObservation[] | undefined): SubagentCandidate[] {
  const runtime = {
    lifecycle: {
      recentObservations: recent,
      lastSubagentEvidence: undefined,
      subagentEvidenceCache: [],
      subagentCandidateIndex: [],
    },
  } as unknown as ToolRuntime;
  // parse from observations into a synthetic cache
  const packs: LastSubagentEvidence[] = [];
  for (const r of recent || []) {
    if (String(r.sourceTool || "") !== "subagent") continue;
    const ex = String(r.excerpt || "");
    if (!ex.includes("proof=")) continue;
    const title = (ex.match(/title=([^\n]+)/)?.[1] || "").trim();
    const location = (ex.match(/location=([^\n]+)/)?.[1] || "").trim();
    const proof = (ex.match(/proof=([\s\S]+?)(?:\npoc=|\n---|\Z)/)?.[1] || "").trim();
    const poc = (ex.match(/poc=([\s\S]+?)(?:\n---|\Z)/)?.[1] || "").trim();
    if (proof.length < 24) continue;
    packs.push({
      subagentId: "obs",
      candidates: [{ title, location, proof_excerpt: proof, poc_hint: poc }],
      at: Date.now(),
    });
  }
  runtime.lifecycle.subagentEvidenceCache = packs;
  return rebuildGlobalIndex(runtime);
}
