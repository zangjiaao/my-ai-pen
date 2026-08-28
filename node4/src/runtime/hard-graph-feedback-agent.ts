/**
 * Graph Feedback Agent — L1 critic + stage-advance after host L0.
 *
 * Not the stage captain. Host spawns a short depth-1 session over Product state.
 * Mechanical L0 stays the hard baseline; this agent judges refine vs pass and
 * whether the runner may open the next stage.
 */

import { join } from "node:path";
import type { Node4Config } from "../config.js";
import type { RolePack } from "../roles/types.js";
import type { TaskEnvelope, ToolRuntime } from "../types.js";
import { GoalStore } from "../stores/goal.js";
import { ProcessFactStore } from "../stores/process-fact.js";
import { TodoStore } from "../stores/todo.js";
import {
  ensurePiInstanceWorkspace,
  mintPiSessionId,
  resolvePiInstanceDir,
  workspaceCaseId,
} from "./session-workspace.js";
import { applyHardGraphToolProfile } from "./hard-graph-definition.js";
import type { HardGraphStageDef } from "./hard-graph-definition.js";
import { createBoundNode4Session, type Node4AgentSession } from "./run-node4-agent.js";
import {
  parseStageAdvance,
  parseStageAdvanceToken,
  type StageAdvance,
} from "./stage-advance-feedback.js";
import type { L1CriticInput, L1Decision } from "./l1-critic.js";
import { assembleSystemPrompt, buildBaseLayer, joinNonEmptyPromptParts } from "./prompt.js";
import {
  attachWorkerProcessStream,
  newPackageTurnId,
} from "./worker-audit-channel.js";
import { attachChildSessionUsage } from "./child-session-usage.js";

/** Read/inspect only — no shell/http, no confirm, no packages. */
export const GRAPH_FEEDBACK_TOOL_NAMES = ["fact", "read", "finding", "hypothesis"] as const;

/** Stable panel / Agent id for the Graph run — not per-stage clones. */
export const GRAPH_FEEDBACK_AGENT_ID = "feedback";

export type FeedbackAgentDecision = {
  decision: L1Decision;
  gaps: string[];
  stageAdvance?: StageAdvance;
};

export type FeedbackAgentFn = (input: {
  l1Input: L1CriticInput;
  stage: HardGraphStageDef;
  instruction?: string;
  /** Host-named hop: immediate next Graph stage, if any. */
  nextStageId?: string;
}) => Promise<FeedbackAgentDecision>;

const L1_TOKENS = new Set<L1Decision>(["pass", "refine"]);

export function parseL1DecisionToken(raw: unknown): L1Decision | undefined {
  if (typeof raw !== "string") return undefined;
  const t = raw.trim().toLowerCase().split(/[\s:,;/|]+/)[0] || "";
  if (L1_TOKENS.has(t as L1Decision)) return t as L1Decision;
  return undefined;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function readL1Fields(o: Record<string, unknown>): L1Decision | undefined {
  return parseL1DecisionToken(o.l1_decision) ?? parseL1DecisionToken(o.l1Decision);
}

/** Typed l1_decision only — never scrape notes/instruction prose. */
export function parseL1Decision(input: unknown): L1Decision | undefined {
  if (input == null) return undefined;
  if (typeof input === "string") return parseL1DecisionToken(input);
  if (!isPlainObject(input)) return undefined;
  const seen = new Set<unknown>();
  const objects: Record<string, unknown>[] = [];
  const push = (v: unknown) => {
    if (!isPlainObject(v) || seen.has(v)) return;
    seen.add(v);
    objects.push(v);
  };
  push(input);
  push(input.data);
  push(input.structured);
  push(input.raw);
  for (const o of objects) {
    const v = readL1Fields(o);
    if (v) return v;
  }
  const factLists: unknown[] = [input.facts];
  for (const o of objects) factLists.push(o.facts);
  for (const list of factLists) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (!isPlainObject(item)) continue;
      const key = String(item.key ?? item.fact_key ?? "").trim();
      const compact = key.toLowerCase().replace(/[-_/]/g, "");
      if (compact !== "l1decision" && !compact.endsWith("l1decision")) continue;
      const v = parseL1DecisionToken(item.summary);
      if (v) return v;
    }
  }
  return undefined;
}

