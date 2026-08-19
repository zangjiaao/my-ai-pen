/**
 * Spec #283 (I0.9): Working session continue after interrupt — primary seam tests W1–W10.
 * Run: npx tsx src/runtime/working-session-park.test.ts
 */
import assert from "node:assert/strict";
import { TodoStore } from "../stores/todo.js";
import type { Node4AgentSession } from "./run-node4-agent.js";
import {
  applyCaptainEndDisposition,
  clearPendingDisposeForTests,
  clearWorkingSessionParksForTests,
  countParkedSessionsForTests,
  decideAttachOnContinue,
  decideCaptainEndDisposition,
  decideParkOnEnd,
  DEFAULT_PARK_TTL_MS,
  disposeWorkingSession,
  disposeWorkingSessionsForCase,
  dropParkedSession,
  harnessStatusAfterParkedContinue,
  isParkExpired,
  markPendingSessionDispose,
  parkNeedsAgentReseed,
  parkSessionKey,
  parkWorkingSession,
  parkedSessionHasHistory,
  parkedTodoNonEmpty,
  peekParkedSession,
  resetWorkingSessionMemory,
  resolveWorkingSessionContinue,
  takeParkedSession,
  type ParkedWorkingRuntime,
} from "./working-session-park.js";
import {
  clearRegisteredIdlePoolsForTests,
  SubagentIdlePool,
  type IdleSubagentHandle,
} from "./subagent-idle-pool.js";
import type { ToolRuntime } from "../types.js";
import {
  isContinueInEnvelopeExecution,
  parseGraphExecution,
  resolveExpertWorkPath,
} from "./hard-graph-definition.js";

clearWorkingSessionParksForTests();

// --- pure key / TTL ---
assert.equal(parkSessionKey("c1", "exp1"), "c1::exp1");
assert.equal(parkSessionKey("c1", ""), "c1");
assert.equal(parkSessionKey("c1"), "c1");
assert.equal(parkSessionKey(""), "");

// Spec #354 L2: default TTL disabled (0) → never product-expire
assert.equal(DEFAULT_PARK_TTL_MS, 0);
assert.equal(isParkExpired({ parkedAt: 1000 }, 1000 + 999_999_999), false);
// Explicit positive TTL still expires
const TEST_TTL_MS = 30 * 60 * 1000;
assert.equal(isParkExpired({ parkedAt: 1000 }, 1000 + TEST_TTL_MS + 1, TEST_TTL_MS), true);
assert.equal(isParkExpired({ parkedAt: 1000 }, 1000 + TEST_TTL_MS - 1, TEST_TTL_MS), false);

// --- decideCaptainEndDisposition / decideParkOnEnd (Spec #354 Session owns runtime) ---
assert.deepEqual(decideCaptainEndDisposition({ aborted: true }), {
  disposition: "park",
  reason: "interrupted",
});
assert.deepEqual(
  decideCaptainEndDisposition({ aborted: false, productTerminal: false }),
  { disposition: "park", reason: "incomplete" },
  "incomplete mid-work re-parks (not dispose)",
);
// Spec #354: productTerminal alone must NOT dispose (Task package ≠ Session death)
assert.deepEqual(
  decideCaptainEndDisposition({ aborted: false, productTerminal: true }),
  { disposition: "park", reason: "incomplete" },
  "package complete does not dispose captain",
);
// abort parks even when legacy productTerminal flag is set
assert.deepEqual(
  decideCaptainEndDisposition({ aborted: true, productTerminal: true }),
  { disposition: "park", reason: "interrupted" },
);
// Explicit dispose whitelist
assert.deepEqual(
  decideCaptainEndDisposition({ aborted: false, disposeReason: "case_close" }),
  { disposition: "dispose", reason: "case_close" },
);
assert.deepEqual(
  decideCaptainEndDisposition({ aborted: false, disposeReason: "session_delete" }),
  { disposition: "dispose", reason: "session_delete" },
);
assert.deepEqual(decideParkOnEnd({ aborted: true }), {
  disposition: "park",
  reason: "interrupted",
});
assert.deepEqual(decideParkOnEnd({ aborted: false }), {
  disposition: "park",
  reason: "incomplete",
}, "Spec #354: package settle parks, does not dispose");
assert.deepEqual(decideParkOnEnd({ aborted: true, expertTransfer: true }), {
  disposition: "dispose",
  reason: "expert_transfer",
});
assert.deepEqual(decideParkOnEnd({ aborted: false, disposeReason: "manual_end" }), {
  disposition: "dispose",
  reason: "manual_end",
});

// harnessStatusAfterParkedContinue
assert.equal(
  harnessStatusAfterParkedContinue({
    aborted: false,
    workMode: "graph",
    openTodoCount: 0,
  }),
  "incomplete",
  "Graph never product-complete from mini-runner alone",
);
assert.equal(
  harnessStatusAfterParkedContinue({
    aborted: false,
    workMode: "free",
    openTodoCount: 2,
  }),
  "incomplete",
);
assert.equal(
  harnessStatusAfterParkedContinue({
    aborted: false,
    workMode: "free",
    openTodoCount: 0,
  }),
  "completed",
);

