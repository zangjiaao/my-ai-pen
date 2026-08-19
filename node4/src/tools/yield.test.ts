/**
 * Spec #493: Worker-only yield tool.
 * Run: npx tsx src/tools/yield.test.ts
 */
import assert from "node:assert/strict";
import { createYieldTool } from "./yield.js";
import { ALL_NODE4_TOOL_FACTORIES, NODE4_TOOL_NAMES } from "./index.js";
import { SUBAGENT_CHILD_TOOL_NAMES } from "../runtime/subagent-session.js";
import { DEFAULT_SEAT_PACK } from "../roles/default.js";
import { PENTEST_ROLE_PACK } from "../roles/packs.js";
import { humanizeToolName } from "../runtime/panel-agents.js";
import type { TaskEnvelope, ToolRuntime } from "../types.js";

function runtime(depth: number): ToolRuntime {
  const task: TaskEnvelope = {
    taskId: "t",
    conversationId: "c",
    instruction: "x",
    target: {},
    scope: {},
  };
  return {
    task,
    workspaceDir: "/tmp",
    piDir: "/tmp/pi",
    platform: { send: async () => undefined },
    todo: { snapshot: () => [] },
    evidence: { create: async () => ({ id: "e" }) },
    findingsDir: "/tmp/f",
    goals: {},
    lifecycle: { subagentDepth: depth },
  } as unknown as ToolRuntime;
}

{
  const rt = runtime(0);
  const tool = createYieldTool(rt);
  const out = await tool.execute("1", { result: { data: "pong" } });
  const text = out.content.find((c) => c.type === "text")?.text || "";
  assert.match(text, /only available on Worker/);
  assert.equal(rt.lifecycle.workerYield, undefined);
}

{
  const rt = runtime(1);
  const tool = createYieldTool(rt);
  await tool.execute("1", { result: { data: { summary: "pong" } } });
  assert.equal(rt.lifecycle.workerYield?.status, "success");
  assert.deepEqual(rt.lifecycle.workerYield?.data, { summary: "pong" });
}

{
  const rt = runtime(1);
  const tool = createYieldTool(rt);
  await tool.execute("1", { result: {} });
  assert.equal(rt.lifecycle.workerYield?.useLastTurn, true);
}

{
  const rt = runtime(1);
  const tool = createYieldTool(rt);
  await tool.execute("1", { result: { error: "blocked" } });
  assert.equal(rt.lifecycle.workerYield?.status, "error");
  assert.equal(rt.lifecycle.workerYield?.error, "blocked");
}

assert.equal(typeof ALL_NODE4_TOOL_FACTORIES.yield, "function");
assert.ok(SUBAGENT_CHILD_TOOL_NAMES.includes("yield"));
assert.ok(!(NODE4_TOOL_NAMES as readonly string[]).includes("yield"), "Main bare pack has no yield");
assert.ok(!DEFAULT_SEAT_PACK.toolNames.includes("yield"), "Default seat has no yield");
assert.ok(!PENTEST_ROLE_PACK.toolNames.includes("yield"), "Main pentest pack has no yield");
assert.equal(humanizeToolName("yield"), "提交结果");

console.log("yield.test.ts: ok");
