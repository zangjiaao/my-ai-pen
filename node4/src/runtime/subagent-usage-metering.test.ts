/**
 * Spec #487 — Node4 Sub pi usage → Case metering completeness.
 *
 * Primary seam: real Node4 checkpoint (Main own + child panel usage)
 * through platform apply_checkpoint_to_participant.
 *
 * Run: npx tsx src/runtime/subagent-usage-metering.test.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GoalStore } from "../stores/goal.js";
import { EvidenceStore } from "../stores/evidence.js";
import { TodoStore } from "../stores/todo.js";
import type { PlatformMessage, TaskEnvelope, ToolRuntime } from "../types.js";
import type { Node4AgentSession } from "./run-node4-agent.js";
import { LlmUsageLedger } from "./llm-usage.js";
import { PanelAgentTracker } from "./panel-agents.js";
import { buildNode4Checkpoint } from "./platform-observability.js";
import { SubagentHost } from "./subagent.js";
import { runSubagentLlmSession } from "./subagent-session.js";
import { SubagentIdlePool, type IdleSubagentHandle } from "./subagent-idle-pool.js";
import type { SubagentHandoffFields } from "./subagent-handoff.js";
import { pathKey } from "./subagent-booking.js";
import { attachChildSessionUsage } from "./child-session-usage.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");

delete process.env.NODE4_SUBAGENT_DRY;
process.env.NODE4_SUBAGENT_IDLE = "1";

type AssistantUsage = {
  input: number;
  output: number;
  totalTokens: number;
  model?: string;
  cost?: number;
};

function usageEvent(u: AssistantUsage) {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      model: u.model || "pi-test-model",
      content: [{ type: "text", text: "ok" }],
      usage: {
        input: u.input,
        output: u.output,
        totalTokens: u.totalTokens,
        cost: u.cost != null ? { total: u.cost } : undefined,
      },
    },
  };
}

function createFakeSession(opts: {
  usages?: AssistantUsage[];
  afterEmit?: "ok" | "throw" | "hang" | "nothing";
  messages?: unknown[];
}): Node4AgentSession & {
  disposed: boolean;
  prompted: boolean;
  listenerCount: () => number;
  nextUsages: AssistantUsage[];
  afterEmit: "ok" | "throw" | "hang" | "nothing";
} {
  const listeners: Array<(event: any) => void | Promise<void>> = [];
  const storedMessages: unknown[] = [...(opts.messages || [])];
  const state = {
    disposed: false,
    prompted: false,
    nextUsages: opts.usages ? [...opts.usages] : [],
    afterEmit: opts.afterEmit || "ok",
  };
  return {
    get disposed() {
      return state.disposed;
    },
    get prompted() {
      return state.prompted;
    },
    get nextUsages() {
      return state.nextUsages;
    },
    set nextUsages(v: AssistantUsage[]) {
      state.nextUsages = v;
    },
    get afterEmit() {
      return state.afterEmit;
    },
    set afterEmit(v: "ok" | "throw" | "hang" | "nothing") {
      state.afterEmit = v;
    },
    listenerCount: () => listeners.length,
    subscribe(listener) {
      listeners.push(listener);
      return () => {
        const i = listeners.indexOf(listener);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    async prompt() {
      state.prompted = true;
      if (state.afterEmit === "nothing") return;
      for (const u of state.nextUsages) {
        const ev = usageEvent(u);
        storedMessages.push(ev.message);
        for (const l of listeners) await l(ev);
      }
      if (state.afterEmit === "throw") throw new Error("provider failed after usage");
      if (state.afterEmit === "hang") {
        await new Promise(() => {
          /* aborted via session.abort / parent signal */
        });
      }
    },
    abort() {},
    dispose() {
      state.disposed = true;
    },
    steer() {},
    followUp() {},
    get messages() {
      return storedMessages;
    },
  };
}