// --- decideAttachOnContinue ---
assert.deepEqual(
  decideAttachOnContinue({
    hasPark: true,
    parkExpired: false,
    parkWorkMode: "graph",
    sessionWorkMode: "graph",
  }),
  { action: "attach" },
);
assert.deepEqual(
  decideAttachOnContinue({
    hasPark: false,
    parkExpired: false,
    sessionWorkMode: "graph",
  }),
  { action: "reseed", reason: "miss" },
);
assert.deepEqual(
  decideAttachOnContinue({
    hasPark: true,
    parkExpired: true,
    parkWorkMode: "graph",
    sessionWorkMode: "graph",
  }),
  { action: "reseed", reason: "ttl_expired" },
);
assert.deepEqual(
  decideAttachOnContinue({
    hasPark: true,
    parkExpired: false,
    parkWorkMode: "graph",
    sessionWorkMode: "free",
  }),
  { action: "reseed", reason: "mode_mismatch" },
);
// W5: C1 free-in-envelope must not attach Graph park as resume
assert.deepEqual(
  decideAttachOnContinue({
    hasPark: true,
    parkExpired: false,
    parkWorkMode: "graph",
    sessionWorkMode: "graph",
    continueInEnvelope: true,
  }),
  { action: "reseed", reason: "c1_continue" },
);

function fakeSession(messages: unknown[] = [{ role: "user", content: "hi" }]): Node4AgentSession {
  const msgs = [...messages];
  const prompts: string[] = [];
  return {
    prompt: async (text: string) => {
      prompts.push(text);
      msgs.push({ role: "user", content: text });
      msgs.push({ role: "assistant", content: "ok" });
    },
    abort: () => {},
    dispose: () => {},
    subscribe: () => () => {},
    steer: () => {},
    followUp: () => {},
    get messages() {
      return msgs;
    },
    // test helper
    _prompts: prompts,
  } as Node4AgentSession & { _prompts: string[] };
}

function makeParked(overrides: Partial<ParkedWorkingRuntime> = {}): ParkedWorkingRuntime {
  const todo = overrides.todo ?? new TodoStore();
  if (!overrides.todo) {
    todo.apply({
      op: "init",
      list: [{ phase: "Stage", items: ["Probe login", "Map APIs"] }],
    });
  }
  const disposed: { n: number } = { n: 0 };
  return {
    conversationId: "conv-w",
    expertId: "pentest",
    workMode: "graph",
    graphId: "app_assessment",
    stageId: "recon",
    taskId: "t-old",
    session: fakeSession(),
    todo,
    accounts: [{ username: "admin", password: "hacked" }],
    parkedAt: Date.now(),
    dispose: () => {
      disposed.n += 1;
    },
    ...overrides,
  };
}

// ========== W1: Graph stage captain interrupt → continue attaches same runtime ==========
{
  clearWorkingSessionParksForTests();
  const session = fakeSession([
    { role: "user", content: "start" },
    { role: "assistant", content: "working recon" },
  ]);
  const entry = makeParked({ session, workMode: "graph", stageId: "recon" });
  // interrupt → park
  assert.equal(decideParkOnEnd({ aborted: true }).disposition, "park");
  parkWorkingSession(entry);
  assert.equal(countParkedSessionsForTests(), 1);

  // continue (not C1) → attach same session object
  const cont = resolveWorkingSessionContinue({
    conversationId: "conv-w",
    expertId: "pentest",
    sessionWorkMode: "graph",
    continueInEnvelope: false,
  });
  assert.equal(cont.action, "attach", "W1: attach parked graph captain");
  if (cont.action !== "attach") throw new Error("expected attach");
  assert.equal(cont.entry.session, session, "W1: same runtime object");
  assert.equal(cont.entry.workMode, "graph");
  assert.equal(cont.entry.stageId, "recon");
  assert.ok(parkedSessionHasHistory(cont.entry), "W1: history present");
  // not Free cold OMP path: work mode graph + attach
  const resumePath = resolveExpertWorkPath({
    hardMode: "hard",
    graphIntent: "app_assessment",
    chatOnly: false,
    continueInEnvelope: isContinueInEnvelopeExecution({
      graphExecution: parseGraphExecution({ graph_execution: "resume" }),
    }),
  });
  assert.equal(resumePath.path, "hard", "W1: mode path stays Hard (#282), attach is I0.9");
  assert.equal(countParkedSessionsForTests(), 0, "taken out of park");
}

// ========== W2: todos not wiped solely by continue ==========
{
  clearWorkingSessionParksForTests();
  const todo = new TodoStore();
  todo.apply({
    op: "init",
    list: [{ phase: "Recon", items: ["Enumerate hosts", "Check auth"] }],
  });
  assert.ok(todo.openCount() >= 1);
  parkWorkingSession(makeParked({ todo, workMode: "graph" }));
  const cont = resolveWorkingSessionContinue({
    conversationId: "conv-w",
    expertId: "pentest",
    sessionWorkMode: "graph",
  });
  assert.equal(cont.action, "attach");
  if (cont.action !== "attach") throw new Error("expected attach");
  assert.ok(parkedTodoNonEmpty(cont.entry), "W2: todos non-empty after attach");
  assert.equal(cont.entry.todo.openCount(), todo.openCount());
  assert.deepEqual(
    cont.entry.todo.snapshot()[0]?.tasks.map((t) => t.content),
    ["Enumerate hosts", "Check auth"],
  );
}

