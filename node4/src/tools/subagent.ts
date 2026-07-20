import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { runShell } from "./shell.js";
import type { ToolRuntime } from "../types.js";
import { jsonResult, textResult } from "./common.js";
import {
  assertSubagentNestAllowed,
  validateSubagentHandoff,
  type SubagentHandoffFields,
} from "../runtime/subagent-handoff.js";
import { runSubagentLlmSession } from "../runtime/subagent-session.js";
import {
  buildParentObservationBlob,
  evaluateCandidatesForAcceptance,
  normalizeSubagentResult,
  type AcceptanceEvaluation,
  type SubagentCandidate,
  type SubagentStructuredResult,
  type SubagentSurface,
} from "../runtime/subagent-result.js";
import { recordActObservation } from "./common.js";
import { pathKey, rememberSubagentEvidence } from "../runtime/subagent-booking.js";
import {
  SURFACE_CONSUMER_NODES,
  SURFACE_PRODUCER_NODES,
} from "../stores/surface-ledger.js";
import {
  createMutex,
  mapWithConcurrencyLimit,
  MAX_PATH_DISPATCHES,
  MAX_SUBAGENT_BATCH,
  resolveSubagentConcurrency,
} from "../runtime/concurrency.js";

export type SubagentPackageResult = {
  ok: boolean;
  subagent_id: string;
  node_type?: string;
  skill_id?: string;
  summary: string;
  candidates: SubagentCandidate[];
  surfaces: SubagentSurface[];
  acceptance: AcceptanceEvaluation;
  handoff: SubagentHandoffFields;
  evidence_id?: string;
  artifact_path?: string;
  goal_id?: string;
  error?: string;
  assignment_label?: string;
};

type ResolvedPackage = {
  target: string;
  scope: string;
  already_done: string;
  this_turn_goal: string;
  success_criteria: string;
  assignment?: string;
  skill_id?: string;
  node_type?: string;
  goal_id?: string;
  command?: string;
  timeout_seconds: number;
};

const packageItemSchema = Type.Object({
  target: Type.String(),
  scope: Type.Optional(Type.String()),
  already_done: Type.Optional(Type.String()),
  this_turn_goal: Type.String(),
  success_criteria: Type.String(),
  assignment: Type.Optional(Type.String()),
  skill_id: Type.Optional(Type.String()),
  node_type: Type.Optional(Type.String()),
  goal_id: Type.Optional(Type.String()),
  command: Type.Optional(Type.String()),
  timeout_seconds: Type.Optional(Type.Number()),
});

/**
 * Agent-facing subagent tool.
 * Flat: one package. Batch: packages[] run concurrently (OMP-style, default concurrency 3).
 */
