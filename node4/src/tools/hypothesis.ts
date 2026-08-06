/**
 * Main hypothesis queue tools (Spec #274).
 * Main-only commits; Sub must not call (subagentDepth >= 1 rejected).
 */

import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolRuntime } from "../types.js";
import { jsonResult, textResult } from "./common.js";
import { ensureProcessQuality } from "../runtime/package-honesty-host.js";
import {
  isHypothesisRuntimeModeOn,
  parseHypothesisPackageOutcomes,
  suggestedCommitFromPackageOutcome,
  type HypothesisStatus,
} from "../runtime/hypothesis-store.js";

function requireMain(runtime: ToolRuntime): string | null {
  if ((runtime.lifecycle.subagentDepth || 0) >= 1) {
    return "error: subagent must not mutate hypothesis queue — return structured hypothesis_outcomes; Main commits (Spec #274)";
  }
  return null;
}

export function createHypothesisTool(runtime: ToolRuntime): AgentTool<any> {
  return {
    name: "hypothesis",
    label: "Hypothesis queue",
    description: [
      "Expert Graph hypothesis working memory (Product state).",
      "Ops: list | upsert | commit | apply_package_outcome | seed_store.",
      "Main only. Subagents return hypothesis_outcomes on packages — do not call this tool.",
      "Confirmed ≠ booked. seed_store only seeds Finding Store; finding(confirm, finding_id) still required after feedback_ok.",
      "Killed/deferred never become platform ledger vulns.",
    ].join(" "),
    parameters: Type.Object({
      op: Type.String(),
      id: Type.Optional(Type.String()),
      statement: Type.Optional(Type.String()),
      signal: Type.Optional(Type.String()),
      prove_if: Type.Optional(Type.String()),
      disprove_if: Type.Optional(Type.String()),
      revisit_if: Type.Optional(Type.String()),
      priority: Type.Optional(Type.Union([Type.String(), Type.Number()])),
      evidence_refs: Type.Optional(Type.Array(Type.String())),
      package_ids: Type.Optional(Type.Array(Type.String())),
      payload: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
      status: Type.Optional(Type.String()),
      notes: Type.Optional(Type.String()),
      /** For list filter */
      status_filter: Type.Optional(Type.String()),
      /** Raw package outcome object or outcomes array for apply_package_outcome */
      outcome: Type.Optional(Type.Unknown()),
      location: Type.Optional(Type.String()),
    }),
    async execute(_id: string, params: any) {
      const mainErr = requireMain(runtime);
      if (mainErr) return textResult(mainErr, { isError: true });

      const pq = ensureProcessQuality(runtime.lifecycle);
      const hyp = pq.hypothesisStore;
      const op = String(params.op || "list").trim().toLowerCase();

      if (op === "list") {
        const sf = String(params.status_filter || params.status || "").trim().toLowerCase();
        const filter =
          sf === "active" || sf === "confirmed" || sf === "killed" || sf === "deferred"
            ? { status: sf as HypothesisStatus }
            : undefined;
        const rows = hyp.list(filter);
        return jsonResult({
          ok: true,
          op: "list",
          counts: hyp.counts(),
          hypotheses: rows,
          note: "Queue is not Finding Store. Confirmed ≠ booked.",
        });
      }

      // Writes require runtime mode mirror (stage flag set by executor)
      if (op !== "list" && !isHypothesisRuntimeModeOn(runtime)) {
        return textResult(
          "error: hypothesis writes require stage hypothesis_work_mode: true (missing/false = off; Spec #274)",
          { isError: true },
        );
      }

      if (op === "upsert" || op === "activate") {
        try {
          const row = hyp.upsert({
            id: params.id,
            statement: String(params.statement || ""),
            signal: String(params.signal || ""),
            prove_if: String(params.prove_if || ""),
            disprove_if: String(params.disprove_if || ""),
            revisit_if: params.revisit_if,
            priority: params.priority,
            evidence_refs: params.evidence_refs,
            package_ids: params.package_ids,
            payload: params.payload,
          });
          return jsonResult({ ok: true, op: "upsert", hypothesis: row });
        } catch (e) {
          return textResult(`error: ${e instanceof Error ? e.message : String(e)}`, {
            isError: true,
          });
        }
      }

      if (op === "commit") {
        const status = String(params.status || "").trim().toLowerCase();
        if (status !== "confirmed" && status !== "killed" && status !== "deferred") {
          return textResult("error: commit requires status=confirmed|killed|deferred", {
            isError: true,
          });
        }
        try {
          const row = hyp.commit({
            id: String(params.id || ""),
            status,
            evidence_refs: params.evidence_refs,
            revisit_if: params.revisit_if,
            notes: params.notes,
          });
          return jsonResult({
            ok: true,
            op: "commit",
            hypothesis: row,
            hint:
              status === "confirmed"
                ? "Confirmed ≠ booked. Use seed_store then finding(confirm, finding_id) after feedback_ok."
                : "Killed/deferred are exploration-only — never platform ledger rows.",
          });
        } catch (e) {
          return textResult(`error: ${e instanceof Error ? e.message : String(e)}`, {
            isError: true,
          });
        }
      }

      if (op === "apply_package_outcome") {
        const parsed = parseHypothesisPackageOutcomes(
          Array.isArray(params.outcome) ? params.outcome : params.outcome ? [params.outcome] : [],
        );
        if (!parsed.length) {
          return textResult(
            "error: apply_package_outcome requires outcome with result=proved|disproved|inconclusive",
            { isError: true },
          );
        }
        const applied: unknown[] = [];
        for (const outcome of parsed) {
          const suggestion = suggestedCommitFromPackageOutcome(outcome);
          if (!suggestion || !outcome.hypothesis_id) {
            applied.push({
              outcome,
              applied: false,
              reason: !outcome.hypothesis_id
                ? "missing hypothesis_id — Main must upsert/bind then commit"
                : "no suggestion",
            });
            continue;
          }
          try {
            const row = hyp.commit({
              id: outcome.hypothesis_id,
              status: suggestion.status,
              evidence_refs: outcome.evidence_refs,
              revisit_if: suggestion.revisit_if || outcome.suggested_revisit_if,
              notes: outcome.notes,
            });
            applied.push({ outcome, applied: true, hypothesis: row });
          } catch (e) {
            applied.push({
              outcome,
              applied: false,
              error: e instanceof Error ? e.message : String(e),
            });
          }
        }
        return jsonResult({ ok: true, op: "apply_package_outcome", applied });
      }

      if (op === "seed_store") {
        const id = String(params.id || "").trim();
        if (!id) return textResult("error: seed_store requires id", { isError: true });
        const result = hyp.seedConfirmedToStore(
          pq.findingStore,
          id,
          params.location ? String(params.location) : undefined,
        );
        if (!result.ok) {
          return textResult(`error: ${result.error}`, { isError: true });
        }
        return jsonResult({
          ok: true,
          op: "seed_store",
          finding_id: result.finding_id,
          hint: `Seeded Store only. Confirm with finding(confirm, finding_id=${result.finding_id}) after feedback_ok — never from hypothesis id alone.`,
        });
      }

      return textResult(
        "error: op must be list|upsert|commit|apply_package_outcome|seed_store",
        { isError: true },
      );
    },
  };
}