function applyCheckpointThroughPlatform(checkpoint: Record<string, unknown>): {
  own: number;
  participant: number;
  caseTokens: number;
  caseRequests: number;
  caseCost: number;
  childTokens: number;
  childRequests: number;
  childModel?: string;
  againCase: number;
  agentsChildTokens: number;
  agentsParentTokens: number;
} {
  const script = `
import json, sys
sys.path.insert(0, ${JSON.stringify(join(repoRoot, "platform/backend"))})
from app.services.case_participants import (
    apply_checkpoint_to_participant,
    agents_from_participants,
)
cp = json.loads(sys.stdin.read())
ctx = apply_checkpoint_to_participant(
    {},
    cp,
    expert_id="e2",
    expert_name="渗透大师",
    pack_id="pentest",
    running=True,
)
again = apply_checkpoint_to_participant(
    ctx,
    cp,
    expert_id="e2",
    expert_name="渗透大师",
    pack_id="pentest",
    running=True,
)
row = ctx["participants"]["expert:e2"]
kids = [a for a in (row.get("panel_agents") or []) if a.get("parent_id")]
agents = agents_from_participants(ctx)
root = next(a for a in agents if not a.get("parent_id"))
akids = [a for a in agents if a.get("parent_id")]
print(json.dumps({
    "own": (row.get("usage_own") or {}).get("total_tokens"),
    "participant": (row.get("usage") or {}).get("total_tokens"),
    "caseTokens": ctx["case_run"]["llm_usage"]["total_tokens"],
    "caseRequests": ctx["case_run"]["llm_usage"]["requests"],
    "caseCost": ctx["case_run"]["llm_usage"]["cost"],
    "childTokens": ((kids[0] or {}).get("usage") or {}).get("total_tokens") if kids else None,
    "childRequests": ((kids[0] or {}).get("usage") or {}).get("requests") if kids else None,
    "childModel": ((kids[0] or {}).get("usage") or {}).get("model") if kids else None,
    "againCase": again["case_run"]["llm_usage"]["total_tokens"],
    "agentsChildTokens": ((akids[0] or {}).get("usage") or {}).get("total_tokens") if akids else None,
    "agentsParentTokens": (root.get("usage") or {}).get("total_tokens"),
}))
`;
  const proc = spawnSync("python3", ["-c", script], {
    input: JSON.stringify(checkpoint),
    encoding: "utf8",
    cwd: repoRoot,
  });
  if (proc.status !== 0) {
    throw new Error(`platform apply failed: ${proc.stderr || proc.stdout}`);
  }
  return JSON.parse(proc.stdout);
}

function handoff(goal = "probe sqli"): SubagentHandoffFields {
  return {
    target: "http://t/sqli",
    scope: "t",
    already_done: "recon",
    this_turn_goal: goal,
    success_criteria: "candidate or deadend",
  };
}

async function makeParent(dir: string, panel: PanelAgentTracker): Promise<{
  runtime: ToolRuntime;
  messages: PlatformMessage[];
  host: SubagentHost;
}> {
  const messages: PlatformMessage[] = [];
  const task = {
    taskId: "t-487",
    conversationId: "c-487",
    instruction: "assess",
    expertId: "e2",
    expertName: "渗透大师",
    target: { url: "http://t/sqli" },
    scope: {},
  } as unknown as TaskEnvelope;
  const runtime = {
    task,
    workspaceDir: dir,
    taskDir: dir,
    platform: {
      send: async (m: PlatformMessage) => {
        messages.push(m);
      },
    },
    todo: new TodoStore(),
    evidence: new EvidenceStore(join(dir, "evidence")),
    findingsDir: join(dir, "findings"),
    goals: new GoalStore(),
    rolePackId: "pentest",
    lifecycle: {
      toolsInLastSegment: 0,
      subagentDepth: 0,
      recentObservations: [],
      panelAgents: panel,
    },
  } as ToolRuntime;
  const host = new SubagentHost({
    task,
    taskDir: dir,
    evidence: runtime.evidence,
    platform: runtime.platform,
    goals: runtime.goals,
    panelAgents: panel,
  });
  runtime.subagents = host;
  return { runtime, messages, host };
}

function childRow(panel: PanelAgentTracker, id?: string) {
  const rows = panel.list().filter((a) => a.parent_id);
  if (id) return rows.find((a) => a.id === id);
  return rows[0];
}

