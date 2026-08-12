/**
 * Seam tests for runNode4Agent / createBoundNode4Session (core-only Agent Runtime).
 * Fake session backend — no live LLM, no coding-agent.
 */

import assert from "node:assert/strict";
import {
  attachProductToolEventBridge,
  clipToolResultTextForWire,
  commandFromResultText,
  commandFromToolArgs,
  enrichArgsWithCommand,
  resolveNode4Model,
  resolveToolExecutionEndIsError,
  runNode4Agent,
  SHELL_COMMAND_WIRE_MAX,
  surfaceFieldsFromToolArgs,
  toolResultDetailsIsError,
  type Node4AgentSession,
} from "./run-node4-agent.js";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type { Node4Config } from "../config.js";
import type { ToolRuntime } from "../types.js";

const dummyModel = {
  id: "test",
  name: "test",
  api: "openai-completions",
  provider: "test",
  baseUrl: "http://127.0.0.1:9",
  reasoning: false,
  input: ["text" as const],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 1024,
} satisfies Model<"openai-completions">;

function fakeSession(opts?: {
  onPrompt?: (text: string) => void | Promise<void>;
  events?: AgentEvent[];
}): Node4AgentSession {
  const listeners = new Set<(e: AgentEvent) => void | Promise<void>>();
  let aborted = false;
  return {
    prompt: async (text) => {
      if (aborted) throw new Error("aborted");
      await opts?.onPrompt?.(text);
      for (const ev of opts?.events || []) {
        for (const l of listeners) await l(ev);
      }
    },
    abort: () => {
      aborted = true;
    },
    dispose: () => {
      aborted = true;
      listeners.clear();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    steer: () => {},
    followUp: () => {},
    get messages() {
      return [];
    },
  };
}

async function testPromptAndEvents() {
  const seen: string[] = [];
  const prompts: string[] = [];
  const session = await runNode4Agent({
    systemPrompt: "sys",
    tools: [],
    model: dummyModel,
    sessionFactory: () =>
      fakeSession({
        onPrompt: (t) => {
          prompts.push(t);
        },
        events: [
          {
            type: "tool_execution_start",
            toolCallId: "1",
            toolName: "shell",
            args: { command: "echo hi" },
          } as AgentEvent,
          {
            type: "tool_execution_end",
            toolCallId: "1",
            toolName: "shell",
            result: { content: [{ type: "text", text: "hi" }], details: {} },
            isError: false,
          } as AgentEvent,
        ],
      }),
  });

  session.subscribe((ev) => {
    seen.push(ev.type);
  });
  await session.prompt("do work");
  assert.deepEqual(prompts, ["do work"]);
  assert.ok(seen.includes("tool_execution_start"));
  assert.ok(seen.includes("tool_execution_end"));
  await session.dispose();
}

async function testAbortStopsFurtherWork() {
  let prompts = 0;
  const session = await runNode4Agent({
    systemPrompt: "sys",
    tools: [],
    model: dummyModel,
    sessionFactory: () => {
      let aborted = false;
      return {
        prompt: async () => {
          if (aborted) throw new Error("aborted");
          prompts += 1;
        },
        abort: () => {
          aborted = true;
        },
        dispose: () => {
          aborted = true;
        },
        subscribe: () => () => {},
        steer: () => {},
    followUp: () => {},
        get messages() {
          return [];
        },
      };
    },
  });
  await session.prompt("one");
  session.abort();
  await assert.rejects(() => session.prompt("two"), /aborted/);
  assert.equal(prompts, 1);
}

async function testToolResultDetailsIsErrorPromotion() {
  assert.equal(toolResultDetailsIsError(undefined), false);
  assert.equal(toolResultDetailsIsError({ content: [], details: {} }), false);
  assert.equal(
    toolResultDetailsIsError({ content: [], details: { isError: true } }),
    true,
    "product textResult(_, { isError: true })",
  );
  assert.equal(
    resolveToolExecutionEndIsError({ isError: false, result: { details: { isError: true } } }),
    true,
  );
  assert.equal(
    resolveToolExecutionEndIsError({ isError: true, result: { details: {} } }),
    true,
    "pi event.isError wins",
  );
  assert.equal(
    resolveToolExecutionEndIsError({
      isError: false,
      result: {
        content: [{ type: "text", text: "error: packages[0] incomplete handoff" }],
        details: { isError: true },
      },
    }),
    true,
    "subagent incomplete handoff must not be done",
  );
}

/** Bridge emits error when pi end carries product details.isError (or event.isError). */
async function testToolEventBridgeErrorFromDetailsIsError() {
  const platformMsgs: Array<{ type: string; status?: string; summary?: string }> = [];
  const runtime = {
    task: { conversationId: "c", taskId: "t" },
    platform: {
      send: async (msg: { type: string; status?: string; summary?: string }) => {
        platformMsgs.push(msg);
      },
    },
    lifecycle: { toolsInLastSegment: 0, subagentDepth: 0 },
  } as unknown as ToolRuntime;

  const session = fakeSession({
    events: [
      {
        type: "tool_execution_start",
        toolCallId: "sub1",
        toolName: "subagent",
        args: {},
      } as AgentEvent,
      {
        type: "tool_execution_end",
        toolCallId: "sub1",
        toolName: "subagent",
        // pi leaves isError false when execute does not throw
        isError: false,
        result: {
          content: [
            {
              type: "text",
              text: "error: packages[0] incomplete handoff — need target, scope, already_done",
            },
          ],
          details: { isError: true },
        },
      } as AgentEvent,
    ],
  });
  attachProductToolEventBridge(session, runtime);
  await session.prompt("x");
  const tools = platformMsgs.filter((m) => m.type === "tool_output");
  assert.ok(tools.some((m) => m.status === "running"));
  assert.ok(
    tools.some((m) => m.status === "error"),
    "incomplete handoff must be error not done",
  );
  assert.equal(
    tools.filter((m) => m.status === "done").length,
    0,
    "must not emit done for details.isError",
  );
}

async function testToolEventBridgeSingleFanOut() {
  const platformMsgs: Array<{ type: string; status?: string }> = [];
  const segmentCounter = { tools: 0 };
  const runtime = {
    task: { conversationId: "c", taskId: "t" },
    platform: {
      send: async (msg: { type: string; status?: string }) => {
        platformMsgs.push({ type: msg.type, status: msg.status });
      },
    },
    lifecycle: { toolsInLastSegment: 0, subagentDepth: 0 },
  } as unknown as ToolRuntime;

  const session = fakeSession({
    events: [
      {
        type: "tool_execution_start",
        toolCallId: "1",
        toolName: "shell",
        args: {},
      } as AgentEvent,
      {
        type: "tool_execution_end",
        toolCallId: "1",
        toolName: "shell",
        result: { content: [{ type: "text", text: "ok" }], details: {} },
        isError: false,
      } as AgentEvent,
    ],
  });
  attachProductToolEventBridge(session, runtime, segmentCounter);
  await session.prompt("x");
  assert.equal(segmentCounter.tools, 1);
  assert.equal(runtime.lifecycle.toolsInLastSegment, 1);
  assert.ok(platformMsgs.some((m) => m.type === "tool_output" && m.status === "running"));
  assert.ok(platformMsgs.some((m) => m.type === "tool_output" && m.status === "done"));
}

/**
 * Case e8a62c56: user interrupt mid-tool — pi may skip tool_execution_end.
 * Bridge must emit terminal error so the card does not stay status=running.
 */
async function testToolEventBridgeSettlesOpenToolsOnAbort() {
  const platformMsgs: Array<{
    type: string;
    status?: string;
    summary?: string;
    tool_run_id?: string;
    command?: string;
  }> = [];
  const runtime = {
    task: { conversationId: "c", taskId: "t" },
    platform: {
      send: async (msg: {
        type: string;
        status?: string;
        summary?: string;
        tool_run_id?: string;
        command?: string;
      }) => {
        platformMsgs.push(msg);
      },
    },
    lifecycle: { toolsInLastSegment: 0, subagentDepth: 0 },
  } as unknown as ToolRuntime;

  // Only start — no end (simulates abort during shell).
  const session = fakeSession({
    events: [
      {
        type: "tool_execution_start",
        toolCallId: "call_stuck",
        toolName: "shell",
        args: { command: "sleep 999" },
      } as AgentEvent,
    ],
  });
  attachProductToolEventBridge(session, runtime);
  await session.prompt("run long tool");
  assert.ok(
    platformMsgs.some((m) => m.type === "tool_output" && m.status === "running" && m.tool_run_id === "call_stuck"),
  );
  assert.ok(
    platformMsgs.some(
      (m) => m.type === "tool_output" && m.status === "running" && m.command === "sleep 999",
    ),
    "running frame surfaces shell command for Main chip",
  );
  session.abort();
  // settle is async void from abort — drain microtasks
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setImmediate(r));
  const errors = platformMsgs.filter(
    (m) => m.type === "tool_output" && m.status === "error" && m.tool_run_id === "call_stuck",
  );
  assert.equal(errors.length, 1, "abort must settle open tool as error");
  assert.equal(String(errors[0]?.summary || ""), "interrupted");
  assert.equal(
    String(errors[0]?.command || ""),
    "sleep 999",
    "interrupt settle keeps command for chip (not only interrupted summary)",
  );
  // Second abort must not double-emit
  session.abort();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(
    platformMsgs.filter((m) => m.type === "tool_output" && m.status === "error" && m.tool_run_id === "call_stuck")
      .length,
    1,
    "settle is idempotent",
  );
}

