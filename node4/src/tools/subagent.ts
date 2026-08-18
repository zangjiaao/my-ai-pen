import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
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
  evaluateCandidatesForAcceptance,
  normalizeSubagentResult,
  type AcceptanceEvaluation,
  type SubagentCandidate,
  type SubagentStructuredResult,
  type SubagentSurface,
} from "../runtime/subagent-result.js";
import { pathKey, rememberSubagentEvidence } from "../runtime/subagent-booking.js";
import { injectParentObservationsFromChild } from "../runtime/subagent-parent-obs.js";

/** Re-export for callers that imported inject from the tool module. */
export { injectParentObservationsFromChild } from "../runtime/subagent-parent-obs.js";
import {
  SURFACE_CONSUMER_NODES,
  SURFACE_PRODUCER_NODES,
} from "../stores/surface-ledger.js";
import {
  createMutex,
  mapWithConcurrencyLimit,
  MAX_SUBAGENT_BATCH,
  resolveSubagentConcurrency,
  resolveSubagentTaskBudget,
  tryAdmitSubagentPackage,
} from "../runtime/concurrency.js";
import { promoteChildSessionToParent } from "../runtime/subagent-session-seed.js";
import { getOrCreateIdlePool } from "../runtime/subagent-idle-pool.js";
import {
  assertGraphPackageAnchor,
  checkPackageAttemptBudget,
  markPackageHonesty,
  bumpPackageAttempt,
  ensureProcessQuality,
} from "../runtime/package-honesty-host.js";
import { ingestPackageCandidatesDetailed } from "../runtime/finding-store.js";
import { applyPriorAvoidOnPackage } from "../runtime/prior-seed.js";
import {
  packageItemSchema,
  packagePriorFields,
  resolvePackageInput,
  type ResolvedPackage,
} from "./subagent-package.js";
import { dirname } from "node:path";

export type SubagentPackageResult = {
  ok: boolean;
  subagent_id: string;
  /** Keep-alive worker id for same-path follow-up via resume_agent_id. */
  agent_id?: string;
  /** idle = kept for resume; released = disposed (TTL/cap/abort). */
  worker_status?: "idle" | "released";
  node_type?: string;
  skill_id?: string;
  summary: string;
  candidates: SubagentCandidate[];
  surfaces: SubagentSurface[];
  acceptance: AcceptanceEvaluation;
  /**
   * Spec #274: structured hypothesis outcomes for Main (queue commit / apply_package_outcome).
   * Never auto-committed by host; Sub does not mutate the global queue.
   */
  hypothesis_outcomes?: import("../runtime/hypothesis-store.js").HypothesisPackageOutcome[];
  handoff: SubagentHandoffFields;
  evidence_id?: string;
  artifact_path?: string;
  goal_id?: string;
  error?: string;
  assignment_label?: string;
  /** Warm resume telemetry (hit / reject reason). */
  session_reuse?: Record<string, unknown>;
  /** When idle: prefer this for same-path gap re-dispatch. */
  resume_hint?: { agent_id: string; path_key: string; reason: string };
  /** Tasks Worker chip bind path (explicit | reattach | single_free | fuzzy | pkg). */
  plan_bind?: {
    path: string;
    node_id?: string;
    requested_node_id?: string;
    hint?: string;
  };
};

/**
 * Agent-facing subagent tool.
 * Flat / batch spawn, warm resume, list idle workers, explicit release (OMP lifecycle).
 */
