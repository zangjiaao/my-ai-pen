/**
 * Seam tests for runNode4Agent / createBoundNode4Session (core-only Agent Runtime).
 * Fake session backend — no live LLM, no coding-agent.
 */

import assert from "node:assert/strict";
import {
  attachProductToolEventBridge,
  resolveNode4Model,
  runNode4Agent,
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
    lifecycle: { toolsInLastSegment: 0 },
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

async function main() {
  await testPromptAndEvents();
  await testAbortStopsFurtherWork();
  await testToolEventBridgeSingleFanOut();
  await testResolveModelOverrideBaseUrl();
  await testResolveModelUnknownSynthetic();
  await testNoCodingAgentImportInModule();
  console.log("run-node4-agent.test.ts: ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