// ---------------------------------------------------------------------------
// Primary: Main 70 + Sub 30 → Case 100 once (child panel row must carry usage)
// ---------------------------------------------------------------------------
{
  const dir = await mkdtemp(join(tmpdir(), "n4-487-primary-"));
  try {
    const panel = new PanelAgentTracker("assess", "渗透大师");
    const { runtime, host } = await makeParent(dir, panel);
    const mainUsage = new LlmUsageLedger();
    mainUsage.recordAssistantMessage({
      role: "assistant",
      model: "gpt-main",
      usage: { input: 40, output: 30, totalTokens: 70, cost: { total: 0.007 } },
    });

    const session = createFakeSession({
      usages: [{ input: 20, output: 10, totalTokens: 30, model: "pi-sub-model", cost: 0.003 }],
    });

    await host.spawn({
      assignment: "Probe SQLi",
      label: "Probe SQLi",
      subagentId: "sub_487",
      worker: async (ctx) => {
        const out = await runSubagentLlmSession({
          parent: runtime,
          subagentId: ctx.subagentId,
          workDir: ctx.workDir,
          assignment: ctx.assignment,
          handoff: handoff(),
          boundSessionFactory: async () => ({ session, segmentCounter: { tools: 0 } }),
        });
        return { ok: out.ok, summary: out.summary, data: out.data };
      },
    });

    const child = childRow(panel, "sub_487");
    assert.ok(child, "child panel row exists");
    assert.equal(
      Number(child.usage?.total_tokens || 0),
      30,
      `child row must carry Sub usage 30, got ${JSON.stringify(child)}`,
    );

    const childDir = join(dir, "subagents", "sub_487");
    const raw = await readFile(join(childDir, "transcript.jsonl"), "utf8");
    const persisted = raw
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { role?: string; usage?: { totalTokens?: number } });
    const assistant = persisted.filter((m) => m.role === "assistant");
    assert.equal(assistant.length, 1, "child transcript has the assistant message");
    assert.equal(Number(assistant[0]?.usage?.totalTokens), 30, "persisted messages[].usage matches pi");

    const checkpoint = buildNode4Checkpoint({
      platform: runtime.platform,
      task: runtime.task,
      runtime,
      goals: runtime.goals,
      usage: mainUsage,
      panel,
      startedAt: "2026-01-01T00:00:00Z",
      rolePackId: "pentest",
      counters: { toolCallCount: 0, phase: "running" },
    });

    assert.equal(
      Number((checkpoint.llm_usage as { total_tokens?: number })?.total_tokens),
      70,
      "root llm_usage is Main own only",
    );

    const rolled = applyCheckpointThroughPlatform(checkpoint);
    assert.equal(rolled.own, 70, "Main own usage 70");
    assert.equal(rolled.childTokens, 30, "Sub row 30");
    assert.equal(rolled.participant, 100, "Participant 100");
    assert.equal(rolled.caseTokens, 100, "Case 100");
    assert.equal(rolled.againCase, 100, "reapply is idempotent");
    assert.equal(rolled.agentsParentTokens, 100, "snapshot parent 100");
    assert.equal(rolled.agentsChildTokens, 30, "snapshot child 30");
    assert.equal(rolled.childModel, "pi-sub-model", "Sub model from pi usage");
    assert.equal(rolled.caseRequests, 2, "Main 1 + Sub 1 requests");
    assert.ok(Math.abs(rolled.caseCost - 0.01) < 1e-9, `cost 0.01 got ${rolled.caseCost}`);
    console.log("ok: primary Main 70 + Sub 30 → Case 100 once");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Child usage survives running → completed / failed
// ---------------------------------------------------------------------------
{
  const dir = await mkdtemp(join(tmpdir(), "n4-487-status-"));
  try {
    const panel = new PanelAgentTracker("assess", "渗透大师");
    const { runtime, host } = await makeParent(dir, panel);
    const session = createFakeSession({
      usages: [{ input: 10, output: 5, totalTokens: 15, model: "m" }],
    });
    await host.spawn({
      assignment: "x",
      label: "x",
      subagentId: "sub_status",
      worker: async (ctx) => {
        const out = await runSubagentLlmSession({
          parent: runtime,
          subagentId: ctx.subagentId,
          workDir: ctx.workDir,
          assignment: ctx.assignment,
          handoff: handoff(),
          boundSessionFactory: async () => ({ session, segmentCounter: { tools: 0 } }),
        });
        return { ok: false, summary: "failed after usage", data: out.data };
      },
    });
    const child = childRow(panel, "sub_status");
    assert.equal(child?.status, "failed");
    assert.equal(Number(child?.usage?.total_tokens), 15, "usage kept on failed status");
    console.log("ok: child usage preserved on failed status");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Two Subs each included once
// ---------------------------------------------------------------------------
{
  const dir = await mkdtemp(join(tmpdir(), "n4-487-two-"));
  try {
    const panel = new PanelAgentTracker("assess", "渗透大师");
    const { runtime, host } = await makeParent(dir, panel);
    const mainUsage = new LlmUsageLedger();
    mainUsage.recordAssistantMessage({
      role: "assistant",
      usage: { input: 10, output: 10, totalTokens: 20 },
    });
    for (const [id, tokens] of [
      ["sub_a", 11],
      ["sub_b", 12],
    ] as const) {
      const session = createFakeSession({
        usages: [{ input: tokens, output: 0, totalTokens: tokens, model: "m" }],
      });
      await host.spawn({
        assignment: id,
        label: id,
        subagentId: id,
        worker: async (ctx) => {
          const out = await runSubagentLlmSession({
            parent: runtime,
            subagentId: ctx.subagentId,
            workDir: ctx.workDir,
            assignment: ctx.assignment,
            handoff: { ...handoff(), target: `http://t/${id}` },
            boundSessionFactory: async () => ({ session, segmentCounter: { tools: 0 } }),
          });
          return { ok: out.ok, summary: out.summary, data: out.data };
        },
      });
    }
    const kids = panel.list().filter((a) => a.parent_id);
    assert.equal(kids.length, 2);
    const tokens = kids.map((k) => Number(k.usage?.total_tokens)).sort((a, b) => a - b);
    assert.deepEqual(tokens, [11, 12]);
    const checkpoint = buildNode4Checkpoint({
      platform: runtime.platform,
      task: runtime.task,
      runtime,
      goals: runtime.goals,
      usage: mainUsage,
      panel,
      startedAt: "2026-01-01T00:00:00Z",
      rolePackId: "pentest",
      counters: { toolCallCount: 0, phase: "running" },
    });
    const rolled = applyCheckpointThroughPlatform(checkpoint);
    assert.equal(rolled.participant, 43, "20+11+12");
    assert.equal(rolled.caseTokens, 43);
    console.log("ok: two Subs each included once");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Warm resume is cumulative; unchanged re-emit is idempotent
// ---------------------------------------------------------------------------
{
  const dir = await mkdtemp(join(tmpdir(), "n4-487-warm-"));
  try {
    const panel = new PanelAgentTracker("assess", "渗透大师");
    const { runtime, host } = await makeParent(dir, panel);
    runtime.lifecycle.subagentIdlePool = new SubagentIdlePool({
      maxIdle: 4,
      ttlMs: 60_000,
      maxPackages: 4,
    });

    const session = createFakeSession({
      usages: [{ input: 20, output: 10, totalTokens: 30, model: "warm-m" }],
    });
    const first = await host.spawn({
      assignment: "p1",
      label: "p1",
      subagentId: "sub_warm",
      worker: async (ctx) => {
        const out = await runSubagentLlmSession({
          parent: runtime,
          subagentId: ctx.subagentId,
          workDir: ctx.workDir,
          assignment: ctx.assignment,
          handoff: handoff(),
          boundSessionFactory: async () => ({ session, segmentCounter: { tools: 0 } }),
        });
        return { ok: out.ok, summary: out.summary, data: out.data };
      },
    });
    assert.equal(Number(childRow(panel, "sub_warm")?.usage?.total_tokens), 30);
    const agentId = String((first.data as { agent_id?: string })?.agent_id || "sub_warm");
    const taken = runtime.lifecycle.subagentIdlePool.tryResume(agentId, {
      pathKey: pathKey("http://t/sqli"),
    });
    assert.equal(taken.ok, true, "warm handle parked");

    // Second package on same session: additional 20 tokens (cumulative 50).
    session.nextUsages = [{ input: 15, output: 5, totalTokens: 20, model: "warm-m" }];

    await host.spawn({
      assignment: "p2",
      label: "p2",
      subagentId: agentId,
      worker: async (ctx) => {
        const out = await runSubagentLlmSession({
          parent: runtime,
          subagentId: ctx.subagentId,
          workDir: taken.ok ? taken.handle.workDir : ctx.workDir,
          assignment: ctx.assignment,
          handoff: handoff("follow-up"),
          warmHandle: taken.ok ? taken.handle : undefined,
        });
        return { ok: out.ok, summary: out.summary, data: out.data };
      },
    });
    assert.equal(
      Number(childRow(panel, agentId)?.usage?.total_tokens),
      50,
      "warm resume is cumulative 30+20",
    );

    const mainUsage = new LlmUsageLedger();
    const checkpoint = buildNode4Checkpoint({
      platform: runtime.platform,
      task: runtime.task,
      runtime,
      goals: runtime.goals,
      usage: mainUsage,
      panel,
      startedAt: "2026-01-01T00:00:00Z",
      rolePackId: "pentest",
      counters: { toolCallCount: 0, phase: "running" },
    });
    const firstApply = applyCheckpointThroughPlatform(checkpoint);
    const secondApply = applyCheckpointThroughPlatform(checkpoint);
    assert.equal(firstApply.childTokens, 50);
    assert.equal(secondApply.childTokens, 50);
    assert.equal(firstApply.caseTokens, secondApply.caseTokens);
    console.log("ok: warm resume cumulative + idempotent re-emit");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Failed / interrupted packages keep provider-completed usage
// ---------------------------------------------------------------------------
{
  const dir = await mkdtemp(join(tmpdir(), "n4-487-fail-"));
  try {
    const panel = new PanelAgentTracker("assess", "渗透大师");
    const { runtime, host } = await makeParent(dir, panel);
    const session = createFakeSession({
      usages: [{ input: 8, output: 4, totalTokens: 12, model: "fail-m" }],
      afterEmit: "throw",
    });
    await host.spawn({
      assignment: "fail",
      label: "fail",
      subagentId: "sub_fail",
      worker: async (ctx) => {
        const out = await runSubagentLlmSession({
          parent: runtime,
          subagentId: ctx.subagentId,
          workDir: ctx.workDir,
          assignment: ctx.assignment,
          handoff: handoff(),
          boundSessionFactory: async () => ({ session, segmentCounter: { tools: 0 } }),
        });
        return { ok: out.ok, summary: out.summary, data: out.data };
      },
    });
    assert.equal(Number(childRow(panel, "sub_fail")?.usage?.total_tokens), 12);
    // Timeout shares this settlement tail (publishChildUsage after race, then park/release).
    console.log("ok: failed package keeps provider usage");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

{
  const dir = await mkdtemp(join(tmpdir(), "n4-487-abort-"));
  try {
    const panel = new PanelAgentTracker("assess", "渗透大师");
    const { runtime, host } = await makeParent(dir, panel);
    const ac = new AbortController();
    runtime.lifecycle.abortSignal = ac.signal;
    const session = createFakeSession({
      usages: [{ input: 6, output: 3, totalTokens: 9, model: "int-m" }],
    });
    const origPrompt = session.prompt.bind(session);
    session.prompt = async (text, opts) => {
      await origPrompt(text, opts);
      ac.abort();
    };
    await host.spawn({
      assignment: "int",
      label: "int",
      subagentId: "sub_int",
      worker: async (ctx) => {
        const out = await runSubagentLlmSession({
          parent: runtime,
          subagentId: ctx.subagentId,
          workDir: ctx.workDir,
          assignment: ctx.assignment,
          handoff: handoff(),
          abortSignal: ac.signal,
          boundSessionFactory: async () => ({ session, segmentCounter: { tools: 0 } }),
        });
        return { ok: out.ok, summary: out.summary, data: out.data };
      },
    });
    assert.equal(Number(childRow(panel, "sub_int")?.usage?.total_tokens), 9);
    console.log("ok: interrupted package keeps received usage");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Cancel before dispatch → zero; shell-only → no LLM usage
// ---------------------------------------------------------------------------
{
  const dir = await mkdtemp(join(tmpdir(), "n4-487-cancel-"));
  try {
    const panel = new PanelAgentTracker("assess", "渗透大师");
    const { runtime, host } = await makeParent(dir, panel);
    const ac = new AbortController();
    ac.abort();
    runtime.lifecycle.abortSignal = ac.signal;
    const session = createFakeSession({ afterEmit: "nothing" });
    await host.spawn({
      assignment: "cancel",
      label: "cancel",
      subagentId: "sub_cancel",
      worker: async (ctx) => {
        const out = await runSubagentLlmSession({
          parent: runtime,
          subagentId: ctx.subagentId,
          workDir: ctx.workDir,
          assignment: ctx.assignment,
          handoff: handoff(),
          abortSignal: ac.signal,
          boundSessionFactory: async () => ({ session, segmentCounter: { tools: 0 } }),
        });
        return { ok: out.ok, summary: out.summary, data: out.data };
      },
    });
    const child = childRow(panel, "sub_cancel") as { usage?: { total_tokens?: number; requests?: number } };
    assert.equal(session.prompted, false, "already-aborted package must not prompt");
    assert.ok(child?.usage, "LLM session publishes a usage snapshot even when zero");
    assert.equal(Number(child.usage?.total_tokens || 0), 0);
    assert.equal(Number(child.usage?.requests || 0), 0);
    console.log("ok: cancel before dispatch reports zero");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

{
  const dir = await mkdtemp(join(tmpdir(), "n4-487-shell-"));
  try {
    const panel = new PanelAgentTracker("assess", "渗透大师");
    const { host } = await makeParent(dir, panel);
    await host.spawn({
      assignment: "shell only",
      label: "shell only",
      subagentId: "sub_shell",
      worker: async () => ({
        ok: true,
        summary: "echo ok",
        data: { kind: "shell", stdout: "ok" },
      }),
    });
    const child = childRow(panel, "sub_shell") as { usage?: unknown; llm_usage?: unknown };
    assert.equal(child?.usage, undefined, "shell-only has no LLM usage field");
    assert.equal(child?.llm_usage, undefined);
    console.log("ok: shell-only package has no LLM usage");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Hard release disposes child usage subscription; parking does not
// ---------------------------------------------------------------------------
{
  const session = createFakeSession({
    usages: [{ input: 4, output: 1, totalTokens: 5, model: "park-m" }],
  });
  const meter = attachChildSessionUsage({ session });
  const handle: IdleSubagentHandle = {
    agentId: "sub_disp",
    pathKey: pathKey("http://t/sqli"),
    session: session as IdleSubagentHandle["session"],
    workDir: "/tmp/disp",
    segmentCounter: { tools: 0 },
    packagesCompleted: 1,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    usageMeter: meter,
  };
  const pool = new SubagentIdlePool({ maxIdle: 4, ttlMs: 60_000, maxPackages: 4 });
  pool.park(handle);
  assert.ok(session.listenerCount() >= 1, "park keeps usage subscription");
  await session.prompt("parked");
  assert.equal(meter.snapshot().total_tokens, 5, "parked meter still records");
  await pool.release("sub_disp");
  assert.equal(session.listenerCount(), 0, "hard release unsubscribes usage observer");
  session.nextUsages = [{ input: 99, output: 1, totalTokens: 100, model: "late" }];
  await session.prompt("late");
  assert.equal(meter.snapshot().total_tokens, 5, "released meter ignores later events");
  console.log("ok: hard release disposes usage subscription; park retains it");
}

console.log("subagent-usage-metering.test.ts: ok");