// ========== W3: credential/login intent still available ==========
{
  clearWorkingSessionParksForTests();
  const accounts = [{ username: "admin", password: "s3cret", note: "login intent" }];
  parkWorkingSession(makeParked({ accounts, workMode: "graph" }));
  const cont = resolveWorkingSessionContinue({
    conversationId: "conv-w",
    expertId: "pentest",
    sessionWorkMode: "graph",
  });
  assert.equal(cont.action, "attach");
  if (cont.action !== "attach") throw new Error("expected attach");
  assert.deepEqual(cont.entry.accounts, accounts, "W3: accounts retained on park");
}

// ========== W4: Free Main park + attach (not Graph-only) ==========
{
  clearWorkingSessionParksForTests();
  const session = fakeSession([{ role: "user", content: "free work" }]);
  const entry = makeParked({
    conversationId: "conv-free",
    expertId: "pentest",
    workMode: "free",
    graphId: undefined,
    stageId: undefined,
    session,
  });
  parkWorkingSession(entry);
  const cont = resolveWorkingSessionContinue({
    conversationId: "conv-free",
    expertId: "pentest",
    sessionWorkMode: "free",
  });
  assert.equal(cont.action, "attach", "W4: Free Main attaches");
  if (cont.action !== "attach") throw new Error("expected attach");
  assert.equal(cont.entry.workMode, "free");
  assert.equal(cont.entry.session, session);
}

// ========== W5: Graph completed C1 still free-in-envelope; no park attach as Hard ==========
{
  clearWorkingSessionParksForTests();
  // Simulate leftover park should not hijack C1
  parkWorkingSession(makeParked({ workMode: "graph" }));
  const c1 = isContinueInEnvelopeExecution({
    graphExecution: parseGraphExecution({ graph_execution: "continue" }),
  });
  assert.equal(c1, true);
  const workPath = resolveExpertWorkPath({
    hardMode: "hard",
    graphIntent: "app_assessment",
    chatOnly: false,
    continueInEnvelope: c1,
  });
  assert.equal(workPath.path, "free", "W5: C1 free-in-envelope");
  const cont = resolveWorkingSessionContinue({
    conversationId: "conv-w",
    expertId: "pentest",
    sessionWorkMode: "graph",
    continueInEnvelope: true,
  });
  assert.equal(cont.action, "reseed");
  if (cont.action !== "reseed") throw new Error("expected reseed");
  assert.equal(cont.reason, "c1_continue", "W5: do not attach Graph park on C1");
  assert.equal(
    countParkedSessionsForTests(),
    0,
    "W5/Issue9: C1 drops Graph park",
  );
  // Free park also dropped on C1 (predictable; no surprise Free attach later)
  clearWorkingSessionParksForTests();
  parkWorkingSession(
    makeParked({
      conversationId: "conv-c1-free",
      expertId: "pentest",
      workMode: "free",
    }),
  );
  resolveWorkingSessionContinue({
    conversationId: "conv-c1-free",
    expertId: "pentest",
    sessionWorkMode: "free",
    continueInEnvelope: true,
  });
  assert.equal(
    countParkedSessionsForTests(),
    0,
    "W5/Issue9: C1 drops Free park too",
  );
}

// ========== W6: park miss → mode-correct Graph reseed, not Free demotion ==========
{
  clearWorkingSessionParksForTests();
  const cont = resolveWorkingSessionContinue({
    conversationId: "conv-miss",
    expertId: "pentest",
    sessionWorkMode: "graph",
  });
  assert.equal(cont.action, "reseed");
  if (cont.action !== "reseed") throw new Error("expected reseed");
  assert.equal(cont.reason, "miss", "W6: miss");
  // #282 wire: resume → Hard
  const resumePath = resolveExpertWorkPath({
    hardMode: "hard",
    graphIntent: "app_assessment",
    chatOnly: false,
    continueInEnvelope: false,
  });
  assert.equal(resumePath.path, "hard", "W6: reseed stays Hard / Graph mode");
  assert.notEqual(resumePath.path, "free");
}

// ========== W7: idle interrupt — no park; continue by Session mode ==========
{
  clearWorkingSessionParksForTests();
  // idle: nothing to park
  assert.equal(countParkedSessionsForTests(), 0);
  const freeCont = resolveWorkingSessionContinue({
    conversationId: "idle-c",
    expertId: "pentest",
    sessionWorkMode: "free",
  });
  assert.equal(freeCont.action, "reseed");
  if (freeCont.action !== "reseed") throw new Error("expected reseed");
  assert.equal(freeCont.reason, "miss");
  // Free session mode stay free path
  const freePath = resolveExpertWorkPath({
    hardMode: "not_hard",
    graphIntent: null,
    chatOnly: false,
    continueInEnvelope: false,
  });
  assert.equal(freePath.path, "free", "W7: Free Session continue free");
}

