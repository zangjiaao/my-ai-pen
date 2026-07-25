/**
 * Probe-stage harness: narration + prefer packages (#101).
 * Run: npx tsx src/runtime/hard-graph-stage-prompts.test.ts
 */
import assert from "node:assert/strict";
import { stageSystemPrompt, stageUserPrompt } from "./hard-graph-stage-executor.js";
import type { StageExecutorInput } from "./hard-graph-runner.js";

const baseStage = {
  id: "class_probe",
  success: "probe with proof",
  require: { summary: true },
  tools: { allow: ["todo", "shell", "subagent"] as string[] },
  max_retries: 1,
};

const inputWithSub: StageExecutorInput = {
  stage: baseStage as any,
  stageIndex: 3,
  graphId: "app_assessment",
  handoff: {
    surfaces: [{ location: "http://t/" }],
    candidates: [],
    facts: [],
    deadends: [],
    completed_stages: ["init", "surface"],
  },
  tools: ["todo", "shell", "subagent"],
  toolProfile: { allow: ["todo", "shell", "subagent"] },
};

const task = {
  taskId: "t1",
  conversationId: "c1",
  instruction: "assess",
  target: { url: "http://t" },
  scope: {},
} as any;

const sys = stageSystemPrompt(inputWithSub, task);
assert.match(sys, /narrate progress/i, "encourages short narration");
assert.match(sys, /Prefer packages/i, "prefer packages when multi-class");
assert.doesNotMatch(sys, /exactly \d+ packages/i, "no fixed package count");
assert.doesNotMatch(sys, /DVWA/i, "no answer-key target names");

const user = stageUserPrompt(inputWithSub, task);
assert.match(user, /Prefer subagent packages/i);

const noSub: StageExecutorInput = {
  ...inputWithSub,
  stage: { ...baseStage, id: "init", tools: { allow: ["todo", "write"] } } as any,
  tools: ["todo", "write"],
  toolProfile: { allow: ["todo", "write"] },
};
const sysNo = stageSystemPrompt(noSub, task);
assert.doesNotMatch(sysNo, /Prefer packages/i, "no package steer without subagent tool");
assert.match(sysNo, /narrate/i, "narration still encouraged");

console.log("hard-graph-stage-prompts.test.ts: ok");
