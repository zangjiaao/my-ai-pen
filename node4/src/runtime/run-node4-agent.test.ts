/**
 * Seam tests for runNode4Agent (core-only Agent Runtime).
 * Fake session backend — no live LLM, no coding-agent.
 */

import assert from "node:assert/strict";
import { runNode4Agent, type Node4AgentSession } from "./run-node4-agent.js";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";

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

async function testNoCodingAgentImportInModule() {
  // Static contract: this file's implementation module must not depend on coding-agent.
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
  assert.ok(src.includes("pi-agent-core"));
  assert.ok(src.includes("pi-ai"));
}

async function main() {
  await testPromptAndEvents();
  await testAbortStopsFurtherWork();
  await testNoCodingAgentImportInModule();
  console.log("run-node4-agent.test.ts: ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