// ========== W8: package settle parks (Spec #354); steer ≠ park path ==========
{
  clearWorkingSessionParksForTests();
  // Mid-run steer does not park by itself; package settle disposition is park.
  const d = decideParkOnEnd({ aborted: false });
  assert.equal(d.disposition, "park", "W8/#354: non-interrupt package settle parks");
  // Active-session steer is separate registry; park count stays 0 during busy steer
  assert.equal(countParkedSessionsForTests(), 0);
}

// ========== W9: Park TTL — Spec #354 L2 default is no product idle reclaim ==========
{
  clearWorkingSessionParksForTests();
  // Default TTL is disabled (0). Explicit positive TTL still expires for tests / ops.
  const old = Date.now() - 60_000;
  parkWorkingSession(makeParked({ parkedAt: old, workMode: "graph" }));
  const contDefault = resolveWorkingSessionContinue({
    conversationId: "conv-w",
    expertId: "pentest",
    sessionWorkMode: "graph",
    now: Date.now(),
  });
  assert.equal(contDefault.action, "attach", "W9/#354: default TTL does not expire park");
  clearWorkingSessionParksForTests();
  parkWorkingSession(makeParked({ parkedAt: old, workMode: "graph" }));
  const cont = resolveWorkingSessionContinue({
    conversationId: "conv-w",
    expertId: "pentest",
    sessionWorkMode: "graph",
    now: Date.now(),
    ttlMs: 30_000,
  });
  assert.equal(cont.action, "reseed");
  if (cont.action !== "reseed") throw new Error("expected reseed");
  assert.equal(cont.reason, "ttl_expired", "W9: explicit TTL still works");
  // mode-correct reseed still Graph path
  assert.equal(
    resolveExpertWorkPath({
      hardMode: "hard",
      graphIntent: "app_assessment",
      chatOnly: false,
      continueInEnvelope: false,
    }).path,
    "hard",
    "W9: mode preserved as Graph/Hard on reseed",
  );
  assert.equal(countParkedSessionsForTests(), 0, "expired park dropped");
}

// ========== W10: Explicit composer Graph after Free may enter Graph; park rules intact ==========
{
  clearWorkingSessionParksForTests();
  // Free park exists
  parkWorkingSession(
    makeParked({
      conversationId: "conv-w10",
      expertId: "pentest",
      workMode: "free",
    }),
  );
  // User explicit Graph this turn → sessionWorkMode graph; Free park is mode_mismatch → reseed Graph
  const cont = resolveWorkingSessionContinue({
    conversationId: "conv-w10",
    expertId: "pentest",
    sessionWorkMode: "graph",
  });
  assert.equal(cont.action, "reseed");
  if (cont.action !== "reseed") throw new Error("expected reseed");
  assert.equal(cont.reason, "mode_mismatch", "W10: Free park not forced onto Graph");
  assert.equal(
    resolveExpertWorkPath({
      hardMode: "hard",
      graphIntent: "app_assessment",
      chatOnly: false,
      continueInEnvelope: false,
    }).path,
    "hard",
    "W10: explicit Graph enters Hard",
  );
}

// --- registry: take / peek / replace dispose ---
{
  clearWorkingSessionParksForTests();
  let disposed = 0;
  const a = makeParked({
    conversationId: "r1",
    expertId: "e1",
    dispose: () => {
      disposed += 1;
    },
  });
  parkWorkingSession(a);
  assert.ok(peekParkedSession("r1", "e1"));
  const taken = takeParkedSession("r1", "e1");
  assert.equal(taken.ok, true);
  assert.equal(peekParkedSession("r1", "e1"), undefined);

  // replace parks disposes previous
  parkWorkingSession(
    makeParked({
      conversationId: "r2",
      expertId: "e2",
      dispose: () => {
        disposed += 1;
      },
    }),
  );
  parkWorkingSession(
    makeParked({
      conversationId: "r2",
      expertId: "e2",
      dispose: () => {},
    }),
  );
  assert.ok(disposed >= 1, "prior park disposed on replace");
  clearWorkingSessionParksForTests();
}

// #282 wire rules stay green (resume vs C1)
assert.equal(parseGraphExecution({ graph_execution: "resume" }), "resume");
assert.equal(
  isContinueInEnvelopeExecution({
    graphExecution: parseGraphExecution({ graph_execution: "resume" }),
  }),
  false,
);
assert.equal(
  isContinueInEnvelopeExecution({
    graphExecution: parseGraphExecution({ graph_execution: "continue" }),
  }),
  true,
);