function gapsFromFacts(input: unknown): string[] {
  if (!isPlainObject(input) || !Array.isArray(input.facts)) return [];
  const out: string[] = [];
  for (const item of input.facts) {
    if (!isPlainObject(item)) continue;
    const key = String(item.key ?? item.fact_key ?? "").trim().toLowerCase();
    if (!key.includes("l1") && key !== "gaps") continue;
    const body = String(item.body || item.summary || "").trim();
    if (body) out.push(body.slice(0, 400));
  }
  return out.slice(0, 12);
}

/**
 * Feedback Agent typed fields. Missing l1_decision → pass (L0 already passed).
 * Missing stage_advance on pass → continue (runner opens the next stage).
 */
export function parseFeedbackAgentDecision(input: unknown): FeedbackAgentDecision {
  const decision = parseL1Decision(input) ?? "pass";
  const gaps = gapsFromFacts(input);
  const stageAdvance = parseStageAdvance(input) ?? parseStageAdvanceToken(
    isPlainObject(input) ? input.stage_advance : undefined,
  );
  if (decision === "refine") {
    return { decision, gaps: gaps.length ? gaps : ["Feedback Agent requested refine"] };
  }
  return { decision: "pass", gaps, ...(stageAdvance ? { stageAdvance } : {}) };
}

export function feedbackToolNames(packTools: readonly string[]): string[] {
  return applyHardGraphToolProfile(packTools, { allow: [...GRAPH_FEEDBACK_TOOL_NAMES] });
}

export function buildFeedbackUserPrompt(input: {
  stage: HardGraphStageDef;
  l1Input: L1CriticInput;
  instruction?: string;
  nextStageId?: string;
}): string {
  const next = String(input.nextStageId || "").trim();
  const hop = next
    ? `${input.stage.id} → ${next}`
    : `${input.stage.id} (no further Graph stage)`;
  const operator = String(input.instruction || "").trim() || "(none)";
  return [
    `### Operator request`,
    operator,
    "",
    `### This hop`,
    hop,
    `Stage success: ${input.stage.success || "(none)"}`,
    "",
    "### Product state (host projection)",
    JSON.stringify(input.l1Input, null, 2),
    "",
    "You are Graph Feedback — not the stage captain. No live recon.",
    "Declare typed fields only:",
    "fact(op=upsert, fact_key=l1_decision, summary=pass|refine, body=short reason)",
    "If pass: fact(op=upsert, fact_key=stage_advance, summary=continue|pause|stop, body=short reason)",
    "stage_advance is this hop only. continue = runner may open the host-named next stage.",
    "refine = same stage must rework (L0 already passed; Product-state gaps).",
    "pause = do not open this hop's next stage until the user permits.",
    "stop = do not open later stages.",
    "The operator request is the user's requirement. If they asked to wait before THIS hop's next stage, vote pause.",
    "A pause/stop that names a later stage does not apply to this hop.",
    "Default this hop to continue when success is met and the operator did not ask to wait here.",
  ].join("\n");
}

export function feedbackSystemPrompt(task: TaskEnvelope, pack: RolePack, tools: string[]): string {
  const base = buildBaseLayer({
    agentLanguage: task.agentLanguage,
    packId: pack.id,
    packLabel: pack.label || pack.id,
    expertName: task.expertName,
    expertId: task.expertId,
  });
  const runtime = joinNonEmptyPromptParts([
    "Runtime · Graph Feedback: host-owned critic after stage L0. Not recon. Not booking.",
    `Tools: ${tools.join(", ") || "(none)"}. finding is list/get only (depth-1 cannot confirm).`,
    "Profession methodology does not apply — judge Product state against the stage success line.",
    "One Feedback Agent for the Graph run. Each hop is the next turn on this session — not a new instance.",
    "stage_advance is this hop only. Honor the operator request for this hop. Default continue.",
  ]);
  return assembleSystemPrompt({
    base,
    profession: "Graph Feedback Agent.",
    runtime,
    task: "",
  });
}