function testCommandFromToolArgs() {
  assert.equal(commandFromToolArgs({ command: "nmap -sV target" }), "nmap -sV target");
  assert.equal(commandFromToolArgs({ cmd: "ls" }), "ls");
  assert.equal(commandFromToolArgs({ other: 1 }), "");
  assert.equal(commandFromToolArgs(null), "");

  // Multi-line shell scripts must not be 500-char teased on content.command.
  const longCmd = `# proof\n${"A".repeat(2000)}\ncurl http://x`;
  assert.ok(longCmd.length > 500);
  const kept = commandFromToolArgs({ command: longCmd });
  assert.ok(kept.length > 500);
  assert.ok(kept.startsWith("# proof"));
  assert.ok(kept.length <= SHELL_COMMAND_WIRE_MAX);

  const shellSurf = surfaceFieldsFromToolArgs("shell", { command: longCmd });
  assert.ok(shellSurf.command.length > 500);
  assert.ok(shellSurf.command.includes("curl http://x") || shellSurf.command.startsWith("# proof"));

  const http = surfaceFieldsFromToolArgs("http", { method: "GET", url: "https://x/" });
  assert.equal(http.command, "GET https://x/");
  assert.equal(http.target, "https://x/");

  const browser = surfaceFieldsFromToolArgs("browser", { action: "open", url: "https://y/" });
  assert.equal(browser.target, "open https://y/");

  const skill = surfaceFieldsFromToolArgs("skill", { op: "load", id: "sqli" });
  assert.equal(skill.target, "load sqli");

  const read = surfaceFieldsFromToolArgs("read", { path: "a.py" });
  assert.equal(read.command, "a.py");
  assert.equal(read.target, "a.py");

  // Done frame: command recovered from result JSON when args empty.
  assert.equal(
    commandFromResultText(JSON.stringify({ ok: true, command: "curl -sI http://x", exitCode: 0 })),
    "curl -sI http://x",
  );
  const enriched = enrichArgsWithCommand({}, JSON.stringify({ command: "echo hi", exitCode: 0 }));
  assert.equal(enriched?.command, "echo hi");
}