// --- runParkedWorkingContinue: re-park on incomplete (Issue 1/2 multi-turn W1) ---
{
  clearWorkingSessionParksForTests();
  const { runParkedWorkingContinue } = await import("./run-parked-working-continue.js");
  const { PanelAgentTracker } = await import("./panel-agents.js");
  const todo = new TodoStore();
  todo.apply({
    op: "init",
    list: [{ phase: "Work", items: ["Keep this todo"] }],
  });
  const session = fakeSession([
    { role: "user", content: "prior" },
    { role: "assistant", content: "prior reply" },
  ]);
  let disposed = 0;
  // Simulate prior interrupt: panel left in stopped/aborted before park attach.
  const priorPanel = new PanelAgentTracker("prior aborted task", "渗透大师");
  priorPanel.setMainTerminal("aborted");
  assert.equal(priorPanel.list()[0]?.status, "stopped");
  const parked = makeParked({
    conversationId: "conv-run",
    expertId: "pentest",
    workMode: "graph",
    stageId: "recon",
    session,
    todo,
    dispose: () => {
      disposed += 1;
    },
    runtime: {
      lifecycle: { panelAgents: priorPanel },
      findingsDir: "/tmp/node4-park-test/findings-missing",
    } as any,
  });
  const sent: unknown[] = [];
  const platform = {
    send: async (m: unknown) => {
      sent.push(m);
    },
  };
  const cfg = {
    workspaceDir: "/tmp/node4-park-test",
    modelProvider: "openai",
    modelId: "x",
  } as any;

  // Turn 1 after interrupt
  const out1 = await runParkedWorkingContinue({
    config: cfg,
    platform: platform as any,
    task: {
      taskId: "t-new-1",
      conversationId: "conv-run",
      expertId: "pentest",
      instruction: "继续",
      target: { type: "url", value: "https://lab.example/" },
      scope: { allow: [] },
      accounts: [{ username: "admin" }],
    },
    parked,
  });
  assert.equal(out1.attached, true);
  assert.equal(out1.sameRuntime, true);
  assert.equal(out1.workMode, "graph");
  assert.equal(out1.terminalStatus, "incomplete", "Graph continue stays incomplete");
  assert.equal(out1.reparked, true, "Issue1: re-park after natural settle");
  assert.equal(disposed, 0, "Issue1: dispose must not run on incomplete Graph continue");
  assert.ok(session.messages.some((m: any) => m?.content === "继续"), "continue text prompted");
  // Spec #455 S2/S3: park-hit prompts utterance only — no engagement-book / case_context block.
  const prompted = session.messages.filter((m: any) => m?.role === "user").map((m: any) => String(m?.content || ""));
  assert.ok(
    prompted.every((t) => t === "继续" || t === "prior"),
    "park continue must not rewrap prior instruction or inject case_context into turn body",
  );
  assert.ok(
    !prompted.some((t) => t.includes("User continuation:") || t.includes("Case evidence") || t.includes("### User message")),
    "park-hit turn body stays thin (no cold first-turn rebuild)",
  );
  assert.ok(todo.openCount() >= 1, "todos not wiped by continue runner");
  assert.ok(
    sent.some((m: any) => m?.type === "task_start" && m?.parked_continue === true),
    "task_start marks parked_continue",
  );
  assert.ok(
    sent.some(
      (m: any) =>
        m?.type === "task_start" && m?.parked_continue === true && m?.session_continue === true,
    ),
    "Spec #455: park task_start also marks session_continue",
  );
  assert.ok(
    sent.some(
      (m: any) => m?.type === "task_complete" && m?.session_continue === true && m?.parked_continue === true,
    ),
    "Spec #455: park settle carries session_continue for package status copy",
  );
  const startPanel = (sent.find((m: any) => m?.type === "task_start") as any)?.panel_agents?.[0];
  assert.equal(
    startPanel?.status,
    "running",
    "park attach must not leave AgentRow status stopped",
  );
  const complete1 = sent.find((m: any) => m?.type === "task_complete") as any;
  assert.ok(complete1, "task_complete emitted");
  assert.ok(
    Array.isArray(complete1.workset_candidates),
    "Spec #311: parked continue emits workset_candidates (even if empty)",
  );
  assert.ok(
    Array.isArray(complete1.attack_surface_candidates),
    "parked continue emits attack_surface_candidates for Goal settle seam",
  );
  assert.ok(
    sent.some((m: any) => m?.type === "todo_updated" && m?.parked_continue === true),
    "Issue5: todo re-emitted under new task_id",
  );
  assert.ok(
    sent.some((m: any) => m?.type === "plan_tree_updated"),
    "Issue5: plan_tree re-projected",
  );
  assert.ok(peekParkedSession("conv-run", "pentest"), "captain still parked after turn 1");

  // Turn 2: multi-continue without new interrupt — same session object
  const cont2 = resolveWorkingSessionContinue({
    conversationId: "conv-run",
    expertId: "pentest",
    sessionWorkMode: "graph",
  });
  assert.equal(cont2.action, "attach", "W1 multi-turn: second continue attaches");
  if (cont2.action !== "attach") throw new Error("expected attach");
  assert.equal(cont2.entry.session, session, "W1 multi-turn: same runtime object");
  assert.ok(parkedTodoNonEmpty(cont2.entry), "todos still present for turn 2");

  const out2 = await runParkedWorkingContinue({
    config: cfg,
    platform: platform as any,
    task: {
      taskId: "t-new-2",
      conversationId: "conv-run",
      expertId: "pentest",
      instruction: "再继续",
      target: { type: "url", value: "https://lab.example/" },
      scope: { allow: [] },
    },
    parked: cont2.entry,
  });
  assert.equal(out2.sameRuntime, true);
  assert.equal(out2.reparked, true);
  assert.equal(disposed, 0, "still not disposed after turn 2");
  assert.ok(
    session.messages.some((m: any) => m?.content === "再继续"),
    "second continue prompted on same session",
  );
  clearWorkingSessionParksForTests();
}