export type RunHardGraphFeedbackAgentOptions = {
  config: Node4Config;
  parentRuntime: ToolRuntime;
  pack: RolePack;
  stage: HardGraphStageDef;
  l1Input: L1CriticInput;
  instruction?: string;
  nextStageId?: string;
  overlayPrefix?: string;
  abortSignal?: AbortSignal;
  boundSessionFactory?: (options: {
    config: Node4Config;
    runtime: ToolRuntime;
    pack: RolePack;
    systemPrompt: string;
    thinkingLevel?: string;
    sessionId?: string;
  }) => Promise<{ session: Node4AgentSession; segmentCounter?: { tools: number } }>;
};

function failClosed(message: string): FeedbackAgentDecision {
  return { decision: "refine", gaps: [`Feedback Agent error (fail-closed): ${message}`] };
}

/** Live collab tree: flush Feedback running/settled so the row is not stuck green. */
async function emitFeedbackPanelSnapshot(
  runtime: ToolRuntime,
  panel: { list: () => unknown[] } | undefined,
): Promise<void> {
  if (!panel) return;
  const task = runtime.task;
  if (!task?.conversationId || !task.taskId) return;
  await runtime.platform
    .send({
      type: "checkpoint_update",
      conversation_id: task.conversationId,
      task_id: task.taskId,
      expert_id: task.expertId,
      expert_name: task.expertName,
      checkpoint: {
        runtime: "node4-pi",
        panel_agents: panel.list(),
        agent_phase: "feedback",
        task_id: task.taskId,
        expert_id: task.expertId,
      },
    })
    .catch(() => {});
}

/** Graph terminal / error: drop the run-wide Feedback Agent. */
export async function disposeGraphFeedbackHandle(runtime: ToolRuntime): Promise<void> {
  const run = runtime.lifecycle.hardGraphRun;
  const handle = run?.feedbackHandle;
  if (!handle) return;
  if (run) run.feedbackHandle = undefined;
  try {
    await handle.session.dispose?.();
  } catch {
    /* ignore */
  }
}

/**
 * Host-owned Feedback Agent after L0 pass. One pi session per Graph run;
 * later stages are the next turn. Errors/timeout → L1 refine (not graph death).
 */