/**
 * Spec #350: running progressive frame as soon as tool name+id known (toolcall_start),
 * not only at tool_execution_start (after large args finish streaming).
 *
 * Phase A asserts name-known alone (no execute events) — this is the regression gate
 * for the late-start bug. Phase B asserts same run id → done and no delta spam.
 */
async function testToolEventBridgeRunningFromToolNameKnown() {
  // --- Phase A: name-known only (no tool_execution_*) ---
  const earlyMsgs: Array<{
    type: string;
    status?: string;
    tool_name?: string;
    tool_run_id?: string;
  }> = [];
  const segmentCounter = { tools: 0 };
  const earlyRuntime = {
    task: { conversationId: "c", taskId: "t", expertId: "pentest", expertName: "渗透" },
    platform: {
      send: async (msg: {
        type: string;
        status?: string;
        tool_name?: string;
        tool_run_id?: string;
      }) => {
        earlyMsgs.push(msg);
      },
    },
    lifecycle: { toolsInLastSegment: 0, subagentDepth: 0 },
  } as unknown as ToolRuntime;

  const partial = {
    role: "assistant",
    content: [
      { type: "toolCall", id: "tc-report", name: "platform_create_report", arguments: {} },
    ],
  };

  const earlySession = fakeSession({
    events: [
      {
        type: "message_update",
        message: partial,
        assistantMessageEvent: {
          type: "toolcall_start",
          contentIndex: 0,
          partial,
        },
      } as unknown as AgentEvent,
      // Args still streaming — still no execute
      {
        type: "message_update",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "tc-report",
              name: "platform_create_report",
              arguments: { markdown: "# partial" },
            },
          ],
        },
        assistantMessageEvent: {
          type: "toolcall_delta",
          contentIndex: 0,
          delta: '{"markdown":',
          partial: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "tc-report",
                name: "platform_create_report",
                arguments: { markdown: "# partial" },
              },
            ],
          },
        },
      } as unknown as AgentEvent,
    ],
  });
  attachProductToolEventBridge(earlySession, earlyRuntime, segmentCounter);
  await earlySession.prompt("write report");

  const earlyTools = earlyMsgs.filter((m) => m.type === "tool_output");
  assert.equal(earlyTools.length, 1, "exactly one running frame for name-known (no delta spam)");
  assert.equal(earlyTools[0]?.status, "running");
  assert.equal(earlyTools[0]?.tool_name, "platform_create_report");
  assert.equal(earlyTools[0]?.tool_run_id, "tc-report");
  assert.equal(segmentCounter.tools, 0, "name-known must not count as tool execution");
  assert.equal(earlyRuntime.lifecycle.toolsInLastSegment, 0);

  // --- Phase B: full lifecycle name-known → execute → end on same run id ---
  const platformMsgs: Array<{
    type: string;
    status?: string;
    tool_name?: string;
    tool_run_id?: string;
  }> = [];
  const segmentCounterB = { tools: 0 };
  const runtime = {
    task: { conversationId: "c", taskId: "t", expertId: "pentest", expertName: "渗透" },
    platform: {
      send: async (msg: {
        type: string;
        status?: string;
        tool_name?: string;
        tool_run_id?: string;
      }) => {
        platformMsgs.push(msg);
      },
    },
    lifecycle: { toolsInLastSegment: 0, subagentDepth: 0 },
  } as unknown as ToolRuntime;

  const session = fakeSession({
    events: [
      {
        type: "message_update",
        message: partial,
        assistantMessageEvent: {
          type: "toolcall_start",
          contentIndex: 0,
          partial,
        },
      } as unknown as AgentEvent,
      {
        type: "tool_execution_start",
        toolCallId: "tc-report",
        toolName: "platform_create_report",
        args: { markdown: "# full report body" },
      } as AgentEvent,
      {
        type: "tool_execution_end",
        toolCallId: "tc-report",
        toolName: "platform_create_report",
        result: { content: [{ type: "text", text: "report saved" }], details: {} },
        isError: false,
      } as AgentEvent,
    ],
  });
  attachProductToolEventBridge(session, runtime, segmentCounterB);
  await session.prompt("write report");

  const tools = platformMsgs.filter((m) => m.type === "tool_output");
  assert.equal(tools.length, 2, "exactly one running + one done (no execute re-emit)");
  assert.equal(tools[0]?.status, "running", "first frame is running from name-known");
  assert.equal(tools[0]?.tool_run_id, "tc-report");
  assert.equal(tools[1]?.status, "done");
  assert.equal(tools[1]?.tool_run_id, "tc-report");
  assert.equal(segmentCounterB.tools, 1, "tools counted once at execute-start");
  assert.equal(runtime.lifecycle.toolsInLastSegment, 1);
}