// Free mid-work with open todos also re-parks
{
  clearWorkingSessionParksForTests();
  const { runParkedWorkingContinue } = await import("./run-parked-working-continue.js");
  const todo = new TodoStore();
  todo.apply({
    op: "init",
    list: [{ phase: "T", items: ["still open"] }],
  });
  let disposed = 0;
  const session = fakeSession();
  const out = await runParkedWorkingContinue({
    config: { workspaceDir: "/tmp/node4-park-test", modelProvider: "openai", modelId: "x" } as any,
    platform: { send: async () => {} } as any,
    task: {
      taskId: "tf1",
      conversationId: "conv-free-mid",
      expertId: "pentest",
      instruction: "继续",
      target: { type: "url", value: "https://lab.example/" },
      scope: { allow: [] },
    },
    parked: makeParked({
      conversationId: "conv-free-mid",
      expertId: "pentest",
      workMode: "free",
      session,
      todo,
      dispose: () => {
        disposed += 1;
      },
    }),
  });
  assert.equal(out.terminalStatus, "incomplete");
  assert.equal(out.reparked, true);
  assert.equal(disposed, 0);
  assert.ok(peekParkedSession("conv-free-mid", "pentest"));
  clearWorkingSessionParksForTests();
}

// Free package complete (no open todos) still parks — Spec #354 Session owns runtime
{
  clearWorkingSessionParksForTests();
  const { runParkedWorkingContinue } = await import("./run-parked-working-continue.js");
  const todo = new TodoStore(); // empty
  let disposed = 0;
  const out = await runParkedWorkingContinue({
    config: { workspaceDir: "/tmp/node4-park-test", modelProvider: "openai", modelId: "x" } as any,
    platform: { send: async () => {} } as any,
    task: {
      taskId: "tf2",
      conversationId: "conv-free-done",
      expertId: "pentest",
      instruction: "ok",
      target: { type: "url", value: "https://lab.example/" },
      scope: { allow: [] },
    },
    parked: makeParked({
      conversationId: "conv-free-done",
      expertId: "pentest",
      workMode: "free",
      todo,
      dispose: () => {
        disposed += 1;
      },
    }),
  });
  assert.equal(out.terminalStatus, "completed");
  assert.equal(out.reparked, true, "package complete re-parks captain");
  assert.equal(disposed, 0, "Spec #354: package complete does not dispose");
  assert.ok(peekParkedSession("conv-free-done", "pentest"));
  clearWorkingSessionParksForTests();
}

// applyCaptainEndDisposition: interrupt path parks without dispose
{
  clearWorkingSessionParksForTests();
  let disposed = 0;
  const session = fakeSession();
  const applied = applyCaptainEndDisposition({
    decision: decideParkOnEnd({ aborted: true }),
    entry: {
      conversationId: "c-fin",
      expertId: "e",
      workMode: "graph",
      stageId: "recon",
      taskId: "t1",
      session,
      todo: new TodoStore(),
      dispose: () => {
        disposed += 1;
      },
    },
  });
  assert.equal(applied.parked, true);
  assert.equal(applied.disposed, false);
  assert.equal(disposed, 0);
  assert.ok(peekParkedSession("c-fin", "e"), "Issue3: interrupt finally path parks");
  // Spec #354: settled stage/burst parks (does not dispose)
  const applied2 = applyCaptainEndDisposition({
    decision: decideParkOnEnd({ aborted: false }),
    entry: {
      conversationId: "c-fin2",
      expertId: "e",
      workMode: "free",
      taskId: "t2",
      session: fakeSession(),
      todo: new TodoStore(),
      dispose: () => {
        disposed += 1;
      },
    },
  });
  assert.equal(applied2.parked, true);
  assert.equal(applied2.disposed, false);
  assert.equal(disposed, 0, "package settle must not dispose");
  assert.ok(peekParkedSession("c-fin2", "e"), "settle parks for continue attach");
  clearWorkingSessionParksForTests();
}

// Spec #354 S1: LLM-class error path equivalent = non-abort package end parks Todo
{
  clearWorkingSessionParksForTests();
  let disposed = 0;
  const todo = new TodoStore();
  // seed a non-empty open checklist (external behavior: continue sees todos)
  todo.apply({
    op: "init",
    list: [{ phase: "P", items: ["keep me"] }],
  });
  const applied = applyCaptainEndDisposition({
    decision: decideParkOnEnd({ aborted: false }),
    entry: {
      conversationId: "c-llm-err",
      expertId: "pentest",
      workMode: "free",
      taskId: "t-err",
      session: fakeSession(),
      todo,
      dispose: () => {
        disposed += 1;
      },
    },
  });
  assert.equal(applied.parked, true);
  assert.equal(disposed, 0);
  const cont = resolveWorkingSessionContinue({
    conversationId: "c-llm-err",
    expertId: "pentest",
    sessionWorkMode: "free",
  });
  assert.equal(cont.action, "attach");
  if (cont.action === "attach") {
    assert.ok(parkedTodoNonEmpty(cont.entry), "continue after package error sees open todos");
  }
  clearWorkingSessionParksForTests();
}