export async function runHardGraphFeedbackAgent(
  options: RunHardGraphFeedbackAgentOptions,
): Promise<FeedbackAgentDecision> {
  const { config, parentRuntime, pack, stage, l1Input, abortSignal } = options;
  const task = parentRuntime.task;
  const tools = feedbackToolNames(pack.toolNames || []);
  const expertId = String(task.expertId || pack.id || "").trim() || "default";
  const agentId = GRAPH_FEEDBACK_AGENT_ID;
  const packForFb: RolePack = { ...pack, toolNames: tools };
  const systemPrompt = feedbackSystemPrompt(task, packForFb, tools);
  const userPrompt = buildFeedbackUserPrompt({
    stage,
    l1Input,
    instruction: options.instruction ?? task.instruction,
    nextStageId: options.nextStageId,
  });

  const graphRun = parentRuntime.lifecycle.hardGraphRun;
  const reuse =
    !options.boundSessionFactory && graphRun?.feedbackHandle
      ? graphRun.feedbackHandle
      : undefined;

  const sid = reuse ? String(reuse.session.sessionId || "feedback") : mintPiSessionId();
  const workDir = reuse
    ? reuse.workDir
    : parentRuntime.workspaceDir
      ? resolvePiInstanceDir(
          parentRuntime.workspaceDir,
          workspaceCaseId(task.conversationId),
          expertId,
          sid,
        )
      : join(parentRuntime.piDir, `feedback-${sid}`);
  if (!reuse) await ensurePiInstanceWorkspace(workDir);

  const processFacts = reuse
    ? reuse.processFacts
    : new ProcessFactStore(join(workDir, "facts"));
  const childRuntime: ToolRuntime = reuse
    ? {
        ...reuse.runtime,
        lifecycle: {
          ...reuse.runtime.lifecycle,
          abortSignal,
          workerAudit: { agentId, packageTurnId: newPackageTurnId(agentId) },
        },
      }
    : {
        task,
        workspaceDir: parentRuntime.workspaceDir,
        piDir: workDir,
        caseDir: parentRuntime.caseDir,
        sessionDir: parentRuntime.sessionDir,
        platform: parentRuntime.platform,
        platformApi: parentRuntime.platformApi,
        todo: new TodoStore(),
        evidence: parentRuntime.evidence,
        findingsDir: parentRuntime.findingsDir,
        goals: new GoalStore(),
        rolePackId: pack.id,
        skills: parentRuntime.skills,
        skillIds: pack.skillIds,
        processFacts,
        surfaceLedger: parentRuntime.surfaceLedger,
        surfaceSqlite: parentRuntime.surfaceSqlite,
        lifecycle: {
          toolsInLastSegment: 0,
          recentObservations: [],
          subagentDepth: 1,
          abortSignal,
          subagentEvidenceCache: [],
          processQuality: parentRuntime.lifecycle.processQuality,
          panelAgents: parentRuntime.lifecycle.panelAgents,
          hardGraphRun: parentRuntime.lifecycle.hardGraphRun,
          workerAudit: { agentId, packageTurnId: newPackageTurnId(agentId) },
        },
      };

  const panel = graphRun?.panel || parentRuntime.lifecycle.panelAgents;
  const hop = String(options.nextStageId || "").trim()
    ? `${stage.id} → ${options.nextStageId}`
    : stage.id;
  panel?.noteSubagentStart({
    id: agentId,
    assignment: `Feedback after ${stage.id}`,
    label: `评审 ${hop}`,
    nodeType: "feedback",
    name: "Feedback",
  });
  panel?.setMainActivity({
    phase: "llm_waiting",
    detail: `Feedback 评审 ${hop}`,
  });
  await emitFeedbackPanelSnapshot(parentRuntime, panel);

  let workerProcess: { dispose: () => void } | undefined;
  let usage: { dispose: () => void } | undefined;
  try {
    await processFacts.ensureDir?.().catch(() => {});
    let session = reuse?.session;
    if (!session) {
      const boundOpts = {
        config,
        runtime: childRuntime,
        pack: packForFb,
        systemPrompt,
        thinkingLevel: "low" as const,
        sessionId: sid,
      };
      const bound = options.boundSessionFactory
        ? await options.boundSessionFactory(boundOpts)
        : await createBoundNode4Session(boundOpts);
      session = bound.session;
      if (graphRun && !options.boundSessionFactory) {
        graphRun.feedbackHandle = {
          session,
          processFacts,
          workDir,
          runtime: childRuntime,
        };
      }
    } else {
      try {
        session.rebind?.({ systemPrompt });
      } catch {
        /* optional */
      }
    }

    workerProcess = attachWorkerProcessStream({ session, runtime: childRuntime });
    usage = attachChildSessionUsage({
      session,
      onRecorded: (snap) => {
        try {
          panel?.setChildUsage(agentId, snap);
        } catch {
          /* observability must not change Feedback settlement */
        }
      },
    });

    const onAbort = () => {
      try {
        session.abort();
      } catch {
        /* best-effort */
      }
    };
    abortSignal?.addEventListener("abort", onAbort, { once: true });
    try {
      await session.prompt(
        userPrompt,
        options.overlayPrefix ? { prefixHarness: options.overlayPrefix } : undefined,
      );
    } finally {
      abortSignal?.removeEventListener("abort", onAbort);
      // Keep the Graph-run session. Tests that inject boundSessionFactory still dispose.
      if (options.boundSessionFactory) {
        try {
          await session.dispose?.();
        } catch {
          /* ignore */
        }
      }
    }

    const index = processFacts.list ? await processFacts.list() : [];
    const parsed = parseFeedbackAgentDecision({ facts: index });
    panel?.noteSubagentEnd({
      id: agentId,
      ok: parsed.decision === "pass",
      summary: parsed.decision,
    });
    await emitFeedbackPanelSnapshot(parentRuntime, panel);
    return parsed;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    panel?.noteSubagentEnd({ id: agentId, ok: false, summary: msg.slice(0, 160) });
    await emitFeedbackPanelSnapshot(parentRuntime, panel);
    return failClosed(msg);
  } finally {
    try {
      void workerProcess?.dispose();
    } catch {
      /* ignore */
    }
    try {
      usage?.dispose();
    } catch {
      /* ignore */
    }
  }
}
