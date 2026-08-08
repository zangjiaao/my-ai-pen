/**
 * Probe-stage harness: narration + prefer packages (#101).
 * Language policy injection on stage + free/subagent parity (#134 / #137).
 * Run: npx tsx src/runtime/hard-graph-stage-prompts.test.ts
 */
import assert from "node:assert/strict";
import { stageSystemPrompt, stageUserPrompt } from "./hard-graph-stage-executor.js";
import type { StageExecutorInput } from "./hard-graph-runner.js";
import { buildSystemPrompt } from "./prompt.js";
import { buildSubagentSystemPrompt } from "./subagent-session.js";
import { PENTEST_ROLE_PACK } from "../roles/index.js";
import type { TaskEnvelope } from "../types.js";

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
// Spec #125: no result.json handoff ceremony
assert.doesNotMatch(sys, /Feedback reads result\.json only/i);
assert.match(sys, /host-owned|Finding Store|host settlement/i);
assert.match(sys, /process-chore|Write result\.json/i);
// #137 / #352: unset language → auto Standing-first on stage prompts
assert.match(sys, /node policy: auto/, "stage unset language → auto policy");
assert.ok(sys.startsWith("## Standing node policies"), "stage unset Standing-first");

// Spec #274 review: typed StagePromptExtras — injections land when set on input
const inputWithExtras: typeof inputWithSub & {
  priorSnapshot?: string;
  hypothesisQueueInjection?: string;
  skillL1CatalogInjection?: string;
} = {
  ...inputWithSub,
  priorSnapshot: "<prior-finding-store>\nempty_prior: true\n</prior-finding-store>",
  hypothesisQueueInjection: "<hypothesis-queue>\nactive_n=0\n</hypothesis-queue>",
  skillL1CatalogInjection: "<skill-l1-catalog>\ncount=0\n</skill-l1-catalog>",
};
const sysExtras = stageSystemPrompt(inputWithExtras, task);
assert.match(sysExtras, /prior-finding-store/);
assert.match(sysExtras, /hypothesis-queue/);
assert.match(sysExtras, /skill-l1-catalog/);

const user = stageUserPrompt(inputWithSub, task);
assert.match(user, /Prefer subagent packages/i);
assert.doesNotMatch(user, /write result\.json/i);

const noSub: StageExecutorInput = {
  ...inputWithSub,
  stage: { ...baseStage, id: "init", tools: { allow: ["todo", "write"] } } as any,
  tools: ["todo", "write"],
  toolProfile: { allow: ["todo", "write"] },
};
const sysNo = stageSystemPrompt(noSub, task);
assert.doesNotMatch(sysNo, /Prefer packages/i, "no package steer without subagent tool");
assert.match(sysNo, /narrate/i, "narration still encouraged");

// --- #137 / #352: Standing-first language on stage + subagent + free (shared formatter) ---
const STANDING_HEADING = "## Standing node policies";
const baseTask: TaskEnvelope = {
  taskId: "t-lang",
  conversationId: "c-lang",
  instruction: "assess",
  target: { url: "http://t" },
  scope: {},
};

for (const code of ["zh-TW", "ja", "zh-CN", "en", "auto"] as const) {
  const t = { ...baseTask, agentLanguage: code };
  const stagePrompt = stageSystemPrompt(inputWithSub, t);
  const freePrompt = buildSystemPrompt(t, PENTEST_ROLE_PACK);
  const subPrompt = buildSubagentSystemPrompt({
    pack: {
      missionLines: ["mission"],
      workLines: ["work"],
      toolNames: ["shell", "http"],
    },
    parentPackId: "pentest",
    childTask: t,
  });
  const header =
    code === "auto"
      ? /node policy: auto/
      : new RegExp(`node policy: ${code}`);
  assert.match(stagePrompt, header, `stage has ${code} policy`);
  assert.match(freePrompt, header, `free has ${code} policy`);
  assert.match(subPrompt, header, `subagent has ${code} policy`);
  assert.match(stagePrompt, /agent-authored narrative|user's language/i);
  assert.match(subPrompt, /agent-authored narrative|user's language/i);
  // Standing-first: language block precedes stage identity / mission / work
  assert.ok(stagePrompt.startsWith(STANDING_HEADING), `stage Standing-first for ${code}`);
  assert.ok(freePrompt.startsWith(STANDING_HEADING), `free Standing-first for ${code}`);
  assert.ok(subPrompt.startsWith(STANDING_HEADING), `subagent Standing-first for ${code}`);
  assert.ok(
    stagePrompt.indexOf(STANDING_HEADING) < stagePrompt.indexOf("Hard Graph stage agent"),
    `stage Standing before stage identity for ${code}`,
  );
  // Mission line is exactly "mission" as its own line (not "mission packs" in policy body).
  assert.ok(
    subPrompt.indexOf(STANDING_HEADING) < subPrompt.indexOf("\nmission\n"),
    `subagent Standing before mission for ${code}`,
  );
  assert.match(stagePrompt, /thinking\/reasoning/i, `stage names thinking for ${code}`);
  assert.match(subPrompt, /thinking\/reasoning/i, `subagent names thinking for ${code}`);
  assert.match(stagePrompt, /Do not rewrite.*raw tool stdout/i, `stage raw-tool non-rewrite for ${code}`);
}
// Distinct zh-TW vs zh-CN on stage
const stageTw = stageSystemPrompt(inputWithSub, { ...baseTask, agentLanguage: "zh-TW" });
const stageCn = stageSystemPrompt(inputWithSub, { ...baseTask, agentLanguage: "zh-CN" });
assert.match(stageTw, /Traditional Chinese/);
assert.match(stageCn, /Simplified Chinese/);
assert.notEqual(stageTw, stageCn);

console.log("hard-graph-stage-prompts.test.ts: ok");
