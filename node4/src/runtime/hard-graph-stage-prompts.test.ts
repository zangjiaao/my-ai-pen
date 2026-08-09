/**
 * Probe-stage harness: narration + prefer packages (#101).
 * Language policy injection on stage + free/subagent parity (#134 / #137).
 * Prompt layers T4: Graph stage on same seam + Profession core (#390).
 * Run: npx tsx src/runtime/hard-graph-stage-prompts.test.ts
 */
import assert from "node:assert/strict";
import {
  buildStagePromptLayers,
  stageSystemPrompt,
  stageUserPrompt,
} from "./hard-graph-stage-executor.js";
import type { StageExecutorInput } from "./hard-graph-runner.js";
import { assembleSystemPrompt, buildSystemPrompt } from "./prompt.js";
import { buildSubagentSystemPrompt } from "./subagent-session.js";
import { PENTEST_ROLE_PACK } from "../roles/index.js";
import type { TaskEnvelope } from "../types.js";

const pack = PENTEST_ROLE_PACK;

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

const sys = stageSystemPrompt(inputWithSub, task, pack);
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
const sysExtras = stageSystemPrompt(inputWithExtras, task, pack);
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
const sysNo = stageSystemPrompt(noSub, task, pack);
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
  const stagePrompt = stageSystemPrompt(inputWithSub, t, pack);
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
const stageTw = stageSystemPrompt(inputWithSub, { ...baseTask, agentLanguage: "zh-TW" }, pack);
const stageCn = stageSystemPrompt(inputWithSub, { ...baseTask, agentLanguage: "zh-CN" }, pack);
assert.match(stageTw, /Traditional Chinese/);
assert.match(stageCn, /Simplified Chinese/);
assert.notEqual(stageTw, stageCn);

// --- #390 T4: Profession-core contract markers on Graph stage (prompt-layers.md §6) ---
// Markers chosen from experts/pentest/work.md (existing English rule phrases, not new tokens).
{
  const layers = buildStagePromptLayers(inputWithSub, task, pack);
  const assembled = assembleSystemPrompt(layers);
  assert.equal(
    stageSystemPrompt(inputWithSub, task, pack),
    assembled,
    "stageSystemPrompt equals assemble(buildStagePromptLayers)",
  );

  // Layer order: Base (Standing) → Profession → Runtime (stage identity) → Task (target)
  assert.ok(layers.base.startsWith(STANDING_HEADING), "stage Base Standing-first");
  assert.ok(layers.profession.length > 0, "stage Profession non-empty");
  assert.ok(
    layers.runtime.includes("Hard Graph stage agent"),
    "stage identity is Runtime (not Base)",
  );
  assert.ok(layers.task.includes("Target:"), "stage Task owns target");
  assert.ok(
    !layers.profession.includes("Hard Graph stage agent"),
    "Profession does not own Graph stage law",
  );
  assert.ok(
    !layers.runtime.includes("Target:"),
    "Runtime does not own Task target JSON",
  );

  const standingIdx = assembled.indexOf(STANDING_HEADING);
  const stageIdIdx = assembled.indexOf("Hard Graph stage agent");
  const targetIdx = assembled.indexOf("Target:");
  // Profession sits between Base and Runtime stage identity
  // (work.md headings are stripped on pack load — use body phrase "Causality")
  assert.ok(standingIdx === 0, "Standing at absolute start");
  assert.ok(stageIdIdx > standingIdx, "Runtime stage identity after Base");
  assert.ok(targetIdx > stageIdIdx, "Task target after Runtime stage law");
  const causalityIdx = assembled.search(/Causality/i);
  assert.ok(
    causalityIdx > standingIdx && causalityIdx < stageIdIdx,
    "Profession (proof-bar body) before Runtime stage identity",
  );

  // 1. Progressive skill load discipline (at most one / progressive / never bulk-load)
  // Markers from experts/pentest/work.md body lines (pack loader drops markdown headings).
  assert.match(
    layers.profession,
    /at most one/i,
    "P3 marker: progressive skill — at most one methodology body",
  );
  assert.match(
    layers.profession,
    /Never bulk-load|bulk-load/i,
    "P3 marker: progressive skill — never bulk-load",
  );
  // 2. Proof bar expectations (causality / reproducibility / impact)
  assert.match(
    layers.profession,
    /Causality/i,
    "P3 marker: proof bar — causality",
  );
  assert.match(
    layers.profession,
    /Reproducibility/i,
    "P3 marker: proof bar — reproducibility",
  );
  assert.match(layers.profession, /Impact/i, "P3 marker: proof bar — impact");
  // 3. Fact/surface vs finding separation (body: "fact: process cognition")
  assert.match(
    layers.profession,
    /process cognition|finding\(confirm\).*product vulns/i,
    "P3 marker: fact/surface vs finding separation",
  );
  // 4. Scope/RoE / no invent surfaces (profession + Runtime fail-closed)
  assert.match(
    assembled,
    /invented host assets|do not invent surfaces/i,
    "P3 marker: no invent surfaces / host assets",
  );
  assert.match(
    layers.runtime,
    /Fail closed|Stay in RoE\/scope|authorized/i,
    "P3 marker: scope/RoE discipline on stage Runtime",
  );

  // Skill L1 catalog is Runtime capability; prior seed is Task
  const layersExtras = buildStagePromptLayers(inputWithExtras, task, pack);
  assert.match(layersExtras.runtime, /skill-l1-catalog/, "skill L1 in Runtime");
  assert.match(layersExtras.task, /prior-finding-store/, "prior seed in Task");
}

console.log("hard-graph-stage-prompts.test.ts: ok");
