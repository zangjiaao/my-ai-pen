/**
 * Structured return contract for subagent work packages.
 * Main books findings; child returns candidates/facts/deadends.
 */

export type SubagentCandidate = {
  title?: string;
  location?: string;
  claim?: string;
  proof_excerpt?: string;
  poc_hint?: string;
};

/** Attack surface inventory item from recon (live recon only — no invented modules). */
export type SubagentSurface = {
  location: string;
  kind?: string;
  params?: string[];
  auth?: string;
  note?: string;
};

export type SubagentFactNote = {
  key?: string;
  summary: string;
};

export type SubagentStructuredResult = {
  ok: boolean;
  summary: string;
  candidates: SubagentCandidate[];
  /** Concrete entrypoints from recon (required for node_type=surface). */
  surfaces: SubagentSurface[];
  facts: SubagentFactNote[];
  deadends: string[];
  artifacts: string[];
  /** Optional free-form notes from the child. */
  notes?: string;
  raw?: unknown;
};

function asString(v: unknown, max = 4000): string {
  return String(v ?? "")
    .trim()
    .slice(0, max);
}

function asStringList(v: unknown, maxItems = 40): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => asString(x, 1000))
    .filter(Boolean)
    .slice(0, maxItems);
}

function asCandidates(v: unknown): SubagentCandidate[] {
  if (!Array.isArray(v)) return [];
  const out: SubagentCandidate[] = [];
  for (const item of v.slice(0, 40)) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const c: SubagentCandidate = {
      title: asString(o.title, 200) || undefined,
      location: asString(o.location ?? o.url, 500) || undefined,
      claim: asString(o.claim ?? o.description, 2000) || undefined,
      proof_excerpt: asString(o.proof_excerpt ?? o.proof, 4000) || undefined,
      poc_hint: asString(o.poc_hint ?? o.poc, 2000) || undefined,
    };
    if (c.title || c.location || c.claim || c.proof_excerpt) out.push(c);
  }
  return out;
}