/**
 * Spec #350: OpenAI-style deferred id/name — toolcall_start may have empty id/name;
 * running only after both appear on a later toolcall_delta partial.
 */
async function testToolEventBridgeRunningAfterDeferredIdAndName() {
  const platformMsgs: Array<{
    type: string;
    status?: string;
    tool_name?: string;
    tool_run_id?: string;
  }> = [];
  const segmentCounter = { tools: 0 };
  const runtime = {
    task: { conversationId: "c", taskId: "t" },
    platform: {
      send: async (msg: {
        type: string;
        status?: string;
        tool_name?: string;
        tool_run_id?: string;
      }) => {
        platformMsgs.push(msg);
      },
    },
    lifecycle: { toolsInLastSegment: 0, subagentDepth: 0 },
  } as unknown as ToolRuntime;

  const emptyPartial = {
    role: "assistant",
    content: [{ type: "toolCall", id: "", name: "", arguments: {} }],
  };
  const idOnlyPartial = {
    role: "assistant",
    content: [{ type: "toolCall", id: "tc-late", name: "", arguments: {} }],
  };
  const fullPartial = {
    role: "assistant",
    content: [
      { type: "toolCall", id: "tc-late", name: "platform_create_report", arguments: {} },
    ],
  };

  const session = fakeSession({
    events: [
      {
        type: "message_update",
        message: emptyPartial,
        assistantMessageEvent: {
          type: "toolcall_start",
          contentIndex: 0,
          partial: emptyPartial,
        },
      } as unknown as AgentEvent,
      {
        type: "message_update",
        message: idOnlyPartial,
        assistantMessageEvent: {
          type: "toolcall_delta",
          contentIndex: 0,
          delta: "",
          partial: idOnlyPartial,
        },
      } as unknown as AgentEvent,
      {
        type: "message_update",
        message: fullPartial,
        assistantMessageEvent: {
          type: "toolcall_delta",
          contentIndex: 0,
          delta: "",
          partial: fullPartial,
        },
      } as unknown as AgentEvent,
    ],
  });
  attachProductToolEventBridge(session, runtime, segmentCounter);
  await session.prompt("x");

  const tools = platformMsgs.filter((m) => m.type === "tool_output");
  assert.equal(tools.length, 1, "no emit until both id and name known");
  assert.equal(tools[0]?.status, "running");
  assert.equal(tools[0]?.tool_run_id, "tc-late");
  assert.equal(tools[0]?.tool_name, "platform_create_report");
  assert.equal(segmentCounter.tools, 0);
}

