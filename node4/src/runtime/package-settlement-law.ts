/**
 * Package wave / settlement product law (Spec #116 FR1 / #108).
 * Pure helpers — runtime and tests share the same definitions.
 */

/** Max attempts per package (1 initial + 1 retry) — not a stage-wide pool. */
export const MAX_PACKAGE_ATTEMPTS = 2;

export type PackageAttemptTerminal =
  | "success"
  | "failed"
  | "aborted"
  | "never_started"
  | "running";

export type PackageAttemptRecord = {
  package_key: string;
  plan_node_id?: string;
  /** Attempts used so far (optional for settlement honesty checks). */
  attempts?: number;
  terminal: PackageAttemptTerminal;
  /** True when leftover settlement/result files were salvaged (evidence only; Spec #493). */
  salvaged?: boolean;
  /** Valid yield or last-turn report present. */
  has_valid_result?: boolean;
};

/**
 * I0.1 — may start another attempt for this package?
 */
export function mayRetryPackage(attemptsUsed: number): boolean {
  return attemptsUsed < MAX_PACKAGE_ATTEMPTS;
}

/**
 * I0.4 (Spec #493) — package success is yield or last-turn report.
 * Salvaged settlement.json / result.json files are evidence only and do not fail the package.
 */
export function isPackageSuccess(input: {
  ok?: boolean;
  salvaged?: boolean;
  has_valid_result?: boolean;
}): boolean {
  void input.salvaged;
  if (input.has_valid_result === false) return false;
  if (input.ok === false) return false;
  if (input.has_valid_result === true) return true;
  return Boolean(input.ok);
}

export type StagePackageSettlementInput = {
  packages: PackageAttemptRecord[];
  /** Failed packages listed on stage result (deadends / failed_packages). */
  declared_failed_keys: string[];
  /** Stage result claims full success / all packages green. */
  claims_full_success?: boolean;
  /** L2 rows marked done for package keys. */
  l2_done_for_keys?: string[];
};

/**
 * I0.2–3 — silent partial forbidden: failed/never_started/aborted/salvage-success
 * must be declared; cannot mark L2 done for unfinished/failed packages.
 */
export function evaluateHonestPartial(input: StagePackageSettlementInput): {
  ok: boolean;
  silent_partial: boolean;
  undeclared_failures: string[];
  illegal_l2_done: string[];
} {
  const declared = new Set(input.declared_failed_keys.map((k) => String(k)));
  const undeclared_failures: string[] = [];
  const illegal_l2_done: string[] = [];
  const l2Done = new Set((input.l2_done_for_keys || []).map((k) => String(k)));

  for (const p of input.packages) {
    const key = String(p.package_key);
    const needsDeclaration =
      p.terminal === "failed" ||
      p.terminal === "never_started" ||
      p.terminal === "aborted" ||
      (p.terminal === "success" && p.salvaged);
    if (needsDeclaration && !declared.has(key)) {
      undeclared_failures.push(key);
    }
    if (
      (p.terminal === "failed" ||
        p.terminal === "running" ||
        p.terminal === "never_started" ||
        p.terminal === "aborted" ||
        (p.terminal === "success" && !isPackageSuccess(p))) &&
      l2Done.has(key)
    ) {
      illegal_l2_done.push(key);
    }
  }

  const silent_partial =
    undeclared_failures.length > 0 ||
    illegal_l2_done.length > 0 ||
    Boolean(input.claims_full_success && undeclared_failures.length > 0);

  // Honest partial: some success some fail is OK if failures declared and no illegal L2 done
  const ok = undeclared_failures.length === 0 && illegal_l2_done.length === 0;
  return { ok, silent_partial: !ok || silent_partial, undeclared_failures, illegal_l2_done };
}

/**
 * I0.5 — after packages started this stage, Main may not serial-erase package failure.
 */
export function mainMaySerialReprobeFailedPackage(input: {
  packagesStartedThisStage: boolean;
  action: "orchestrate_settle" | "serial_reprobe_failed";
}): boolean {
  if (!input.packagesStartedThisStage) return true;
  return input.action === "orchestrate_settle";
}

/** I0.10 — formal Graph package must anchor L2. */
export function requirePlanNodeIdForGraphPackage(planNodeId: string | undefined | null): {
  ok: boolean;
  error?: string;
} {
  if (String(planNodeId || "").trim()) return { ok: true };
  return { ok: false, error: "Graph package requires plan_node_id (L2 anchor); spawn hard-fail" };
}

/** I0.11 — L2 done hard-reject when package not successfully finished. */
export function mayMarkL2DoneForPackage(terminal: PackageAttemptTerminal, salvaged?: boolean): {
  ok: boolean;
  error?: string;
} {
  if (terminal === "running") {
    return { ok: false, error: "cannot done L2 while anchored package still running" };
  }
  if (terminal === "failed" || terminal === "never_started" || terminal === "aborted") {
    return { ok: false, error: `cannot done L2 while package terminal=${terminal}` };
  }
  if (terminal === "success" && salvaged) {
    return { ok: false, error: "cannot done L2 for salvage-only package (not success)" };
  }
  return { ok: true };
}

/**
 * I0.7–8 — classify mid-run control.
 * empty text is not abort; UI interrupt is not package-fail.
 */