function asSurfaces(v: unknown): SubagentSurface[] {
  if (!Array.isArray(v)) return [];
  const out: SubagentSurface[] = [];
  for (const item of v.slice(0, 80)) {
    if (typeof item === "string") {
      const location = asString(item, 500);
      if (location.length >= 2) out.push({ location });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const location = asString(o.location ?? o.url ?? o.path, 500);
    if (location.length < 2) continue;
    const params = Array.isArray(o.params)
      ? o.params
          .map((x) => asString(x, 80))
          .filter(Boolean)
          .slice(0, 40)
      : undefined;
    out.push({
      location,
      kind: asString(o.kind ?? o.type, 64) || undefined,
      params: params?.length ? params : undefined,
      auth: asString(o.auth, 64) || undefined,
      note: asString(o.note ?? o.summary, 500) || undefined,
    });
  }
  return out;
}

function asFacts(v: unknown): SubagentFactNote[] {
  if (!Array.isArray(v)) return [];
  const out: SubagentFactNote[] = [];
  for (const item of v.slice(0, 40)) {
    if (typeof item === "string") {
      const s = asString(item, 1000);
      if (s) out.push({ summary: s });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const summary = asString(o.summary ?? o.value ?? o.note, 1000);
    if (!summary) continue;
    out.push({
      key: asString(o.key, 120) || undefined,
      summary,
    });
  }
  return out;
}

/**
 * Normalize arbitrary JSON (from child write or host synthesis) into the contract.
 * Merges nested `data` and `structured` so top-level candidates are never lost.
 */
export function normalizeSubagentResult(input: unknown, fallbackSummary = ""): SubagentStructuredResult {
  const base =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};

  // Allow nested { data: { ...contract } }
  let body: Record<string, unknown> =
    base.data && typeof base.data === "object" && !Array.isArray(base.data)
      ? { ...base, ...(base.data as Record<string, unknown>) }
      : { ...base };

  // Nested structured (common from llm_session payload): prefer its candidates/facts
  const nestedStructured =
    (body.structured && typeof body.structured === "object" && !Array.isArray(body.structured)
      ? (body.structured as Record<string, unknown>)
      : null) ||
    (base.structured && typeof base.structured === "object" && !Array.isArray(base.structured)
      ? (base.structured as Record<string, unknown>)
      : null);
  const topCandidates = asCandidates(body.candidates);
  const nestedCandidates = nestedStructured ? asCandidates(nestedStructured.candidates) : [];
  const topSurfaces = asSurfaces(body.surfaces);
  const nestedSurfaces = nestedStructured ? asSurfaces(nestedStructured.surfaces) : [];
  const topFacts = asFacts(body.facts);
  const nestedFacts = nestedStructured ? asFacts(nestedStructured.facts) : [];

  const summary =
    asString(body.summary, 2000) ||
    asString(nestedStructured?.summary, 2000) ||
    asString(fallbackSummary, 2000) ||
    "subagent finished";

  const okRaw = typeof body.ok === "boolean" ? body.ok : nestedStructured?.ok;
  const ok =
    typeof okRaw === "boolean" ? okRaw : !/fail|error|abort/i.test(summary.slice(0, 80));

  return {
    ok,
    summary,
    // Prefer non-empty candidate lists (nested structured often holds the real list)
    candidates: topCandidates.length ? topCandidates : nestedCandidates,
    surfaces: topSurfaces.length ? topSurfaces : nestedSurfaces,
    facts: topFacts.length ? topFacts : nestedFacts,
    deadends: asStringList(
      (Array.isArray(body.deadends) && body.deadends.length
        ? body.deadends
        : nestedStructured?.deadends) ?? [],
    ),
    artifacts: asStringList(
      (Array.isArray(body.artifacts) && body.artifacts.length
        ? body.artifacts
        : nestedStructured?.artifacts) ?? [],
    ),
    notes: asString(body.notes ?? nestedStructured?.notes, 4000) || undefined,
    raw: input,
  };
}

export type AcceptanceReadyItem = {
  index: number;
  title: string;
  location?: string;
  reason: string;
  /** Verbatim proof_excerpt Main should paste into finding(confirm) proof= */
  proof_excerpt: string;
  /** poc_hint for finding poc= */
  poc_hint?: string;
};

export type AcceptanceGapItem = {
  index: number;
  title: string;
  gaps: string[];
  /** Hint text to put into re-dispatch this_turn_goal / already_done */
  redispatch_hint: string;
};

export type AcceptanceEvaluation = {
  ready_to_book: AcceptanceReadyItem[];
  needs_more_evidence: AcceptanceGapItem[];
  /** Package-level note when there are zero candidates */
  package_gaps: string[];
  hint: string;
  /** Surfaces accepted from this package (recon inventory). */
  surfaces_accepted?: number;
  /** Optional open-ledger preview after merge (filled by parent tool). */
  surface_open_hint?: string;
  /** Optional ledger summary object (filled by parent tool). */
  surface_ledger?: Record<string, unknown>;
};

const RESULT_SIGNAL_RE =
  /observ|status|response|error|uid=|password|syntax|flag\{|sql|xss|upload|passwd|www-data|alert\(|success|fail|inject|cookie|session/i;
const STEP_SIGNAL_RE =
  /get |post |curl |payload|param|request|step|inject|send |visit |set |login|→|->|then /i;

/**
 * Light assistive judgment for Main (not a settlement gate).
 * Ready = location + proof_excerpt long enough + poc_hint covers steps and observed result.
 */
export function evaluateCandidatesForAcceptance(
  candidates: SubagentCandidate[],
  options?: {
    usedCommandOnly?: boolean;
    nodeType?: string;
    surfaces?: SubagentSurface[];
  },
): AcceptanceEvaluation {
  const ready_to_book: AcceptanceReadyItem[] = [];
  const needs_more_evidence: AcceptanceGapItem[] = [];
  const package_gaps: string[] = [];
  const surfaces = options?.surfaces ?? [];
  const nodeType = String(options?.nodeType || "")
    .trim()
    .toLowerCase();
  const surfaces_accepted = surfaces.length;

  if (options?.usedCommandOnly) {
    package_gaps.push(
      "command= shell package has no LLM evidence contract — prefer LLM child for vuln claims; re-dispatch without command=",
    );
  }

  // Surface/recon packages must return structured surfaces[] from live recon.
  if ((nodeType === "surface" || nodeType === "recon") && surfaces.length === 0) {
    package_gaps.push(
      "node_type=surface returned no surfaces[] — re-dispatch requiring surfaces with concrete location (URL/path) from live recon (menu/forms/APIs you observed). Do not invent modules.",
    );
  }

  if (!candidates.length) {
    if (!options?.usedCommandOnly) {
      // Surface-only packages may legitimately have zero vuln candidates.
      if (!(nodeType === "surface" || nodeType === "recon") || surfaces.length === 0) {
        if (!(nodeType === "surface" || nodeType === "recon")) {
          package_gaps.push(
            "no candidates[] — if vulns claimed, re-dispatch requiring candidates with proof_excerpt",
          );
        }
      }
    }
    const hintParts = [
      "No ready_to_book candidates.",
      surfaces_accepted
        ? `Recorded ${surfaces_accepted} surface(s) into the work queue — dispatch class_probe (etc.) on open paths.`
        : "If the package claimed issues: re-dispatch with success_criteria requiring candidates[].proof_excerpt + poc_hint.",
      "Do not invent proof files. Do not re-probe on Main when Graph hard.",
    ];
    if (package_gaps.length) hintParts.push(`Package: ${package_gaps.join("; ")}`);
    return {
      ready_to_book,
      needs_more_evidence,
      package_gaps,
      surfaces_accepted,
      hint: hintParts.join(" "),
    };
  }

  candidates.forEach((c, index) => {
    const title = String(c.title || c.claim || `candidate_${index}`).slice(0, 200);
    const location = String(c.location || "").trim();
    const proof = String(c.proof_excerpt || "").trim();
    const poc = String(c.poc_hint || "").trim();
    const gaps: string[] = [];

    if (!location || location.length < 3) gaps.push("missing location (URL or path)");
    if (proof.length < 24) gaps.push("proof_excerpt short or missing (need ≥24 chars tool quote)");
    if (poc.length < 40) {
      gaps.push("poc_hint too short (need steps AND observed result)");
    } else {
      const hasStep = STEP_SIGNAL_RE.test(poc) || /['"`]/.test(poc);
      const hasResult = RESULT_SIGNAL_RE.test(poc);
      if (!hasStep) gaps.push("poc_hint missing reproduce steps");
      if (!hasResult) gaps.push("poc_hint missing observed result");
    }

    if (!gaps.length) {
      ready_to_book.push({
        index,
        title,
        location,
        reason: "location + proof_excerpt + poc_hint (steps+result)",
        proof_excerpt: proof,
        poc_hint: poc,
      });
    } else {
      needs_more_evidence.push({
        index,
        title,
        gaps,
        redispatch_hint: `Fill gaps for "${title}": ${gaps.join("; ")}. Return updated candidates with verbatim tool quotes.`,
      });
    }
  });

  const hintParts = [
    "Acceptance loop: (1) finding(confirm) each ready_to_book with proof= VERBATIM proof_excerpt and poc= poc_hint.",
    "(2) For needs_more_evidence: re-dispatch subagent with already_done + this_turn_goal = redispatch_hint; max 2 gap retries then deadend.",
    "(3) Never write synthetic *proof*.txt files; never paraphrase proof.",
    "(4) Open surfaces in the ledger are the work queue — todo(done) cannot green without act/deadend/skip.",
  ];
  if (surfaces_accepted) {
    hintParts.push(`This package contributed ${surfaces_accepted} surface(s).`);
  }
  if (package_gaps.length) hintParts.push(`Package: ${package_gaps.join("; ")}`);

  return {
    ready_to_book,
    needs_more_evidence,
    package_gaps,
    surfaces_accepted,
    hint: hintParts.join(" "),
  };
}

/** Build a single stdout-like blob for parent recentObservations (booking proof ground). */
export function buildParentObservationBlob(structured: SubagentStructuredResult): string {
  const parts: string[] = [];
  if (structured.summary) parts.push(structured.summary);
  for (const c of structured.candidates.slice(0, 12)) {
    const bits = [
      c.title ? `title=${c.title}` : "",
      c.location ? `location=${c.location}` : "",
      c.claim ? `claim=${c.claim}` : "",
      c.proof_excerpt ? `proof=${c.proof_excerpt}` : "",
      c.poc_hint ? `poc=${c.poc_hint}` : "",
    ].filter(Boolean);
    if (bits.length) parts.push(bits.join("\n"));
  }
  for (const s of structured.surfaces.slice(0, 20)) {
    parts.push(
      [
        `surface=${s.location}`,
        s.kind ? `kind=${s.kind}` : "",
        s.params?.length ? `params=${s.params.join(",")}` : "",
      ]
        .filter(Boolean)
        .join(" "),
    );
  }
  for (const f of structured.facts.slice(0, 8)) {
    parts.push(f.key ? `${f.key}: ${f.summary}` : f.summary);
  }
  if (structured.notes) parts.push(structured.notes);
  return parts.join("\n\n---\n\n").slice(0, 48_000);
}

/** Instructions embedded in the child worker prompt (childRolePack already bans nested sub / finding book). */
export function formatSubagentReturnContractPrompt(): string {
  return [
    "## Return contract (required before stop)",
    "Write `./result.json` when this_turn_goal is done or blocked:",
    "```json",
    '{',
    '  "ok": true,',
    '  "summary": "one paragraph",',
    '  "surfaces": [{ "location": "URL/path YOU observed", "kind": "form|api|upload|page|other", "params": ["id"], "auth": "none|session|basic" }],',
    '  "candidates": [{ "title": "...", "location": "URL/path", "claim": "impact", "proof_excerpt": "VERBATIM tool quote (~32+ chars)", "poc_hint": "steps + observed result" }],',
    '  "facts": [{ "key": "optional", "summary": "cognition" }],',
    '  "deadends": ["vector exhausted because ..."],',
    '  "artifacts": ["relative paths"]',
    "}",
    "```",
    "- Surface/recon: `surfaces` from **live** recon only — never invent modules.",
    "- Any vuln claim → non-empty `candidates` with `location` + real `proof_excerpt` (not paraphrase-only).",
    "- `poc_hint`: reproduce steps AND observed result. Parent books via finding(confirm) from your proof_excerpt — no re-probe.",
    "- Mandatory `./result.json` before stop (else salvage). Prefer session/http; re-login only if seeded cookies fail.",
  ].join("\n");
}