/** Spec #350: two run ids get independent running frames from name-known (no execute). */
async function testToolEventBridgeIndependentRunIds() {
  const platformMsgs: Array<{
    type: string;
    status?: string;
    tool_name?: string;
    tool_run_id?: string;
  }> = [];
  const runtime = {
    task: { conversationId: "c", taskId: "t" },
    platform: {
      send: async (msg: {
        type: string;
        status?: string;
        tool_name?: string;
        tool_run_id?: string;
      }) => {
        platformMsgs.push(msg);
      },
    },
    lifecycle: { toolsInLastSegment: 0, subagentDepth: 0 },
  } as unknown as ToolRuntime;

  const partial = {
    role: "assistant",
    content: [
      { type: "toolCall", id: "a", name: "shell", arguments: {} },
      { type: "toolCall", id: "b", name: "http_request", arguments: {} },
    ],
  };

  const session = fakeSession({
    events: [
      {
        type: "message_update",
        message: partial,
        assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, partial },
      } as unknown as AgentEvent,
      // terminal paths stay independent too
      {
        type: "tool_execution_end",
        toolCallId: "a",
        toolName: "shell",
        result: { content: [{ type: "text", text: "a-ok" }], details: {} },
        isError: false,
      } as AgentEvent,
      {
        type: "tool_execution_end",
        toolCallId: "b",
        toolName: "http_request",
        result: { content: [{ type: "text", text: "b-ok" }], details: {} },
        isError: true,
      } as AgentEvent,
    ],
  });
  attachProductToolEventBridge(session, runtime);
  await session.prompt("x");

  const tools = platformMsgs.filter((m) => m.type === "tool_output");
  assert.ok(
    tools.some((m) => m.tool_run_id === "a" && m.status === "running" && m.tool_name === "shell"),
    "run a running from name-known",
  );
  assert.ok(tools.some((m) => m.tool_run_id === "a" && m.status === "done"), "run a done");
  assert.ok(
    tools.some(
      (m) => m.tool_run_id === "b" && m.status === "running" && m.tool_name === "http_request",
    ),
    "run b running from name-known",
  );
  assert.ok(
    tools.some((m) => m.tool_run_id === "b" && m.status === "error"),
    "run b error independent",
  );
}

