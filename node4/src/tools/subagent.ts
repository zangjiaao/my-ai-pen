import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { runShell } from "./shell.js";
import type { ToolRuntime } from "../types.js";
import { jsonResult, textResult } from "./common.js";
import {
  assertSubagentNestAllowed,
  validateSubagentHandoff,
} from "../runtime/subagent-handoff.js";
import { runSubagentLlmSession } from "../runtime/subagent-session.js";
import {
  buildParentObservationBlob,
  evaluateCandidatesForAcceptance,
  normalizeSubagentResult,
  type SubagentStructuredResult,
} from "../runtime/subagent-result.js";
import { recordActObservation } from "./common.js";
import { pathKey, rememberSubagentEvidence } from "../runtime/subagent-booking.js";
import {
  SURFACE_CONSUMER_NODES,
  SURFACE_PRODUCER_NODES,
} from "../stores/surface-ledger.js";

/**
 * Agent-facing subagent tool.
 * - command= → bounded shell probe (deterministic / fast)
 * - else → same-pack child LLM session (OMP homogeneous worker)
 * Requires full handoff package (A1); nested spawn disallowed (D3).
 * Optional node_type validated when parent is in Graph mode (lifecycle.pentestGraph).
 */
export function createSubagentTool(runtime: ToolRuntime): ToolDefinition<any> {
  return {
    name: "subagent",
    label: "Subagent",
    description: [
      "Spawn a child work package under this task workspace.",
      "REQUIRED handoff: target, scope, already_done, this_turn_goal, success_criteria.",
      "Without command=: same-pack child LLM loop (act tools; no nest; no finding booking) — preferred for vuln claims.",
      "command=: bounded shell only (deterministic); Graph mode should avoid command= for vulnerability packages.",
      "Optional: skill_id, node_type (required in Graph), goal_id, assignment notes.",
      "Returns candidates + surfaces + acceptance{ready_to_book, needs_more_evidence, surface_ledger}.",
      "Surface/recon packages must return surfaces[] (live entrypoints). Parent books; open ledger is the work queue.",
      "Parent ACCEPTANCE LOOP: book ready_to_book with VERBATIM proof_excerpt; re-dispatch needs_more_evidence with gaps.",
      "Nested subagent is DISALLOWED.",
    ].join(" "),
    parameters: Type.Object({
      target: Type.String({ description: "URL | IP:Port | domain+path for this child" }),
      scope: Type.String({ description: "In-scope boundary / constraints for the child" }),
      already_done: Type.String({
        description: "What parent already finished — child must not repeat equivalent work",
      }),
      this_turn_goal: Type.String({ description: "Single objective for this child package" }),
      success_criteria: Type.String({
        description: "What evidence/shape means success (e.g. ports list, PoC stdout)",
      }),
      assignment: Type.Optional(Type.String({ description: "Optional free-form notes appended to handoff" })),
      goal_id: Type.Optional(Type.String()),
      command: Type.Optional(
        Type.String({ description: "If set: bounded shell only (no LLM). Prefer omit for full child session." }),
      ),
      skill_id: Type.Optional(Type.String({ description: "Optional pack skill id for child methodology" })),
      node_type: Type.Optional(
        Type.String({
          description: "Graph work-package type (required in Graph mode): surface, class_probe, …",
        }),
      ),
      timeout_seconds: Type.Optional(Type.Number()),
    }),
    async execute(_id: string, params: any) {
      if (!runtime.subagents) return textResult("error: subagent host not available");

      const nest = assertSubagentNestAllowed(runtime.lifecycle.subagentDepth);
      if (!nest.ok) return textResult(nest.error, { isError: true });

      const handoff = validateSubagentHandoff({
        target: params.target,
        scope: params.scope,
        already_done: params.already_done,
        this_turn_goal: params.this_turn_goal,
        success_criteria: params.success_criteria,
        assignment: params.assignment,
      });
      if (!handoff.ok) {
        return textResult(handoff.error, {
          isError: true,
          missing: handoff.missing,
        });
      }

      const nodeType = params.node_type != null ? String(params.node_type).trim() : "";
      const skillId = params.skill_id != null ? String(params.skill_id).trim() : "";

      // Graph mode: require + validate node_type when a graph is bound on lifecycle.
      const graphCtx = runtime.lifecycle.pentestGraph;
      if (graphCtx?.mode === "graph" && graphCtx.graph) {
        const check = graphCtx.assertNode?.(nodeType) ?? defaultAssertNode(graphCtx.graph, nodeType);
        if (!check.ok) {
          return textResult(check.error, { isError: true });
        }
      }

      const goalId = params.goal_id != null ? String(params.goal_id).trim() : undefined;
      if (goalId && !runtime.goals.get(goalId)) {
        return textResult(`error: goal not found: ${goalId} (create with goal op=create first)`);
      }
      const command = params.command != null ? String(params.command).trim() : "";
      // Graph hard: reject command= shell children (empty evidence contract) unless lab override.
      if (
        command &&
        graphCtx?.mode === "graph" &&
        process.env.NODE4_GRAPH_ALLOW_COMMAND_SUB !== "1" &&
        process.env.NODE4_GRAPH_ALLOW_COMMAND_SUB !== "true"
      ) {
        return textResult(
          "error: Graph mode disallows subagent command= (shell-only packages produce no candidates[]). " +
            "Omit command= to run the LLM child with the evidence contract. " +
            "Lab override: NODE4_GRAPH_ALLOW_COMMAND_SUB=1.",
          { isError: true },
        );
      }
      const timeoutSec = Math.min(Math.max(Number(params.timeout_seconds || 120), 1), 300);

      const assignmentLabel = [
        nodeType ? `[${nodeType}]` : "",
        handoff.handoff.this_turn_goal,
      ]
        .filter(Boolean)
        .join(" ")
        .slice(0, 500);

      const result = await runtime.subagents.spawn({
        assignment: handoff.packageText,
        goalId: goalId || undefined,
        nodeType: nodeType || undefined,
        worker: async (ctx) => {
          if (command) {
            const shellOut = await runShell(
              command,
              ctx.taskDir,
              timeoutSec * 1000,
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
                node_type: nodeType || undefined,
                skill_id: skillId || undefined,
              },
            };
          }

          // Homogeneous child LLM session (OMP-style)
          const llmOut = await runSubagentLlmSession({
            parent: runtime,
            subagentId: ctx.subagentId,
            workDir: ctx.workDir,
            assignment: handoff.packageText,
            handoff: handoff.handoff,
            skillId: skillId || undefined,
            nodeType: nodeType || undefined,
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
      const nt = nodeType || undefined;

      // Surface ledger: merge recon inventory + mark probe progress.
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
        if (nt && SURFACE_CONSUMER_NODES.has(nt)) {
          const tgt = handoff.handoff.target;
          if (tgt) await ledger.markInProbe([tgt]);
        }
      }

      // Graph hard: inject child proofs into parent recentObservations for booking.
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
        acceptance.hint = `${acceptance.hint} Graph: avoid command= for vulnerability packages.`;
      }

      if (ledger) {
        const sum = ledger.summary();
        acceptance.surface_ledger = sum as unknown as Record<string, unknown>;
        acceptance.surface_open_hint =
          sum.actionable > 0
            ? `Open/in_probe surfaces (${sum.actionable}): ${sum.open_preview.join(", ") || "(see ledger)"}. Dispatch class_probe on these paths; Graph todo(done) blocked until acted/deadend/skip.`
            : sum.total > 0
              ? `Surface ledger: ${sum.total} path(s), none open — coverage queue clear or all terminal.`
              : "Surface ledger empty — run node_type=surface with surfaces[] from live recon first.";
        acceptance.hint = `${acceptance.hint} ${acceptance.surface_open_hint}`;

        // Soft hint: consumer target not in ledger
        if (
          nt &&
          SURFACE_CONSUMER_NODES.has(nt) &&
          sum.actionable > 0 &&
          handoff.handoff.target
        ) {
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
        if (nt && SURFACE_PRODUCER_NODES.has(nt) && !(structured.surfaces?.length)) {
          // package_gaps already set by evaluateCandidatesForAcceptance
        }
      }

      rememberSubagentEvidence(runtime, {
        subagentId: result.subagentId,
        nodeType: nt,
        candidates: structured.candidates,
        acceptance,
        at: Date.now(),
      });

      return jsonResult({
        ok: result.ok,
        subagent_id: result.subagentId,
        summary: result.summary,
        node_type: nt,
        skill_id: skillId || undefined,
        structured,
        candidates: structured.candidates,
        surfaces: structured.surfaces,
        acceptance,
        data: result.data,
        evidence_id: result.evidenceId,
        goal_id: result.goalId,
        artifact_path: result.artifactPath,
        handoff: handoff.handoff,
        assignment_label: assignmentLabel,
        observations_recorded: true,
        guidance: [
          "ACCEPTANCE LOOP (verbatim book is harness-assisted):",
          "1) For each acceptance.ready_to_book: finding(confirm) with title/location/description + optional candidate_index= that index.",
          "   You may omit proof= — harness fills VERBATIM proof_excerpt from the candidate when location/title matches.",
          "2) needs_more_evidence → re-dispatch with redispatch_hint (max 2) then deadend.",
          "3) Surface packages: surfaces[] required; open ledger paths are the work queue for class_probe.",
          "4) Graph: todo(done) needs act/deadend/skip on surfaces — no bare batch-flip.",
          "5) Do NOT write *proof*.txt. Prefer LLM child (no command=).",
        ].join(" "),
      });
    },
  };
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

  // One observation per candidate — excerpt leads with raw proof_excerpt for grounding needles.
  let n = 0;
  for (const c of structured.candidates) {
    if (n >= 10) break;
    const excerpt = String(c.proof_excerpt || "").trim();
    if (excerpt.length < 16) continue;
    n += 1;
    const loc = c.location || "";
    const title = c.title || "candidate";
    const poc = c.poc_hint || "";
    // Lead with verbatim proof so proofGroundedInRecentWork substring match always works.
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
        // Force excerpt path: stdout is primary for properties.excerpt
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
        "error: Graph mode requires node_type on subagent (e.g. surface, class_probe, prior_reverify). Free mode may omit node_type.",
    };
  }
  const nodes = graph.nodes || {};
  if (!Object.prototype.hasOwnProperty.call(nodes, nt)) {
    return {
      ok: false,
      error: `error: node_type=${nt} not in active graph. Allowed: ${Object.keys(nodes).join(", ") || "(none)"}`,
    };
  }
  if ((nt === "postex" || nt === "lateral") && graph.roe?.allow_postex === false) {
    return { ok: false, error: `error: node_type=${nt} forbidden when allow_postex=false` };
  }
  return { ok: true };
}