export function classifyUserControl(input: {
  kind: "ui_interrupt" | "empty_message" | "steer_text" | "package_fail";
  text?: string;
}): {
  is_package_fail: boolean;
  is_abort: boolean;
  is_steer: boolean;
  reject?: string;
} {
  if (input.kind === "empty_message" || (input.kind === "steer_text" && !String(input.text || "").trim())) {
    return {
      is_package_fail: false,
      is_abort: false,
      is_steer: false,
      reject: "empty message is not abort; ignored",
    };
  }
  if (input.kind === "ui_interrupt") {
    return { is_package_fail: false, is_abort: true, is_steer: false };
  }
  if (input.kind === "package_fail") {
    return { is_package_fail: true, is_abort: false, is_steer: false };
  }
  return { is_package_fail: false, is_abort: false, is_steer: true };
}

/** I0.8 — no auto full-batch replay after interrupt. */
export function shouldAutoReplayBatchAfterInterrupt(): boolean {
  return false;
}

/** L2 progress S1 — numerator is done only. */
export function l2DoneRate(input: { total: number; done: number }): number {
  if (input.total <= 0) return 0;
  return input.done / input.total;
}

/** Honesty map entry — one package, one primary key (plan_node_id on Graph). */
export type PackageTerminalEntry = {
  terminal: PackageAttemptTerminal;
  salvaged?: boolean;
  stage_id?: string;
  /** Primary package key (equals map key when written via recordPackageTerminal). */
  plan_node_id?: string;
};

/**
 * Record exactly one honesty row under primary_key.
 * Aliases go to aliasIndex only — never into the honesty map (Spec #116 package identity).
 */
export function recordPackageTerminal(
  terminals: Record<string, PackageTerminalEntry>,
  aliasIndex: Record<string, string>,
  input: {
    primary_key: string;
    aliases?: string[];
    terminal: PackageAttemptTerminal;
    salvaged?: boolean;
    stage_id?: string;
  },
): string | null {
  const primary = String(input.primary_key || "").trim();
  if (!primary) return null;
  terminals[primary] = {
    terminal: input.terminal,
    salvaged: input.salvaged,
    stage_id: input.stage_id,
    plan_node_id: primary,
  };
  for (const raw of input.aliases || []) {
    const a = String(raw || "").trim();
    if (!a || a === primary) continue;
    aliasIndex[a] = primary;
  }
  return primary;
}

/**
 * Resolve terminal by primary key or exact alias only (L2 done lookup).
 * No substring fuzzy match — short titles like "a" would otherwise hit every key
 * containing the letter "a" and falsely block todo(done).
 */
export function lookupPackageTerminal(
  terminals: Record<string, PackageTerminalEntry>,
  aliasIndex: Record<string, string> | undefined,
  key: string,
): PackageTerminalEntry | undefined {
  const k = String(key || "").trim();
  if (!k) return undefined;
  if (terminals[k]) return terminals[k];
  const primary = aliasIndex?.[k];
  if (primary && terminals[primary]) return terminals[primary];
  return undefined;
}

/**
 * Scope package terminals to one Graph stage for honest-partial evaluation.
 * One record per primary key only — collapses legacy multi-alias map rows.
 * Prior-stage residual failures must not fail later stages (Spec #116).
 */
export function filterPackageTerminalsForStage(
  terminals: Record<string, PackageTerminalEntry>,
  stageId: string,
): PackageAttemptRecord[] {
  const byPrimary = new Map<string, PackageAttemptRecord>();
  for (const [mapKey, v] of Object.entries(terminals)) {
    const sid = v.stage_id;
    if (sid && sid !== stageId) continue;
    // Primary only: map key equals plan_node_id when written correctly;
    // if plan_node_id set and differs from mapKey, this is a legacy alias row — skip.
    const primary = String(v.plan_node_id || mapKey).trim();
    if (v.plan_node_id && mapKey !== v.plan_node_id) continue;
    // Prefer entry whose map key is the primary (drop pure alias keys from honesty)
    if (byPrimary.has(primary) && mapKey !== primary) continue;
    byPrimary.set(primary, {
      package_key: primary,
      plan_node_id: primary,
      terminal: v.terminal,
      salvaged: v.salvaged,
      has_valid_result: v.terminal === "success" && !v.salvaged,
    });
  }
  return [...byPrimary.values()];
}

/**
 * I0.6 — stage max_retries is independent of package attempts.
 * On a **new stage attempt** (retry), reset attempt counters for non-success packages
 * of that stage so failed packages may retry. Successful evidence is kept (terminals
 * with success stay; counters for successes stay at MAX so re-dispatch is blocked).
 */
export function resetPackageAttemptsForStageRetry(
  packageAttemptCounts: Record<string, number>,
  terminals: Record<string, PackageTerminalEntry>,
  stageId: string,
): { reset_keys: string[]; protected_success_keys: string[] } {
  const reset_keys: string[] = [];
  const protected_success_keys: string[] = [];
  const stagePkgs = filterPackageTerminalsForStage(terminals, stageId);
  for (const p of stagePkgs) {
    const key = p.package_key;
    if (p.terminal === "success" && !p.salvaged) {
      // Keep evidence; pin count so accidental re-dispatch hits budget
      packageAttemptCounts[key] = MAX_PACKAGE_ATTEMPTS;
      protected_success_keys.push(key);
      continue;
    }
    if (key in packageAttemptCounts) {
      delete packageAttemptCounts[key];
      reset_keys.push(key);
    }
  }
  return { reset_keys, protected_success_keys };
}

/**
 * I0.21 — Expert Graph coverage SoT is GraphStore only (not TodoStore dual-write merge).
 * Callers use this when choosing which plan_tree projection to emit.
 */
export function graphCoverageSourceOfTruth(
  hasHardGraphPlan: boolean,
): "graph_store" | "todo_store" {
  return hasHardGraphPlan ? "graph_store" : "todo_store";
}