/**
 * Spec #350 + #308: name-known early frames must not leak unscoped Main for package workers.
 * With workerAudit scope, Worker channel still gets early running.
 */
async function testToolEventBridgeNameKnownSilentForSubagentDepth() {
  const platformMsgs: Array<{ type: string; status?: string; channel?: string }> = [];
  const segmentCounter = { tools: 0 };
  const runtime = {
    task: { conversationId: "c", taskId: "t/sub/sub_1" },
    platform: {
      send: async (msg: { type: string; status?: string; channel?: string }) => {
        platformMsgs.push(msg);
      },
    },
    lifecycle: { toolsInLastSegment: 0, subagentDepth: 1 },
  } as unknown as ToolRuntime;

  const partial = {
    role: "assistant",
    content: [{ type: "toolCall", id: "tc1", name: "shell", arguments: {} }],
  };
  const session = fakeSession({
    events: [
      {
        type: "message_update",
        message: partial,
        assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, partial },
      } as unknown as AgentEvent,
      {
        type: "tool_execution_start",
        toolCallId: "tc1",
        toolName: "shell",
        args: {},
      } as AgentEvent,
      {
        type: "tool_execution_end",
        toolCallId: "tc1",
        toolName: "shell",
        result: { content: [{ type: "text", text: "ok" }], details: {} },
        isError: false,
      } as AgentEvent,
    ],
  });
  attachProductToolEventBridge(session, runtime, segmentCounter);
  await session.prompt("x");
  assert.equal(segmentCounter.tools, 1, "still count at execute-start");
  assert.equal(
    platformMsgs.filter((m) => m.type === "tool_output" && !m.channel).length,
    0,
    "no unscoped Main tool_output from package name-known or execute",
  );

  // Worker-scoped package: early name-known running lands on Worker channel only
  const workerMsgs: Array<Record<string, unknown>> = [];
  const workerRuntime = {
    task: { conversationId: "c", taskId: "t/sub/sub_1" },
    platform: {
      send: async (msg: Record<string, unknown>) => {
        workerMsgs.push(msg);
      },
    },
    lifecycle: {
      toolsInLastSegment: 0,
      subagentDepth: 1,
      workerAudit: { agentId: "sub_1", packageTurnId: "pkg_sub_1_test" },
    },
  } as unknown as ToolRuntime;
  const workerSession = fakeSession({
    events: [
      {
        type: "message_update",
        message: partial,
        assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, partial },
      } as unknown as AgentEvent,
    ],
  });
  attachProductToolEventBridge(workerSession, workerRuntime);
  await workerSession.prompt("x");
  const workerTools = workerMsgs.filter((m) => m.type === "tool_output");
  assert.equal(workerTools.length, 1, "one Worker running frame at name-known");
  assert.equal(workerTools[0]?.status, "running");
  assert.equal(workerTools[0]?.channel, "worker_audit");
  assert.equal(workerTools[0]?.agent_id, "sub_1");
  assert.equal(
    workerMsgs.filter((m) => m.type === "tool_output" && !m.channel).length,
    0,
    "still no unscoped Main",
  );
}