export function createSubagentTool(runtime: ToolRuntime): ToolDefinition<any> {
  const postLock = createMutex();

  return {
    name: "subagent",
    label: "Subagent",
    description: [
      "Spawn child work package(s) under this task workspace.",
      "FLAT: target, scope, already_done, this_turn_goal, success_criteria (+ optional node_type/skill_id).",
      "BATCH (OMP-style parallel): packages=[{target,this_turn_goal,success_criteria,...}] with optional shared context/scope/already_done.",
      "Batch: concurrent (NODE4_SUBAGENT_CONCURRENCY default 3), max 5 packages/call. Prefer different paths; same path re-dispatch ≤2 then deadend.",
      "Do NOT one-package-per-every-module forever — group or prioritize open ledger paths. Prefer session seed (parent jar) over re-login.",
      "Without command=: LLM child (preferred). Graph rejects command=.",
      "Returns candidates + surfaces + acceptance (flat) or results[] (batch).",
      "Nested subagent is DISALLOWED.",
    ].join(" "),
    parameters: Type.Object({
      // Flat fields (optional when packages provided)
      target: Type.Optional(Type.String({ description: "Flat: URL | IP:Port | domain+path" })),
      scope: Type.Optional(Type.String({ description: "Flat or batch default scope" })),
      already_done: Type.Optional(
        Type.String({ description: "Flat or batch default already_done (base progress)" }),
      ),
      this_turn_goal: Type.Optional(Type.String({ description: "Flat: single objective" })),
      success_criteria: Type.Optional(Type.String({ description: "Flat: evidence shape" })),
      assignment: Type.Optional(Type.String()),
      goal_id: Type.Optional(Type.String()),
      command: Type.Optional(Type.String()),
      skill_id: Type.Optional(Type.String()),
      node_type: Type.Optional(Type.String()),
      timeout_seconds: Type.Optional(Type.Number()),
      // Batch
      context: Type.Optional(
        Type.String({
          description: "Batch: shared background prepended into each package already_done",
        }),
      ),
      packages: Type.Optional(Type.Array(packageItemSchema)),
    }),
    async execute(_id: string, params: any) {
      if (!runtime.subagents) return textResult("error: subagent host not available");

      const nest = assertSubagentNestAllowed(runtime.lifecycle.subagentDepth);
      if (!nest.ok) return textResult(nest.error, { isError: true });

      const packagesRaw = Array.isArray(params.packages) ? params.packages : null;
      const isBatch = Boolean(packagesRaw && packagesRaw.length > 0);

      if (isBatch) {
        if (packagesRaw!.length > MAX_SUBAGENT_BATCH) {
          return textResult(
            `error: packages length ${packagesRaw!.length} exceeds max ${MAX_SUBAGENT_BATCH}. ` +
              "Prioritize open ledger paths; do not open one package per every module.",
            { isError: true },
          );
        }
        const resolved: ResolvedPackage[] = [];
        const skipped: SubagentPackageResult[] = [];
        for (let i = 0; i < packagesRaw!.length; i++) {
          const raw = packagesRaw![i];
          const r = resolvePackageInput(params, raw, i);
          if ("error" in r) return textResult(r.error, { isError: true });
          const g = validateGraphAndCommand(runtime, r.pkg);
          if (g) return textResult(g, { isError: true });
          if (r.pkg.goal_id && !runtime.goals.get(r.pkg.goal_id)) {
            return textResult(`error: goal not found: ${r.pkg.goal_id}`, { isError: true });
          }
          const pathLimit = checkAndCountPathDispatch(runtime, r.pkg.target);
          if (!pathLimit.ok) {
            skipped.push(softFailPackage(r.pkg, pathLimit.error!));
            continue;
          }
          resolved.push(r.pkg);
        }

        const concurrency = resolveSubagentConcurrency();
        const { results: rawResults } = await mapWithConcurrencyLimit(
          resolved,
          concurrency,
          async (pkg) => {
            try {
              return await runSubagentPackage(runtime, pkg, postLock);
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              return softFailPackage(pkg, msg);
            }
          },
          runtime.lifecycle.abortSignal,
        );

        const results: SubagentPackageResult[] = [
          ...rawResults.map((r, i) =>
            r ?? softFailPackage(resolved[i]!, "package cancelled or failed before result"),
          ),
          ...skipped,
        ];
        const succeeded = results.filter((r) => r.ok).length;
        const failed = results.length - succeeded;
        let ready_total = 0;
        let gap_total = 0;
        for (const r of results) {
          ready_total += r.acceptance?.ready_to_book?.length || 0;
          gap_total += r.acceptance?.needs_more_evidence?.length || 0;
        }
        const ledgerSum = runtime.surfaceLedger?.summary();

        return jsonResult({
          ok: true,
          batch: true,
          concurrency,
          total: results.length,
          succeeded,
          failed,
          results,
          acceptance_summary: {
            ready_total,
            gap_total,
            surface_ledger: ledgerSum ?? null,
          },
          guidance: [
            "BATCH ACCEPTANCE: for each results[i].acceptance.ready_to_book → finding(confirm) with location/candidate.",
            "Soft-failed packages (ok:false) → at most one re-dispatch with tighter success_criteria, then deadend; same path max 2 dispatches.",
            "Book successful packages immediately; do not wait for every path. Prefer parent session seed over re-login.",
          ].join(" "),
        });
      }

      // Flat single package
      const flat = resolvePackageInput(params, null, 0);
      if ("error" in flat) return textResult(flat.error, { isError: true });
      const g = validateGraphAndCommand(runtime, flat.pkg);
      if (g) return textResult(g, { isError: true });
      if (flat.pkg.goal_id && !runtime.goals.get(flat.pkg.goal_id)) {
        return textResult(`error: goal not found: ${flat.pkg.goal_id}`, { isError: true });
      }
      const pathLimit = checkAndCountPathDispatch(runtime, flat.pkg.target);
      if (!pathLimit.ok) {
        return textResult(pathLimit.error!, { isError: true });
      }

      try {
        const one = await runSubagentPackage(runtime, flat.pkg, postLock);
        return jsonResult({
          ok: one.ok,
          subagent_id: one.subagent_id,
          summary: one.summary,
          node_type: one.node_type,
          skill_id: one.skill_id,
          structured: {
            ok: one.ok,
            summary: one.summary,
            candidates: one.candidates,
            surfaces: one.surfaces,
          },
          candidates: one.candidates,
          surfaces: one.surfaces,
          acceptance: one.acceptance,
          evidence_id: one.evidence_id,
          goal_id: one.goal_id,
          artifact_path: one.artifact_path,
          handoff: one.handoff,
          assignment_label: one.assignment_label,
          observations_recorded: true,
          error: one.error,
          guidance: [
            "ACCEPTANCE LOOP (verbatim book is harness-assisted):",
            "1) For each acceptance.ready_to_book: finding(confirm) with title/location + optional candidate_index.",
            "2) needs_more_evidence → re-dispatch with redispatch_hint (max 2) then deadend.",
            "3) Prefer packages[] to fan out independent open ledger paths in parallel.",
            "4) Graph: todo(done) needs act/deadend/skip on surfaces.",
          ].join(" "),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return textResult(`error: subagent failed: ${msg}`, { isError: true });
      }
    },
  };
}

function resolvePackageInput(
  top: Record<string, unknown>,
  item: Record<string, unknown> | null,
  index: number,
): { pkg: ResolvedPackage } | { error: string } {
  const src = item ?? top;
  const context = String(top.context || "").trim();
  const defaultScope = String(top.scope || "").trim();
  const defaultDone = String(top.already_done || "").trim();
  const defaultTimeout = Math.min(Math.max(Number(top.timeout_seconds || 120), 1), 300);

  const target = String(src.target ?? top.target ?? "").trim();
  const scope = String(src.scope ?? defaultScope).trim();
  let already_done = String(src.already_done ?? defaultDone).trim();
  if (context) {
    already_done = already_done
      ? `## Shared context\n${context}\n\n## Already done\n${already_done}`
      : `## Shared context\n${context}`;
  }
  const this_turn_goal = String(src.this_turn_goal ?? (item ? "" : top.this_turn_goal) ?? "").trim();
  const success_criteria = String(
    src.success_criteria ?? (item ? "" : top.success_criteria) ?? "",
  ).trim();

  if (!target || !scope || !already_done || !this_turn_goal || !success_criteria) {
    const mode = item ? `packages[${index}]` : "flat subagent";
    return {
      error:
        `error: ${mode} incomplete handoff — need target, scope, already_done, this_turn_goal, success_criteria ` +
        `(batch may inherit scope/already_done from top-level; context fills shared background).`,
    };
  }

  const timeout_seconds = Math.min(
    Math.max(Number(src.timeout_seconds ?? defaultTimeout), 1),
    300,
  );

  return {
    pkg: {
      target,
      scope,
      already_done,
      this_turn_goal,
      success_criteria,
      assignment: src.assignment != null ? String(src.assignment) : undefined,
      skill_id: src.skill_id != null ? String(src.skill_id).trim() : undefined,
      node_type: src.node_type != null ? String(src.node_type).trim() : item ? undefined : (top.node_type != null ? String(top.node_type).trim() : undefined),
      goal_id: src.goal_id != null ? String(src.goal_id).trim() : undefined,
      command: src.command != null ? String(src.command).trim() : undefined,
      timeout_seconds,
    },
  };
}

function validateGraphAndCommand(runtime: ToolRuntime, pkg: ResolvedPackage): string | null {
  const graphCtx = runtime.lifecycle.pentestGraph;
  const nodeType = pkg.node_type || "";
  if (graphCtx?.mode === "graph" && graphCtx.graph) {
    const check = graphCtx.assertNode?.(nodeType) ?? defaultAssertNode(graphCtx.graph, nodeType);
    if (!check.ok) return check.error;
  }
  if (
    pkg.command &&
    graphCtx?.mode === "graph" &&
    process.env.NODE4_GRAPH_ALLOW_COMMAND_SUB !== "1" &&
    process.env.NODE4_GRAPH_ALLOW_COMMAND_SUB !== "true"
  ) {
    return (
      "error: Graph mode disallows subagent command= (shell-only packages produce no candidates[]). " +
      "Omit command= to run the LLM child. Lab: NODE4_GRAPH_ALLOW_COMMAND_SUB=1."
    );
  }
  return null;
}

function checkAndCountPathDispatch(
  runtime: ToolRuntime,
  target: string,
): { ok: true } | { ok: false; error: string } {
  const key = pathKey(target) || String(target || "").trim().toLowerCase().slice(0, 180);
  if (!key) return { ok: true };
  if (!runtime.lifecycle.subagentPathDispatchCounts) {
    runtime.lifecycle.subagentPathDispatchCounts = {};
  }
  const counts = runtime.lifecycle.subagentPathDispatchCounts;
  const prev = counts[key] || 0;
  if (prev >= MAX_PATH_DISPATCHES) {
    return {
      ok: false,
      error:
        `error: path already dispatched ${prev} times (${key}). ` +
        `Max ${MAX_PATH_DISPATCHES} per path — mark todo note=deadend:${key} or book existing candidates; do not re-open the same package.`,
    };
  }
  counts[key] = prev + 1;
  return { ok: true };
}

function softFailPackage(pkg: ResolvedPackage, error: string): SubagentPackageResult {
  const handoff = {
    target: pkg.target,
    scope: pkg.scope,
    already_done: pkg.already_done,
    this_turn_goal: pkg.this_turn_goal,
    success_criteria: pkg.success_criteria,
  };
  return {
    ok: false,
    subagent_id: "",
    node_type: pkg.node_type,
    skill_id: pkg.skill_id,
    summary: error,
    candidates: [],
    surfaces: [],
    acceptance: {
      ready_to_book: [],
      needs_more_evidence: [],
      package_gaps: [error],
      hint: "Package failed; re-dispatch or deadend this target.",
    },
    handoff,
    error,
  };
}

async function runSubagentPackage(
  runtime: ToolRuntime,
  pkg: ResolvedPackage,
  postLock: <T>(fn: () => Promise<T>) => Promise<T>,
): Promise<SubagentPackageResult> {
  if (!runtime.subagents) {
    return softFailPackage(pkg, "subagent host not available");
  }

  const handoff = validateSubagentHandoff({
    target: pkg.target,
    scope: pkg.scope,
    already_done: pkg.already_done,
    this_turn_goal: pkg.this_turn_goal,
    success_criteria: pkg.success_criteria,
    assignment: pkg.assignment,
  });
  if (!handoff.ok) {
    return softFailPackage(pkg, handoff.error);
  }

  const nodeType = pkg.node_type || undefined;
  const skillId = pkg.skill_id || undefined;
  const command = pkg.command || "";
  const assignmentLabel = [nodeType ? `[${nodeType}]` : "", handoff.handoff.this_turn_goal]
    .filter(Boolean)
    .join(" ")
    .slice(0, 500);

  const result = await runtime.subagents.spawn({
    assignment: handoff.packageText,
    goalId: pkg.goal_id || undefined,
    nodeType,
    worker: async (ctx) => {
      if (command) {
        const shellOut = await runShell(
          command,
          ctx.taskDir,
          pkg.timeout_seconds * 1000,
          runtime.lifecycle.abortSignal,
        );
        const structured = normalizeSubagentResult({
          ok: !shellOut.timedOut && !shellOut.aborted && shellOut.exitCode === 0,
          summary: shellOut.timedOut
            ? "child shell timed out"
            : `child shell exit=${shellOut.exitCode}`,
          candidates: [],
          facts: [],
          deadends: shellOut.timedOut || shellOut.exitCode !== 0 ? ["shell_failed"] : [],
          artifacts: [],
          notes: shellOut.stdout.slice(0, 2000),
        });
        return {
          ok: structured.ok,
          summary: structured.summary,
          data: {
            kind: "shell",
            command,
            cwd: ctx.taskDir,
            workDir: ctx.workDir,
            exitCode: shellOut.exitCode,
            stdout: shellOut.stdout.slice(0, 80_000),
            stderr: shellOut.stderr.slice(0, 20_000),
            timedOut: shellOut.timedOut,
            aborted: shellOut.aborted,
            handoff: handoff.handoff,
            structured,
            node_type: nodeType,
            skill_id: skillId,
          },
        };
      }

      const llmOut = await runSubagentLlmSession({
        parent: runtime,
        subagentId: ctx.subagentId,
        workDir: ctx.workDir,
        assignment: handoff.packageText,
        handoff: handoff.handoff,
        skillId,
        nodeType,
        skillIds: runtime.skillIds,
        abortSignal: runtime.lifecycle.abortSignal,
      });
      return {
        ok: llmOut.ok,
        summary: llmOut.summary,
        data: llmOut.data,
      };
    },
  });

  const structured = normalizeSubagentResult(result.data, result.summary);
  const usedCommandOnly = Boolean(command);
  const nt = nodeType;

  // Post-process under mutex (ledger + parent observations)
  return postLock(async () => {
    const ledger = runtime.surfaceLedger;
    if (ledger) {
      if (structured.surfaces?.length) {
        await ledger.upsertFromRecon(structured.surfaces, {
          source_subagent_id: result.subagentId,
        });
      }
      const candLocs = structured.candidates
        .map((c) => c.location)
        .filter((x): x is string => Boolean(x && String(x).trim()));
      if (candLocs.length) await ledger.markProbed(candLocs);
      if (nt && SURFACE_CONSUMER_NODES.has(nt) && handoff.handoff.target) {
        await ledger.markInProbe([handoff.handoff.target]);
      }
    }

    injectParentObservationsFromChild(runtime, {
      subagentId: result.subagentId,
      nodeType: nt,
      artifactPath: result.artifactPath,
      structured,
      summary: result.summary,
      rawData: result.data,
    });

    const acceptance = evaluateCandidatesForAcceptance(structured.candidates, {
      usedCommandOnly,
      nodeType: nt,
      surfaces: structured.surfaces,
    });
    if (runtime.lifecycle.pentestGraph?.mode === "graph" && usedCommandOnly) {
      acceptance.package_gaps = [
        ...acceptance.package_gaps,
        "Graph mode: command= shell child is weak for vuln evidence — prefer LLM child without command=",
      ];
    }

    if (ledger) {
      const sum = ledger.summary();
      acceptance.surface_ledger = sum as unknown as Record<string, unknown>;
      acceptance.surface_open_hint =
        sum.actionable > 0
          ? `Open/in_probe surfaces (${sum.actionable}): ${sum.open_preview.join(", ") || "(see ledger)"}.`
          : sum.total > 0
            ? `Surface ledger: ${sum.total} path(s), none open.`
            : "Surface ledger empty — run surface package first.";
      acceptance.hint = `${acceptance.hint} ${acceptance.surface_open_hint}`;

      if (nt && SURFACE_CONSUMER_NODES.has(nt) && sum.actionable > 0 && handoff.handoff.target) {
        const tgtKey = pathKey(handoff.handoff.target);
        const known = ledger
          .all()
          .some(
            (s) =>
              pathKey(s.location) === tgtKey ||
              pathKey(s.path_key) === tgtKey ||
              handoff.handoff.target.includes(s.path_key),
          );
        if (tgtKey && !known) {
          acceptance.package_gaps = [
            ...acceptance.package_gaps,
            `target path not in surface ledger — prefer open paths: ${sum.open_preview.join(", ")}`,
          ];
        }
      }
      void SURFACE_PRODUCER_NODES;
    }

    rememberSubagentEvidence(runtime, {
      subagentId: result.subagentId,
      nodeType: nt,
      candidates: structured.candidates,
      acceptance,
      at: Date.now(),
    });

    return {
      ok: result.ok,
      subagent_id: result.subagentId,
      node_type: nt,
      skill_id: skillId,
      summary: result.summary,
      candidates: structured.candidates,
      surfaces: structured.surfaces,
      acceptance,
      handoff: handoff.handoff,
      evidence_id: result.evidenceId,
      artifact_path: result.artifactPath,
      goal_id: result.goalId,
      assignment_label: assignmentLabel,
      error: result.ok ? undefined : result.summary,
    };
  });
}

/**
 * Record child package outputs as parent act observations for proof grounding.
 */
export function injectParentObservationsFromChild(
  runtime: ToolRuntime,
  input: {
    subagentId: string;
    nodeType?: string;
    artifactPath?: string;
    structured: SubagentStructuredResult;
    summary: string;
    rawData?: unknown;
  },
): void {
  const { structured } = input;
  const blob = buildParentObservationBlob(structured);
  const shellStdout =
    input.rawData && typeof input.rawData === "object"
      ? String((input.rawData as Record<string, unknown>).stdout || "").slice(0, 40_000)
      : "";
  const combined = [blob, shellStdout].filter(Boolean).join("\n\n").slice(0, 48_000) || input.summary;

  recordActObservation(
    runtime,
    "subagent",
    `subagent ${input.subagentId}${input.nodeType ? ` [${input.nodeType}]` : ""}: ${structured.summary.slice(0, 200)}`,
    {
      kind: "subagent_package",
      subagent_id: input.subagentId,
      node_type: input.nodeType,
      path: input.artifactPath,
      stdout: combined,
      body: combined,
      observation: combined.slice(0, 6000),
      candidates: structured.candidates,
      summary: structured.summary,
    },
    { role: "proof" },
  );

  let n = 0;
  for (const c of structured.candidates) {
    if (n >= 10) break;
    const excerpt = String(c.proof_excerpt || "").trim();
    if (excerpt.length < 16) continue;
    n += 1;
    const loc = c.location || "";
    const title = c.title || "candidate";
    const poc = c.poc_hint || "";
    const pack = [excerpt, title, loc ? `location=${loc}` : "", c.claim || "", poc ? `poc=${poc}` : ""]
      .filter(Boolean)
      .join("\n");
    recordActObservation(
      runtime,
      "subagent",
      `subagent candidate: ${title}`.slice(0, 300),
      {
        kind: "subagent_candidate",
        subagent_id: input.subagentId,
        node_type: input.nodeType,
        title,
        location: loc,
        url: loc,
        stdout: pack,
        body: pack,
        proof: excerpt,
        observation: excerpt,
        poc_hint: poc,
      },
      { role: "proof" },
    );
  }
}

function defaultAssertNode(
  graph: { nodes?: Record<string, unknown>; roe?: { allow_postex?: boolean } },
  nodeType: string,
): { ok: true } | { ok: false; error: string } {
  const nt = String(nodeType || "").trim();
  if (!nt) {
    return {
      ok: false,
      error:
        "error: Graph mode requires node_type on subagent (e.g. surface, class_probe, prior_reverify).",
    };
  }
  const nodes = graph.nodes || {};
  if (!Object.prototype.hasOwnProperty.call(nodes, nt)) {
    return {
      ok: false,
      error: `error: node_type=${nt} not in graph. Allowed: ${Object.keys(nodes).join(", ")}`,
    };
  }
  const def = nodes[nt] as { requires_postex?: boolean } | undefined;
  if (def?.requires_postex && !graph.roe?.allow_postex) {
    return { ok: false, error: `error: node_type=${nt} requires allow_postex` };
  }
  return { ok: true };
}
