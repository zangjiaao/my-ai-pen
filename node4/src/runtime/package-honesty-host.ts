/**
 * Spec #116 process-quality host: package honesty terminals, attempt budgets,
 * Graph package anchors, and stage honest-partial evaluation.
 * Shared by subagent tool + Hard Graph stage settlement.
 */

import type { ToolRuntime } from "../types.js";
import { FindingStore } from "./finding-store.js";
import {
  MAX_PACKAGE_ATTEMPTS,
  mayRetryPackage,
  recordPackageTerminal,
  type PackageTerminalEntry,
} from "./package-settlement-law.js";

/** Run-wide process-quality state (Store + package honesty + attempt budgets). */
export type ProcessQualityState = {
  findingStore: FindingStore;
  packageTerminals: Record<string, PackageTerminalEntry>;
  packageTerminalAliasIndex: Record<string, string>;
  packageAttemptCounts: Record<string, number>;
};

export function createProcessQualityState(): ProcessQualityState {
  return {
    findingStore: new FindingStore(),
    packageTerminals: {},
    packageTerminalAliasIndex: {},
    packageAttemptCounts: {},
  };
}

/**
 * Ensure lifecycle.processQuality exists and return it.
 * Idempotent; safe to call on parent and stage children (share the same object).
 */
export function ensureProcessQuality(
  lifecycle: ToolRuntime["lifecycle"],
): ProcessQualityState {
  if (!lifecycle.processQuality) {
    lifecycle.processQuality = createProcessQualityState();
  }
  const pq = lifecycle.processQuality;
  if (!pq.findingStore) pq.findingStore = new FindingStore();
  if (!pq.packageTerminals) pq.packageTerminals = {};
  if (!pq.packageTerminalAliasIndex) pq.packageTerminalAliasIndex = {};
  if (!pq.packageAttemptCounts) pq.packageAttemptCounts = {};
  return pq;
}

/**
 * Spec #116 I0.10 — Expert Graph formal packages must anchor an L2 plan_node_id.
 * Free/Default path: still optional (Worker chip binding only).
 */
export function assertGraphPackageAnchor(
  runtime: ToolRuntime,
  pkg: { plan_node_id?: string },
  mode: string,
): string | null {
  const inGraph = Boolean(runtime.lifecycle.hardGraphRun?.plan);
  if (!inGraph) return null;
  if (String(pkg.plan_node_id || "").trim()) return null;
  return (
    `error: ${mode} Graph package requires plan_node_id (L2 anchor); spawn hard-fail ` +
    `(Spec #116 I0.10 — dispatch is ownership of an existing Tasks L2 row).`
  );
}

/** Spec #116 I0.1: package attempt budget per plan_node_id (shared law). */
export function checkPackageAttemptBudget(
  runtime: ToolRuntime,
  planNodeId: string | undefined,
): { ok: true } | { ok: false; error: string } {
  const key = String(planNodeId || "").trim();
  if (!key) return { ok: true };
  const pq = ensureProcessQuality(runtime.lifecycle);
  const used = pq.packageAttemptCounts[key] || 0;
  if (!mayRetryPackage(used)) {
    return {
      ok: false,
      error:
        `error: package plan_node_id=${key} already used ${used} attempt(s) ` +
        `(max ${MAX_PACKAGE_ATTEMPTS} per package — Spec #116 I0.1; not a stage pool).`,
    };
  }
  return { ok: true };
}

/** Spec #116: write one honesty terminal (running | success | failed | aborted | never_started). */
export function markPackageHonesty(
  runtime: ToolRuntime,
  pkg: { plan_node_id?: string; this_turn_goal?: string },
  terminal: "running" | "success" | "failed" | "aborted" | "never_started",
  opts?: { salvaged?: boolean; subagentId?: string },
): void {
  const pq = ensureProcessQuality(runtime.lifecycle);
  const primary =
    String(pkg.plan_node_id || "").trim() ||
    String(opts?.subagentId || "").trim() ||
    String(pkg.this_turn_goal || "").trim();
  if (!primary) return;
  recordPackageTerminal(pq.packageTerminals, pq.packageTerminalAliasIndex, {
    primary_key: primary,
    aliases: [pkg.this_turn_goal, opts?.subagentId, pkg.plan_node_id].filter(
      (x): x is string => Boolean(x && String(x).trim() && String(x).trim() !== primary),
    ),
    terminal,
    salvaged: opts?.salvaged,
    stage_id: runtime.lifecycle.hardGraphRun?.stageId,
  });
}

/** Increment attempt counter for a plan_node_id (I0.1). */
export function bumpPackageAttempt(
  runtime: ToolRuntime,
  planNodeId: string | undefined,
): void {
  const key = String(planNodeId || "").trim();
  if (!key) return;
  const pq = ensureProcessQuality(runtime.lifecycle);
  pq.packageAttemptCounts[key] = (pq.packageAttemptCounts[key] || 0) + 1;
}

/**
 * Exact declare keys only — no fuzzy includes matching.
 * Accepts structured.failed_packages[] or deadends that are exactly the package key
 * or exactly `undeclared_package_fail:<key>` / `failed_package:<key>`.
 * Kept for package-wave tooling / tests; stage Feedback uses host settlement (#125).
 */
export function extractDeclaredFailedKeys(
  packageKeys: Iterable<string>,
  structured?: { deadends?: string[]; failed_packages?: string[] },
): string[] {
  const keys = new Set([...packageKeys].map((k) => String(k).trim()).filter(Boolean));
  const declared = new Set<string>();

  for (const raw of structured?.failed_packages || []) {
    const k = String(raw || "").trim();
    if (keys.has(k)) declared.add(k);
  }

  for (const raw of structured?.deadends || []) {
    const token = String(raw || "").trim();
    if (!token) continue;
    if (keys.has(token)) {
      declared.add(token);
      continue;
    }
    for (const prefix of ["undeclared_package_fail:", "failed_package:"] as const) {
      if (token.startsWith(prefix)) {
        const k = token.slice(prefix.length).trim();
        if (keys.has(k)) declared.add(k);
      }
    }
  }

  return [...declared];
}

// Spec #125: stage Feedback no longer uses agent-declare evaluateStageHonestPartialFromRuntime.
// Host settlement (settleHostStage) owns package declare + stage ok.