/** Policy A: package workers must not emit Main (unscoped) tool_output. */
async function testToolEventBridgeSilentForSubagentDepth() {
  const platformMsgs: Array<{ type: string; status?: string; channel?: string; agent_id?: string }> = [];
  const segmentCounter = { tools: 0 };
  const runtime = {
    task: { conversationId: "c", taskId: "t/sub/sub_1" },
    platform: {
      send: async (msg: { type: string; status?: string; channel?: string; agent_id?: string }) => {
        platformMsgs.push(msg);
      },
    },
    lifecycle: { toolsInLastSegment: 0, subagentDepth: 1 },
  } as unknown as ToolRuntime;

  const session = fakeSession({
    events: [
      {
        type: "tool_execution_start",
        toolCallId: "1",
        toolName: "shell",
        args: {},
      } as AgentEvent,
      {
        type: "tool_execution_end",
        toolCallId: "1",
        toolName: "shell",
        result: { content: [{ type: "text", text: "ok" }], details: {} },
        isError: false,
      } as AgentEvent,
    ],
  });
  attachProductToolEventBridge(session, runtime, segmentCounter);
  await session.prompt("x");
  assert.equal(segmentCounter.tools, 1, "still count tools for salvage");
  assert.equal(runtime.lifecycle.toolsInLastSegment, 1);
  // Without workerAudit scope: still no Main leak (no unscoped tool_output).
  assert.equal(
    platformMsgs.filter((m) => m.type === "tool_output" && !m.channel).length,
    0,
    "no unscoped tool_output to Main for subagent package",
  );
}

/** Spec #308: with workerAudit scope, tools emit Worker channel frames (not Main). */
async function testToolEventBridgeWorkerAuditChannel() {
  const platformMsgs: Array<Record<string, unknown>> = [];
  const segmentCounter = { tools: 0 };
  const runtime = {
    task: { conversationId: "c", taskId: "t/sub/sub_1" },
    platform: {
      send: async (msg: Record<string, unknown>) => {
        platformMsgs.push(msg);
      },
    },
    lifecycle: {
      toolsInLastSegment: 0,
      subagentDepth: 1,
      workerAudit: { agentId: "sub_1", packageTurnId: "pkg_sub_1_test" },
    },
  } as unknown as ToolRuntime;

  const session = fakeSession({
    events: [
      {
        type: "tool_execution_start",
        toolCallId: "tc1",
        toolName: "shell",
        args: { cmd: "id" },
      } as AgentEvent,
      {
        type: "tool_execution_end",
        toolCallId: "tc1",
        toolName: "shell",
        result: { content: [{ type: "text", text: "uid=0" }], details: {} },
        isError: false,
      } as AgentEvent,
    ],
  });
  attachProductToolEventBridge(session, runtime, segmentCounter);
  await session.prompt("x");
  const tools = platformMsgs.filter((m) => m.type === "tool_output");
  assert.equal(tools.length, 2, "start + end on Worker channel");
  for (const m of tools) {
    assert.equal(m.channel, "worker_audit");
    assert.equal(m.agent_id, "sub_1");
    assert.equal(m.package_turn_id, "pkg_sub_1_test");
  }
  assert.ok(tools.some((m) => m.status === "running"));
  assert.ok(tools.some((m) => m.status === "done"));
}

async function testResolveModelOverrideBaseUrl() {
  const cfg = {
    modelProvider: "openai",
    modelId: "gpt-4o",
    llmBaseUrl: "http://127.0.0.1:4000/v1",
  } as Node4Config;
  const m = resolveNode4Model(cfg);
  assert.equal(m.baseUrl, "http://127.0.0.1:4000/v1");
  // Known catalog model should keep real api when present
  if (m.api) assert.ok(typeof m.api === "string");
}

