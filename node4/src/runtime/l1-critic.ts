/**
 * L1 Critic Feedback (Spec #139 D3 / NC-L1).
 * Product state only; cannot bypass L0; bounded stage refine; fail-closed on critic error.
 */

export type L1Decision = "pass" | "refine";

export type L1CriticInput = {
  stageId: string;
  stageSummary?: string;
  surfaceSummary?: { total?: number; open?: number; probed?: number; booked?: number };
  storeSummary?: {
    prior_n?: number;
    feedback_ok_n?: number;
    booked_n?: number;
    reject_n?: number;
    severity_counts?: Record<string, number>;
    sample_titles?: string[];
  };
  packageSummary?: { success_n?: number; failed_n?: number; fanout_n?: number };
  honestyFlags?: string[];
  /** Optional process metrics note (observability only — not a third Feedback tier). */
  observabilityNotes?: string[];
};

export type L1CriticOutput = {
  decision: L1Decision;
  gaps: string[];
  focus_stage?: string;
  focus_prior_ids?: string[];
};

export type L1CriticFn = (input: L1CriticInput) => Promise<L1CriticOutput>;

/** Default max L1-triggered stage refine per stage (NC-L1). Configurable via env. */
export function l1MaxStageRefine(): number {
  const raw = process.env.NODE4_L1_MAX_STAGE_REFINE;
  if (raw == null || raw === "") return 1;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 1;
  return Math.floor(n);
}

/**
 * Minimal heuristic Critic over Product state (no answer keys).
 * Used when no LLM Critic is injected — still fail-closed on empty Product state gaps.
 * Under-severity is refine judgment only (not host auto-score).
 */
export function mechanicalProductStateCritic(input: L1CriticInput): L1CriticOutput {
  const gaps: string[] = [];
  const honesty = input.honestyFlags || [];
  if (honesty.some((h) => /silent.?partial|dishonest|package_honesty/i.test(h))) {
    gaps.push("package honesty / silent-partial flags present — refine packages");
  }
  // Empty feedback_ok with package fanout on probe stages → refine yield (judgment, not quota).
  // Opt-in via env so lab/default mechanical critic does not over-block green CI paths;
  // LLM Critic inject can always decide refine.
  const fanout = input.packageSummary?.fanout_n ?? 0;
  const okN = input.storeSummary?.feedback_ok_n ?? 0;
  const booked = input.storeSummary?.booked_n ?? 0;
  const yieldRefine =
    process.env.NODE4_L1_YIELD_REFINE === "1" || process.env.NODE4_L1_YIELD_REFINE === "true";
  if (
    yieldRefine &&
    fanout >= 3 &&
    okN === 0 &&
    booked === 0 &&
    /probe|component|authz|class/i.test(input.stageId)
  ) {
    gaps.push(
      "probe-like stage had package fanout but zero feedback_ok candidates — refine discovery or record honest deadends",
    );
  }
  // Severity distribution all-medium with high impact titles → under-severity refine (L1 only)
  const sev = input.storeSummary?.severity_counts || {};
  const titles = (input.storeSummary?.sample_titles || []).join(" ").toLowerCase();
  const med = sev.medium || 0;
  const totalSev = Object.values(sev).reduce((a, b) => a + b, 0);
  if (
    totalSev >= 2 &&
    med === totalSev &&
    /(rce|command injection|remote code|credential dump|admin password|unauth)/i.test(titles)
  ) {
    gaps.push(
      "under-severity: high-impact narratives labeled all-medium — re-assign severity (critical/high) with impact proof",
    );
  }
  if (gaps.length) {
    return { decision: "refine", gaps, focus_stage: input.stageId };
  }
  return { decision: "pass", gaps: [] };
}

/**
 * Run L1 after L0 pass. Fail-closed on critic throw/timeout/parse.
 */
export async function runL1Critic(options: {
  input: L1CriticInput;
  critic?: L1CriticFn;
  /** When true, skip L1 (L0 already failed). */
  l0Passed: boolean;
}): Promise<L1CriticOutput> {
  if (!options.l0Passed) {
    return { decision: "refine", gaps: ["L0 failed — L1 not run (cannot bypass L0)"] };
  }
  const fn = options.critic || (async (inp) => mechanicalProductStateCritic(inp));
  try {
    const out = await fn(options.input);
    if (!out || (out.decision !== "pass" && out.decision !== "refine")) {
      return {
        decision: "refine",
        gaps: ["L1 Critic returned invalid decision — fail-closed"],
      };
    }
    return {
      decision: out.decision,
      gaps: Array.isArray(out.gaps) ? out.gaps.map(String) : [],
      focus_stage: out.focus_stage,
      focus_prior_ids: out.focus_prior_ids,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      decision: "refine",
      gaps: [`L1 Critic error (fail-closed): ${msg}`],
    };
  }
}

/** Build L1 input from Product state fragments. */
export function buildL1InputFromProductState(args: {
  stageId: string;
  stageSummary?: string;
  store: {
    counts: () => {
      prior_n: number;
      feedback_ok_n: number;
      booked_n: number;
      reject_n: number;
    };
    snapshot: () => Array<{ title: string; severity?: string; status: string }>;
  };
  fanoutPackagesN?: number;
  packageSuccessN?: number;
  packageFailedN?: number;
  honestyFlags?: string[];
  observabilityNotes?: string[];
  surfaceSummary?: L1CriticInput["surfaceSummary"];
}): L1CriticInput {
  const counts = args.store.counts();
  const snap = args.store.snapshot();
  const severity_counts: Record<string, number> = {};
  for (const r of snap) {
    const s = String(r.severity || "").toLowerCase() || "unset";
    severity_counts[s] = (severity_counts[s] || 0) + 1;
  }
  return {
    stageId: args.stageId,
    stageSummary: args.stageSummary,
    surfaceSummary: args.surfaceSummary,
    storeSummary: {
      prior_n: counts.prior_n,
      feedback_ok_n: counts.feedback_ok_n,
      booked_n: counts.booked_n,
      reject_n: counts.reject_n,
      severity_counts,
      sample_titles: snap.slice(0, 12).map((r) => r.title),
    },
    packageSummary: {
      success_n: args.packageSuccessN,
      failed_n: args.packageFailedN,
      fanout_n: args.fanoutPackagesN,
    },
    honestyFlags: args.honestyFlags,
    observabilityNotes: args.observabilityNotes,
  };
}