// Spec #354: dispose whitelist + case release + Reset
{
  clearWorkingSessionParksForTests();
  parkWorkingSession(makeParked({ conversationId: "case-a", expertId: "e1" }));
  parkWorkingSession(makeParked({ conversationId: "case-a", expertId: "e2" }));
  parkWorkingSession(makeParked({ conversationId: "case-b", expertId: "e1" }));
  assert.equal(countParkedSessionsForTests(), 3);
  const released = await disposeWorkingSessionsForCase("case-a");
  assert.equal(released.disposed, 2);
  assert.equal(countParkedSessionsForTests(), 1, "other Case park remains");
  assert.ok(peekParkedSession("case-b", "e1"));
  clearWorkingSessionParksForTests();
  parkWorkingSession(makeParked({ conversationId: "c-del", expertId: "exp" }));
  const del = await disposeWorkingSession("c-del", "exp");
  assert.equal(del.disposed, true);
  assert.equal(countParkedSessionsForTests(), 0);
  clearWorkingSessionParksForTests();
  const todo = new TodoStore();
  todo.apply({
    op: "init",
    list: [{ phase: "P", items: ["open"] }],
  });
  parkWorkingSession(
    makeParked({
      conversationId: "c-rst",
      expertId: "exp",
      todo,
    }),
  );
  const rst = await resetWorkingSessionMemory("c-rst", "exp");
  assert.equal(rst.ok, true);
  assert.ok((rst.openTodoCount ?? 0) >= 1);
  const peek = peekParkedSession("c-rst", "exp");
  assert.ok(peek);
  assert.equal(parkNeedsAgentReseed(peek!), true, "Reset marks Agent reseed");
  assert.ok(parkedTodoNonEmpty(peek!), "Reset keeps incomplete Todo");
  clearWorkingSessionParksForTests();
}

// Spec #354: pending Session delete forces dispose on finally (no ghost re-park)
{
  clearWorkingSessionParksForTests();
  clearPendingDisposeForTests();
  let disposed = 0;
  markPendingSessionDispose("c-pend", "exp");
  const applied = applyCaptainEndDisposition({
    decision: decideParkOnEnd({ aborted: false }),
    entry: {
      conversationId: "c-pend",
      expertId: "exp",
      workMode: "free",
      taskId: "t1",
      session: fakeSession(),
      todo: new TodoStore(),
      dispose: () => {
        disposed += 1;
      },
    },
  });
  assert.equal(applied.disposed, true, "pending dispose overrides park");
  assert.equal(disposed, 1);
  assert.equal(countParkedSessionsForTests(), 0);
  // Mid-burst force-dispose stashes todos for dispose ack
  const late = await disposeWorkingSession("c-pend", "exp");
  // stash may be empty if todo was empty; with empty todo still disposed via force path
  assert.equal(typeof late.disposed, "boolean");
  clearPendingDisposeForTests();
  clearWorkingSessionParksForTests();
}

// Spec #354 L1: case-wide pending cleared after force dispose (no sticky dispose)
{
  clearWorkingSessionParksForTests();
  clearPendingDisposeForTests();
  const {
    markPendingCaseDispose,
    isPendingDispose,
    clearPendingDisposeForTests: clearPend,
  } = await import("./working-session-park.js");
  markPendingCaseDispose("c-case-pend");
  assert.equal(isPendingDispose("c-case-pend", "exp"), true);
  applyCaptainEndDisposition({
    decision: decideParkOnEnd({ aborted: false }),
    entry: {
      conversationId: "c-case-pend",
      expertId: "exp",
      workMode: "free",
      taskId: "t1",
      session: fakeSession(),
      todo: new TodoStore(),
      dispose: () => {},
    },
  });
  assert.equal(
    isPendingDispose("c-case-pend", "exp"),
    false,
    "case pending cleared after force dispose finally",
  );
  // Next package end must park, not sticky-dispose
  let disposedAfter = 0;
  const parkAfter = applyCaptainEndDisposition({
    decision: decideParkOnEnd({ aborted: false }),
    entry: {
      conversationId: "c-case-pend",
      expertId: "exp",
      workMode: "free",
      taskId: "t2",
      session: fakeSession(),
      todo: new TodoStore(),
      dispose: () => {
        disposedAfter += 1;
      },
    },
  });
  assert.equal(parkAfter.parked, true, "after case-pending clear, settle parks");
  assert.equal(parkAfter.disposed, false);
  assert.equal(disposedAfter, 0, "park path must not call dispose");
  clearPend();
  clearWorkingSessionParksForTests();
}

// Spec #354: bare conversation pending matches expert-keyed park (missing expert_id)
{
  clearWorkingSessionParksForTests();
  clearPendingDisposeForTests();
  const { isPendingDispose, markPendingSessionDispose: markBare } = await import(
    "./working-session-park.js"
  );
  markBare("c-bare", ""); // bare conversation key
  assert.equal(isPendingDispose("c-bare", "exp-x"), true, "bare pending matches any expert");
  clearPendingDisposeForTests();
}