async function testResolveModelUnknownSynthetic() {
  const cfg = {
    modelProvider: "my-lab-proxy",
    modelId: "local-llama",
    llmBaseUrl: "http://127.0.0.1:11434/v1",
  } as Node4Config;
  const m = resolveNode4Model(cfg);
  assert.equal(m.provider, "my-lab-proxy");
  assert.equal(m.id, "local-llama");
  assert.equal(m.baseUrl, "http://127.0.0.1:11434/v1");
  assert.equal(m.api, process.env.LLM_API || "openai-completions");
}

async function testNoCodingAgentImportInModule() {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = await fs.readFile(path.join(here, "run-node4-agent.ts"), "utf8");
  assert.equal(
    /from ["']@earendil-works\/pi-coding-agent["']/.test(src),
    false,
    "run-node4-agent must not import coding-agent",
  );
  assert.ok(src.includes("createBoundNode4Session"));
  assert.ok(src.includes("getBuiltinModel") || src.includes("providers/all"));
}

function testClipToolResultTextForWire() {
  const longCmd = `python3 -c ${JSON.stringify("x".repeat(6000))}`;
  const stdout = `HTTP/1.1 200 OK\n${"BODY".repeat(50)}`;
  const raw = JSON.stringify({
    ok: true,
    command: longCmd,
    exitCode: 0,
    timedOut: false,
    aborted: false,
    stdout,
    stderr: "",
    timeout_seconds: 30,
  });
  assert.ok(raw.length > 4000, "fixture must exceed legacy 4k clip");
  const clipped = clipToolResultTextForWire(raw, 4000);
  assert.ok(clipped.length <= 4000);
  const parsed = JSON.parse(clipped) as Record<string, unknown>;
  assert.match(String(parsed.stdout || ""), /HTTP\/1\.1 200 OK/);
  assert.equal(parsed.exitCode, 0);
  assert.ok(String(parsed.stdout).length > 10);

  const small = JSON.stringify({ ok: true, command: "echo hi", stdout: "hi\n", exitCode: 0 });
  assert.equal(clipToolResultTextForWire(small), small);

  // Platform list_vulnerabilities: large ok+array must NOT be rewritten to empty shell.
  const vulns = Array.from({ length: 80 }, (_, i) => ({
    id: `v-${i}`,
    title: `Finding ${i} ${"x".repeat(80)}`,
    status: "open",
  }));
  const ledger = JSON.stringify({ ok: true, vulnerabilities: vulns, total: vulns.length });
  assert.ok(ledger.length > 4000);
  const ledgerClipped = clipToolResultTextForWire(ledger, 4000);
  assert.ok(ledgerClipped.length <= 4000);
  const ledgerParsed = JSON.parse(ledgerClipped) as Record<string, unknown>;
  assert.ok(Array.isArray(ledgerParsed.vulnerabilities));
  assert.ok((ledgerParsed.vulnerabilities as unknown[]).length >= 1);
  assert.equal(ledgerParsed.stdout, undefined);
  assert.notEqual(
    String(ledgerClipped).includes("无 stdout"),
    true,
  );
}

async function main() {
  await testPromptAndEvents();
  await testAbortStopsFurtherWork();
  await testToolResultDetailsIsErrorPromotion();
  await testToolEventBridgeErrorFromDetailsIsError();
  await testToolEventBridgeSingleFanOut();
  await testToolEventBridgeSettlesOpenToolsOnAbort();
  testCommandFromToolArgs();
  testClipToolResultTextForWire();
  await testToolEventBridgeRunningFromToolNameKnown();
  await testToolEventBridgeRunningAfterDeferredIdAndName();
  await testToolEventBridgeIndependentRunIds();
  await testToolEventBridgeNameKnownSilentForSubagentDepth();
  await testToolEventBridgeSilentForSubagentDepth();
  await testToolEventBridgeWorkerAuditChannel();
  await testResolveModelOverrideBaseUrl();
  await testResolveModelUnknownSynthetic();
  await testNoCodingAgentImportInModule();
  console.log("run-node4-agent.test.ts: ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
