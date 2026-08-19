/**
 * Spec #493: Worker return harvest + no auto Finding Store ingest.
 * Run: npx tsx src/runtime/worker-return.test.ts
 */
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoalStore } from "../stores/goal.js";
import { EvidenceStore } from "../stores/evidence.js";
import { TodoStore } from "../stores/todo.js";
import type { PlatformMessage, TaskEnvelope, ToolRuntime } from "../types.js";
import type { Node4AgentSession } from "./run-node4-agent.js";
import { FindingStore, ingestPackageCandidatesToStore } from "./finding-store.js";
import { ingestWorkerReturnCandidates } from "../tools/subagent.js";
import { runSubagentLlmSession } from "./subagent-session.js";
import type { SubagentHandoffFields } from "./subagent-handoff.js";

delete process.env.NODE4_SUBAGENT_DRY;
process.env.NODE4_SUBAGENT_IDLE = "1";

function handoff(goal = "ping"): SubagentHandoffFields {
  return {
    target: "http://t/ping",
    scope: "t",
    already_done: "none",
    this_turn_goal: goal,
    success_criteria: "pong",
  };
}

function createFakeSession(opts: {
  text?: string;
  afterEmit?: "ok" | "throw";
}): Node4AgentSession {
  const listeners: Array<(event: any) => void | Promise<void>> = [];
  const storedMessages: unknown[] = [];
  const text = opts.text ?? "**pong** ✅";
  return {
    subscribe(listener) {
      listeners.push(listener);
      return () => {
        const i = listeners.indexOf(listener);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    async prompt() {
      const message = {
        role: "assistant",
        content: [{ type: "text", text }],
        usage: { input: 2, output: 1, totalTokens: 3 },
      };
      storedMessages.push(message);
      for (const l of listeners) {
        await l({ type: "message_end", message });
      }
      if (opts.afterEmit === "throw") throw new Error("provider failed after usage");
    },
    abort() {},
    dispose() {},
    steer() {},
    followUp() {},
    get messages() {
      return storedMessages;
    },
  } as Node4AgentSession;
}

async function makeParent(dir: string): Promise<{
  runtime: ToolRuntime;
  messages: PlatformMessage[];
}> {
  const messages: PlatformMessage[] = [];
  const task = {
    taskId: "t-493",
    conversationId: "c-493",
    instruction: "ping",
    expertId: "e2",
    expertName: "渗透大师",
    target: { url: "http://t/ping" },
    scope: {},
  } as unknown as TaskEnvelope;
  const runtime = {
    task,
    workspaceDir: dir,
    piDir: dir,
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
    },
  } as ToolRuntime;
  return { runtime, messages };
}

{
  const dir = await mkdtemp(join(tmpdir(), "n4-493-pong-"));
  try {
    const { runtime, messages } = await makeParent(dir);
    const session = createFakeSession({ text: "**pong** ✅" });
    await writeFile(
      join(dir, "settlement.json"),
      JSON.stringify({
        ok: true,
        summary: "file must not be the SoT",
        candidates: [
          {
            title: "salvage SQLi",
            location: "http://t/login",
            claim: "error-based",
            severity: "high",
            proof_excerpt: "SQL syntax error near quote — leftover settlement file",
          },
        ],
      }),
    );
    const out = await runSubagentLlmSession({
      parent: runtime,
      subagentId: "sub_pong",
      workDir: dir,
      assignment: "reply pong",
      handoff: handoff(),
      boundSessionFactory: async () => ({ session, segmentCounter: { tools: 0 } }),
    });
    assert.equal(out.ok, true, "last-turn ping/pong is success without settlement files as SoT");
    assert.match(out.summary, /pong/);
    assert.equal(out.structured.candidates.length, 0, "salvage candidates are not the main result");
    const delivery = messages.find((m) => m.type === "worker_package_delivery") as
      | { status?: string; summary?: string }
      | undefined;
    assert.equal(delivery?.status, "ok");
    assert.match(String(delivery?.summary || ""), /pong/);
    assert.doesNotMatch(
      String(delivery?.summary || ""),
      /without intentional structured settlement/i,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

{
  const dir = await mkdtemp(join(tmpdir(), "n4-493-yield-err-"));
  try {
    const { runtime } = await makeParent(dir);
    const session = createFakeSession({ text: "I could not reach the host" });
    const out = await runSubagentLlmSession({
      parent: runtime,
      subagentId: "sub_err",
      workDir: dir,
      assignment: "fail",
      handoff: handoff("reach host"),
      boundSessionFactory: async ({ runtime: childRt }) => {
        childRt.lifecycle.workerYield = { status: "error", error: "timeout talking to target" };
        return { session, segmentCounter: { tools: 0 } };
      },
    });
    assert.equal(out.ok, false, "yield error → failed");
    assert.match(out.summary, /timeout talking to target/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

{
  const dir = await mkdtemp(join(tmpdir(), "n4-493-abort-"));
  try {
    const { runtime, messages } = await makeParent(dir);
    const ac = new AbortController();
    runtime.lifecycle.abortSignal = ac.signal;
    const session = createFakeSession({ text: "partial" });
    const origPrompt = session.prompt.bind(session);
    session.prompt = async (text, opts) => {
      await origPrompt(text, opts);
      ac.abort();
    };
    const out = await runSubagentLlmSession({
      parent: runtime,
      subagentId: "sub_abort",
      workDir: dir,
      assignment: "int",
      handoff: handoff(),
      abortSignal: ac.signal,
      boundSessionFactory: async () => ({ session, segmentCounter: { tools: 0 } }),
    });
    assert.equal(out.ok, false, "abort is not success");
    const delivery = messages.find((m) => m.type === "worker_package_delivery") as
      | { status?: string }
      | undefined;
    assert.equal(delivery?.status, "interrupted");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

{
  const store = new FindingStore();
  const salvage = [
    {
      title: "salvage SQLi",
      location: "http://t/login",
      claim: "error-based",
      severity: "high" as const,
      proof_excerpt: "SQL syntax error near quote — leftover salvage candidate",
    },
  ];
  const skipped = ingestWorkerReturnCandidates(store, salvage);
  assert.equal(skipped.skipped, true);
  assert.deepEqual(skipped.ids, []);
  assert.equal(store.snapshot().length, 0, "Worker return must not auto-ingest salvage candidates");

  const control = new FindingStore();
  ingestPackageCandidatesToStore(control, salvage, {
    package_id: "sub_salvage",
    plan_node_id: "todo-sqli",
    agent_id: "sub_salvage",
  });
  assert.ok(control.snapshot().length >= 1, "control: ingest helper still works when Main books");
}

console.log("worker-return.test.ts: ok");