export function createSubagentTool(runtime: ToolRuntime): AgentTool<any> {
  const postLock = createMutex();

  return {
    name: "subagent",
    label: "Subagent",
    description: [
      "Child work packages under this task workspace (OMP keep-alive).",
      "SPAWN FLAT: target, scope, already_done, this_turn_goal, success_criteria (+ node_type/skill_id/plan_node_id).",
      "SPAWN BATCH: packages=[{...}] — concurrency is scheduling only (NODE4_SUBAGENT_CONCURRENCY default 8; extras queue). Same target may fan out freely.",
      "Per-task admitted package budget default 128 (NODE4_SUBAGENT_TASK_BUDGET; max 1024). Batch length safety ceiling MAX_SUBAGENT_BATCH.",
      "plan_node_id (or todo_node_id): REQUIRED for correct Tasks Worker chip when multiple stage todos exist. Prefer todo node_id from your last todo.init/list.",
      "RE-VERIFY (Spec #139): package_kind=re-verify + prior_finding_ids=[Store id…] + this-run fresh proof. Discovery packages host-hard-fail on prior pathKey∩class; set class_key for precise avoid.",
      "WARM: resume_agent_id=prior agent_id on SAME path (gap/timeout follow-up). Soft-fail workers stay idle for resume.",
      "LIST: op=list → idle_workers[] (agent_id, path_key, …).",
      "RELEASE: op=release + agent_id (or release_agent_id) — dispose worker now; else idle TTL (~420s) / maxIdle LRU auto-releases.",
      "Cookies seed/promote. Graph rejects command=. Nested subagent DISALLOWED (depth=1).",
      "Returns agent_id, worker_status idle|released, resume_hint, candidates/acceptance.",
    ].join(" "),
    parameters: Type.Object({
      op: Type.Optional(
        Type.String({
          description: "spawn (default) | list | release",
        }),
      ),
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
      plan_node_id: Type.Optional(
        Type.String({
          description:
            "Hard Graph L2 todo node_id for Worker chip ownership (preferred over fuzzy title match).",
        }),
      ),
      todo_node_id: Type.Optional(Type.String({ description: "Alias of plan_node_id" })),
      timeout_seconds: Type.Optional(Type.Number()),
      resume_agent_id: Type.Optional(
        Type.String({
          description:
            "Flat warm follow-up: prior agent_id. Same path only; omit for cold spawn / orthogonal targets.",
        }),
      ),
      ...packagePriorFields,
      agent_id: Type.Optional(
        Type.String({ description: "For op=release: worker id to dispose" }),
      ),
      release_agent_id: Type.Optional(
        Type.String({ description: "Alias of agent_id for op=release" }),
      ),
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

      const op = String(params.op || "spawn").trim().toLowerCase() || "spawn";

      if (op === "list") {
        const pool = getOrCreateIdlePool(runtime.lifecycle);
        const idle_workers = pool?.listIdle() ?? [];
        return jsonResult({
          ok: true,
          op: "list",
          idle_workers,
          count: idle_workers.length,
          guidance:
            "Idle workers are resumable via resume_agent_id on the SAME path_key. " +
            "Release with op=release when done, or wait idle TTL / maxIdle auto-release.",
        });
      }

      if (op === "release") {
        const aid = String(params.agent_id || params.release_agent_id || "").trim();
        if (!aid) {
          return textResult("error: op=release requires agent_id (or release_agent_id)", {
            isError: true,
          });
        }
        const pool = getOrCreateIdlePool(runtime.lifecycle);
        if (!pool) {
          return jsonResult({
            ok: true,
            op: "release",
            agent_id: aid,
            released: false,
            reason: "idle_pool_disabled",
          });
        }
        const released = await pool.release(aid);
        return jsonResult({
          ok: true,
          op: "release",
          agent_id: aid,
          released,
          reason: released ? "disposed" : "not_found",
          idle_remaining: pool.size,
        });
      }

      if (op !== "spawn") {
        return textResult(`error: unknown subagent op=${op} (use spawn|list|release)`, {
          isError: true,
        });
      }

      const packagesRaw = Array.isArray(params.packages) ? params.packages : null;
      const isBatch = Boolean(packagesRaw && packagesRaw.length > 0);

      if (isBatch) {
        if (packagesRaw!.length > MAX_SUBAGENT_BATCH) {
          return textResult(
            `error: packages length ${packagesRaw!.length} exceeds safety ceiling ${MAX_SUBAGENT_BATCH}.`,
            { isError: true },
          );
        }
        const resolved: ResolvedPackage[] = [];
        const skipped: SubagentPackageResult[] = [];
        for (let i = 0; i < packagesRaw!.length; i++) {
          const raw = packagesRaw![i];
          const r = resolvePackageInput(params, raw, i);
          if ("error" in r) return textResult(r.error, { isError: true });
          const anchorErr = assertGraphPackageAnchor(runtime, r.pkg, `packages[${i}]`);
          if (anchorErr) return textResult(anchorErr, { isError: true });
          const attemptBudget = checkPackageAttemptBudget(runtime, r.pkg.plan_node_id);
          if (!attemptBudget.ok) {
            skipped.push(softFailPackage(r.pkg, attemptBudget.error!, runtime, "never_started"));
            continue;
          }
          const g = validateGraphAndCommand(runtime, r.pkg);
          if (g) return textResult(g, { isError: true });
          if (r.pkg.goal_id && !runtime.goals.get(r.pkg.goal_id)) {
            return textResult(`error: goal not found: ${r.pkg.goal_id}`, { isError: true });
          }
          // Spec #302: path dispatch count is observability only — never blocks admit.
          notePathDispatch(runtime, r.pkg.target);
          const avoid = applyPriorAvoidOnPackage(
            ensureProcessQuality(runtime.lifecycle).findingStore,
            r.pkg,
          );
          if (!avoid.ok) {
            return textResult(`error: ${avoid.error}`, { isError: true });
          }
          const admit = tryAdmitSubagentPackage(runtime.lifecycle);
          if (!admit.ok) {
            skipped.push(softFailPackage(r.pkg, admit.error, runtime, "never_started"));
            continue;
          }
          resolved.push(r.pkg);
        }

        // All packages in this call hit task budget before any admit → explicit tool error.
        if (resolved.length === 0 && skipped.length > 0) {
          const budgetOnly = skipped.every((s) =>
            String(s.error || "").includes("task budget exhausted"),
          );
          if (budgetOnly) {
            return textResult(skipped[0]!.error || "error: subagent task budget exhausted", {
              isError: true,
            });
          }
        }

        const concurrency = resolveSubagentConcurrency();
        const taskBudget = resolveSubagentTaskBudget();
        const { results: rawResults } = await mapWithConcurrencyLimit(
          resolved,
          concurrency,
          async (pkg) => {
            try {
              return await runSubagentPackage(runtime, pkg, postLock);
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              return softFailPackage(pkg, msg, runtime, "failed");
            }
          },
          runtime.lifecycle.abortSignal,
        );

        const results: SubagentPackageResult[] = [
          ...rawResults.map((r, i) =>
            r ??
            softFailPackage(
              resolved[i]!,
              "package cancelled or failed before result",
              runtime,
              runtime.lifecycle.abortSignal?.aborted ? "aborted" : "never_started",
            ),
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
        const ledgerSum =
          (await runtime.surfaceSqlite?.summary()) ?? runtime.surfaceLedger?.summary();
        const pathWarns = pathDispatchWarnFields(runtime);

        return jsonResult({
          ok: true,
          batch: true,
          concurrency,
          task_budget: {
            limit: taskBudget,
            admitted: runtime.lifecycle.subagentPackagesAdmitted ?? 0,
            remaining: Math.max(
              0,
              taskBudget - (runtime.lifecycle.subagentPackagesAdmitted ?? 0),
            ),
          },
          total: results.length,
          succeeded,
          failed,
          results,
          acceptance_summary: {
            ready_total,
            gap_total,
            surface_ledger: ledgerSum ?? null,
          },
          ...(pathWarns ? { path_dispatch: pathWarns } : {}),
          guidance: [
            "BATCH ACCEPTANCE: for each results[i].acceptance.ready_to_book → finding(confirm).",
            "worker_status=idle → same-path gap/timeout: resume_agent_id=results[i].agent_id.",
            "Concurrency queues extras; task budget (NODE4_SUBAGENT_TASK_BUDGET) caps cumulative admits.",
            "Done with a worker → subagent(op=release, agent_id=…) or wait idle TTL; orthogonal modules stay cold packages[].",
            "Cookies seed/promote parent↔child.",
          ].join(" "),
          idle_workers: getOrCreateIdlePool(runtime.lifecycle)?.listIdle() ?? [],
        });
      }

      // Flat single package
      const flat = resolvePackageInput(params, null, 0);
      if ("error" in flat) return textResult(flat.error, { isError: true });
      const anchorErr = assertGraphPackageAnchor(runtime, flat.pkg, "flat subagent");
      if (anchorErr) return textResult(anchorErr, { isError: true });
      const attemptBudget = checkPackageAttemptBudget(runtime, flat.pkg.plan_node_id);
      if (!attemptBudget.ok) return textResult(attemptBudget.error!, { isError: true });
      const g = validateGraphAndCommand(runtime, flat.pkg);
      if (g) return textResult(g, { isError: true });
      if (flat.pkg.goal_id && !runtime.goals.get(flat.pkg.goal_id)) {
        return textResult(`error: goal not found: ${flat.pkg.goal_id}`, { isError: true });
      }
      // Spec #302: path dispatch count is observability only — never blocks admit.
      notePathDispatch(runtime, flat.pkg.target);
      {
        const avoid = applyPriorAvoidOnPackage(
          ensureProcessQuality(runtime.lifecycle).findingStore,
          flat.pkg,
        );
        if (!avoid.ok) {
          return textResult(`error: ${avoid.error}`, { isError: true });
        }
      }
      const admit = tryAdmitSubagentPackage(runtime.lifecycle);
      if (!admit.ok) {
        return textResult(admit.error, { isError: true });
      }

      try {
        const one = await runSubagentPackage(runtime, flat.pkg, postLock);
        const taskBudget = resolveSubagentTaskBudget();
        const pathWarns = pathDispatchWarnFields(runtime);
        return jsonResult({
          ok: one.ok,
          subagent_id: one.subagent_id,
          agent_id: one.agent_id,
          worker_status: one.worker_status,
          summary: one.summary,
          node_type: one.node_type,
          skill_id: one.skill_id,
          structured: {
            ok: one.ok,
            summary: one.summary,
            candidates: one.candidates,
            surfaces: one.surfaces,
            ...(one.hypothesis_outcomes?.length
              ? { hypothesis_outcomes: one.hypothesis_outcomes }
              : {}),
          },
          candidates: one.candidates,
          surfaces: one.surfaces,
          acceptance: one.acceptance,
          ...(one.hypothesis_outcomes?.length
            ? { hypothesis_outcomes: one.hypothesis_outcomes }
            : {}),
          evidence_id: one.evidence_id,
          goal_id: one.goal_id,
          artifact_path: one.artifact_path,
          handoff: one.handoff,
          assignment_label: one.assignment_label,
          session_reuse: one.session_reuse,
          resume_hint: one.resume_hint,
          observations_recorded: true,
          task_budget: {
            limit: taskBudget,
            admitted: runtime.lifecycle.subagentPackagesAdmitted ?? 0,
            remaining: Math.max(
              0,
              taskBudget - (runtime.lifecycle.subagentPackagesAdmitted ?? 0),
            ),
          },
          ...(pathWarns ? { path_dispatch: pathWarns } : {}),
          error: one.error,
          guidance: [
            "ACCEPTANCE LOOP:",
            "1) ready_to_book → finding(confirm) with location/candidate_index.",
            "2) needs_more_evidence or timeout with worker_status=idle → resume_agent_id=agent_id same path.",
            "3) Orthogonal paths → cold packages[] only.",
            "4) Finished with worker → op=release agent_id=… (or idle TTL auto-release).",
            "5) Graph: todo(done) needs act/deadend/skip on surfaces.",
            "6) Task package budget: NODE4_SUBAGENT_TASK_BUDGET (default 128); concurrency queues, does not reject.",
          ].join(" "),
          idle_workers: getOrCreateIdlePool(runtime.lifecycle)?.listIdle() ?? [],
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return textResult(`error: subagent failed: ${msg}`, { isError: true });
      }
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

/**
 * Observability counter only (Spec #302). Same path may be dispatched many times;
 * product anti-spam is task budget + Agent judgment + prior-avoid / honest-partial rules.
 */
function notePathDispatch(runtime: ToolRuntime, target: string): number {
  const key = pathKey(target) || String(target || "").trim().toLowerCase().slice(0, 180);
  if (!key) return 0;
  if (!runtime.lifecycle.subagentPathDispatchCounts) {
    runtime.lifecycle.subagentPathDispatchCounts = {};
  }
  const counts = runtime.lifecycle.subagentPathDispatchCounts;
  const next = (counts[key] || 0) + 1;
  counts[key] = next;
  return next;
}

/** Non-blocking path-dispatch telemetry for tool results (warn when same path ≥2). */
function pathDispatchWarnFields(
  runtime: ToolRuntime,
): { counts: Record<string, number>; warn?: string } | null {
  const counts = runtime.lifecycle.subagentPathDispatchCounts;
  if (!counts || Object.keys(counts).length === 0) return null;
  const multi = Object.entries(counts).filter(([, n]) => n >= 2);
  if (!multi.length) return { counts: { ...counts } };
  const sample = multi
    .slice(0, 5)
    .map(([k, n]) => `${k}×${n}`)
    .join(", ");
  return {
    counts: { ...counts },
    warn:
      `path_dispatch_observe: repeated path dispatches this task (${sample}). ` +
      `Not blocked — Agent judgment + task budget apply.`,
  };
}

function softFailPackage(
  pkg: ResolvedPackage,
  error: string,
  runtime?: ToolRuntime,
  terminal: "failed" | "never_started" | "aborted" = "failed",
): SubagentPackageResult {
  if (runtime) {
    markPackageHonesty(runtime, pkg, terminal);
  }
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
    agent_id: undefined,
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
    return softFailPackage(pkg, "subagent host not available", runtime, "never_started");
  }

  // Spec #116 I0.11: mark running so L2 done is hard-rejected mid-flight
  markPackageHonesty(runtime, pkg, "running");

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

  // Exclusive warm resume at tool layer (affinity: same path). Else cold spawn.
  const resumeWanted = String(pkg.resume_agent_id || "").trim();
  const pool = getOrCreateIdlePool(runtime.lifecycle);
  const pk =
    pathKey(handoff.handoff.target) ||
    String(handoff.handoff.target || "")
      .trim()
      .toLowerCase()
      .slice(0, 180);
  let warmHandle: import("../runtime/subagent-idle-pool.js").IdleSubagentHandle | undefined;
  let resumeReject: string | undefined;
  if (resumeWanted && command) {
    resumeReject = "command_package";
  } else if (resumeWanted && pool) {
    const taken = pool.tryResume(resumeWanted, {
      pathKey: pk,
      nodeType,
      skillId,
    });
    if (taken.ok) warmHandle = taken.handle;
    else resumeReject = taken.reason;
  } else if (resumeWanted && !pool) {
    resumeReject = "disabled";
  }

  let result;
  try {
    result = await runtime.subagents.spawn({
    assignment: handoff.packageText,
    goalId: pkg.goal_id || undefined,
    nodeType,
    // Pure this_turn_goal for panel/Tasks — not "[nodeType] goal" or full handoff markdown.
    label: handoff.handoff.this_turn_goal || assignmentLabel,
    skillId,
    planNodeId: pkg.plan_node_id || undefined,
    // Same workDir only when we hold a warm handle.
    subagentId: warmHandle ? warmHandle.agentId : undefined,
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
            agent_id: ctx.subagentId,
            session_reuse: { hit: false, agent_id: ctx.subagentId, shell: true },
          },
        };
      }

      const llmOut = await runSubagentLlmSession({
        parent: runtime,
        subagentId: ctx.subagentId,
        // Warm session is bound to warm workDir; host workDir may match via subagentId.
        workDir: warmHandle?.workDir || ctx.workDir,
        assignment: handoff.packageText,
        handoff: handoff.handoff,
        skillId,
        nodeType,
        skillIds: runtime.skillIds,
        abortSignal: runtime.lifecycle.abortSignal,
        warmHandle,
      });
      const data =
        llmOut.data && typeof llmOut.data === "object"
          ? {
              ...(llmOut.data as Record<string, unknown>),
              agent_id:
                (llmOut.data as any).agent_id ||
                (llmOut.data as any).session_reuse?.agent_id ||
                ctx.subagentId,
            }
          : llmOut.data;
      if (
        resumeReject &&
        data &&
        typeof data === "object" &&
        (data as any).session_reuse &&
        !(data as any).session_reuse.hit
      ) {
        (data as any).session_reuse.resume_reject = resumeReject;
      }
      return {
        ok: llmOut.ok,
        summary: llmOut.summary,
        data,
      };
    },
  });
  } catch (err) {
    // Re-park exclusive warm handle if spawn failed before lifecycle park.
    if (warmHandle && pool) {
      try {
        pool.park(warmHandle);
      } catch {
        /* ignore */
      }
    }
    throw err;
  }

  // Shell path / any package: promote cookies parent←child (Graph hard needs this)
  try {
    if (result.artifactPath) {
      await promoteChildSessionToParent(
        dirname(result.artifactPath),
        runtime.sessionDir || runtime.taskDir,
      );
    }
  } catch {
    /* non-fatal */
  }

  const structured = normalizeSubagentResult(result.data, result.summary);
  const usedCommandOnly = Boolean(command);
  const nt = nodeType;

  // Post-process under mutex (surface working store + parent observations)
  return postLock(async () => {
    // Spec #371: SQLite is coverage SoT; legacy JSON only when sqlite missing (tests).
    const sqlite = runtime.surfaceSqlite;
    const legacy = runtime.surfaceLedger;
    if (sqlite) {
      await sqlite.open().catch(() => {});
      if (structured.surfaces?.length) {
        await sqlite.upsertFromRecon(structured.surfaces, {
          source_subagent_id: result.subagentId,
        });
      }
      const candLocs = structured.candidates
        .map((c) => c.location)
        .filter((x): x is string => Boolean(x && String(x).trim()));
      if (candLocs.length) await sqlite.markProbed(candLocs);
      if (nt && SURFACE_CONSUMER_NODES.has(nt) && handoff.handoff.target) {
        await sqlite.markInProbe([handoff.handoff.target]);
      }
    } else if (legacy) {
      if (structured.surfaces?.length) {
        await legacy.upsertFromRecon(structured.surfaces, {
          source_subagent_id: result.subagentId,
        });
      }
      const candLocs = structured.candidates
        .map((c) => c.location)
        .filter((x): x is string => Boolean(x && String(x).trim()));
      if (candLocs.length) await legacy.markProbed(candLocs);
      if (nt && SURFACE_CONSUMER_NODES.has(nt) && handoff.handoff.target) {
        await legacy.markInProbe([handoff.handoff.target]);
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

    if (sqlite || legacy) {
      const sum = sqlite
        ? await sqlite.summary()
        : legacy!.summary();
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
        const allRows = sqlite ? await sqlite.all() : legacy!.all();
        const known = allRows.some(
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

    const rawData = result.data as Record<string, unknown> | null;
    const agentId =
      (rawData && typeof rawData.agent_id === "string" && rawData.agent_id) ||
      (rawData?.session_reuse &&
        typeof (rawData.session_reuse as any).agent_id === "string" &&
        (rawData.session_reuse as any).agent_id) ||
      result.subagentId;
    const sessionReuse =
      rawData && typeof rawData.session_reuse === "object" && rawData.session_reuse
        ? (rawData.session_reuse as Record<string, unknown>)
        : undefined;
    const workerStatus =
      (rawData && typeof rawData.worker_status === "string"
        ? (rawData.worker_status as "idle" | "released")
        : undefined) ||
      (sessionReuse?.parked === true ? "idle" : sessionReuse ? "released" : undefined);
    const resumeHint =
      rawData && typeof rawData.resume_hint === "object" && rawData.resume_hint
        ? (rawData.resume_hint as { agent_id: string; path_key: string; reason: string })
        : workerStatus === "idle" && agentId
          ? {
              agent_id: agentId,
              path_key: pk,
              reason: "same_path_followup",
            }
          : undefined;

    // Spec #116: track package terminal for L2 done gates + Finding Store enqueue
    const salvaged = Boolean(rawData && rawData.salvaged === true);
    const aborted = Boolean(runtime.lifecycle.abortSignal?.aborted);
    const terminal = aborted
      ? "aborted"
      : result.ok
        ? "success"
        : "failed";
    markPackageHonesty(runtime, pkg, terminal as "success" | "failed" | "aborted", {
      salvaged,
      subagentId: result.subagentId,
    });
    // Upsert candidates into Finding Store (Store-first) + L0 Feedback (production path)
    const fstore = ensureProcessQuality(runtime.lifecycle).findingStore;
    let severity_rejected: Array<{ title?: string; location?: string; reason: string }> = [];
    if (structured.candidates?.length) {
      const ing = ingestPackageCandidatesDetailed(fstore, structured.candidates, {
        package_id: result.subagentId,
        plan_node_id: pkg.plan_node_id,
        stage_id: runtime.lifecycle.hardGraphRun?.stageId,
        agent_id: agentId,
        fallback_location: handoff.handoff.target,
      });
      severity_rejected = ing.rejected;
      if (severity_rejected.length) {
        acceptance.package_gaps = [
          ...(acceptance.package_gaps || []),
          ...severity_rejected.map(
            (r) =>
              `candidate rejected (${r.reason}): ${r.title || "?"} @ ${r.location || "?"} — set severity=critical|high|medium|low|info`,
          ),
        ];
      }
    }

    // Spec #116 I0.1: count package attempts against plan_node_id budget
    bumpPackageAttempt(runtime, pkg.plan_node_id);

    return {
      ok: result.ok,
      subagent_id: result.subagentId,
      agent_id: agentId,
      worker_status: workerStatus,
      node_type: nt,
      skill_id: skillId,
      summary: result.summary,
      candidates: structured.candidates,
      surfaces: structured.surfaces,
      acceptance,
      // Spec #274: forward structured outcomes so Main can apply_package_outcome / commit
      ...(structured.hypothesis_outcomes?.length
        ? { hypothesis_outcomes: structured.hypothesis_outcomes }
        : {}),
      handoff: handoff.handoff,
      evidence_id: result.evidenceId,
      artifact_path: result.artifactPath,
      goal_id: result.goalId,
      assignment_label: assignmentLabel,
      session_reuse: sessionReuse,
      resume_hint: resumeHint,
      plan_bind: result.planBind
        ? {
            path: result.planBind.path,
            node_id: result.planBind.node_id,
            requested_node_id: result.planBind.requested_node_id,
            hint:
              result.planBind.hint ||
              (result.planBind.path === "fuzzy" || result.planBind.path === "pkg"
                ? "Pass plan_node_id (Tasks L2 todo node_id) on next subagent spawn for deterministic Worker chip ownership."
                : undefined),
          }
        : undefined,
      error: result.ok ? undefined : result.summary,
    };
  });
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