// Spec #354 S4: seedTodoFromHandoff accepts Node snapshot `content` shape
// and preserves completed siblings when open work remains (cold continue).
{
  const { seedTodoFromHandoff } = await import("./handoff-todo-seed.js");
  const store = seedTodoFromHandoff({
    pendingHandoffTodos: [
      {
        name: "P",
        tasks: [
          { content: "keep open", status: "pending" },
          { content: "done item", status: "completed" },
          { title: "plan title open", status: "pending" },
        ],
      },
    ],
  });
  assert.ok(store.openCount() >= 2, "content + title open items seeded");
  const snap = store.snapshot();
  const texts = snap.flatMap((p) => p.tasks.map((t) => t.content));
  assert.ok(texts.includes("keep open"));
  assert.ok(texts.includes("plan title open"));
  assert.ok(texts.includes("done item"), "completed siblings preserved for progress");
  const done = snap[0]?.tasks.find((t) => t.content === "done item");
  assert.equal(done?.status, "completed");
}

console.log("working-session-park.test.ts: Spec #354 fixtures ok");

// Park on abort does not call dispose; attach leaves session usable
{
  clearWorkingSessionParksForTests();
  let disposed = 0;
  const session = fakeSession();
  parkWorkingSession(
    makeParked({
      conversationId: "c-disp",
      expertId: "e",
      session,
      dispose: () => {
        disposed += 1;
      },
    }),
  );
  assert.equal(disposed, 0);
  const cont = resolveWorkingSessionContinue({
    conversationId: "c-disp",
    expertId: "e",
    sessionWorkMode: "graph",
  });
  assert.equal(cont.action, "attach");
  assert.equal(disposed, 0, "attach does not dispose captain");
  clearWorkingSessionParksForTests();
}

function idleHandle(agentId: string, pathKey: string): IdleSubagentHandle {
  let disposed = false;
  return {
    agentId,
    pathKey,
    session: {
      prompt: async () => undefined,
      dispose: () => {
        disposed = true;
      },
    },
    workDir: `/tmp/idle-${agentId}`,
    segmentCounter: { tools: 0 },
    packagesCompleted: 1,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    ...({ isDisposed: () => disposed } as { isDisposed: () => boolean }),
  };
}

function runtimeWithPool(pool: SubagentIdlePool): ToolRuntime {
  return { lifecycle: { subagentIdlePool: pool } } as ToolRuntime;
}

// Idle Workers park with Captain; Session dispose / Reset / drop tear them down.
{
  clearWorkingSessionParksForTests();
  clearRegisteredIdlePoolsForTests();
  const pool = new SubagentIdlePool(
    { maxIdle: 4, ttlMs: 60_000, maxPackages: 4 },
    undefined,
    "c-idle",
  );
  const parked = idleHandle("sub_keep", "http://t/keep");
  pool.park(parked);

  applyCaptainEndDisposition({
    decision: decideParkOnEnd({ aborted: false }),
    entry: {
      conversationId: "c-idle",
      expertId: "exp",
      workMode: "free",
      taskId: "t-idle",
      session: fakeSession(),
      todo: new TodoStore(),
      runtime: runtimeWithPool(pool),
      dispose: () => {},
    },
  });
  const warm = pool.tryResume("sub_keep", { pathKey: "http://t/keep" });
  assert.equal(warm.ok, true, "package park must not disposeAll idle Workers");
  if (warm.ok) pool.park(warm.handle);

  const gone = await disposeWorkingSession("c-idle", "exp");
  assert.equal(gone.disposed, true);
  assert.equal(pool.size, 0, "Session delete disposeAll idle Workers");
  assert.equal((parked as { isDisposed: () => boolean }).isDisposed(), true);
  const miss = pool.tryResume("sub_keep", { pathKey: "http://t/keep" });
  assert.equal(miss.ok, false);

  clearWorkingSessionParksForTests();
  clearRegisteredIdlePoolsForTests();
  const pool2 = new SubagentIdlePool(
    { maxIdle: 4, ttlMs: 60_000, maxPackages: 4 },
    undefined,
    "c-rst-w",
  );
  const resetH = idleHandle("sub_rst", "http://t/rst");
  pool2.park(resetH);
  parkWorkingSession(
    makeParked({
      conversationId: "c-rst-w",
      expertId: "exp",
      runtime: runtimeWithPool(pool2),
    }),
  );
  const rst = await resetWorkingSessionMemory("c-rst-w", "exp");
  assert.equal(rst.ok, true);
  assert.equal(pool2.size, 0, "Reset disposes idle Workers");
  assert.equal((resetH as { isDisposed: () => boolean }).isDisposed(), true);
  pool2.park(idleHandle("sub_after", "http://t/after"));
  assert.equal(pool2.size, 1, "same pool object still parks after Reset");

  clearWorkingSessionParksForTests();
  clearRegisteredIdlePoolsForTests();
  const pool3 = new SubagentIdlePool(
    { maxIdle: 4, ttlMs: 60_000, maxPackages: 4 },
    undefined,
    "c-drop",
  );
  pool3.park(idleHandle("sub_drop", "http://t/drop"));
  parkWorkingSession(
    makeParked({
      conversationId: "c-drop",
      expertId: "exp",
      runtime: runtimeWithPool(pool3),
    }),
  );
  await dropParkedSession("c-drop", "exp");
  assert.equal(pool3.size, 0, "dropParkedSession disposeAll idle Workers");

  clearWorkingSessionParksForTests();
  clearRegisteredIdlePoolsForTests();
}

clearWorkingSessionParksForTests();
console.log("working-session-park.test.ts: ok (W1–W10 + multi-continue re-park)");
