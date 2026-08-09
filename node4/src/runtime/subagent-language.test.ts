/**
 * Subagent system prompt language + Package worker four-layer seam (#134 / #137 / #391).
 * Run: npx tsx src/runtime/subagent-language.test.ts
 */
import assert from "node:assert/strict";
import {
  buildSubagentPromptLayers,
  buildSubagentSystemPrompt,
} from "./subagent-session.js";
import { assembleSystemPrompt } from "./prompt.js";
import { formatAgentLanguageInjection } from "./agent-language.js";
import type { TaskEnvelope } from "../types.js";

const pack = {
  missionLines: ["You are a package worker."],
  workLines: ["Act toward this_turn_goal."],
  toolNames: ["shell", "http", "session"],
};

const baseChild: Pick<TaskEnvelope, "target" | "scope" | "agentLanguage"> = {
  target: { url: "http://t" },
  scope: { hosts: ["t"] },
};

const STANDING_HEADING = "## Standing node policies";

for (const code of ["zh-CN", "zh-TW", "en", "ja", "auto"] as const) {
  const prompt = buildSubagentSystemPrompt({
    pack,
    parentPackId: "pentest",
    nodeType: "class_probe",
    childTask: { ...baseChild, agentLanguage: code },
  });
  const expected = formatAgentLanguageInjection(code);
  assert.ok(
    prompt.includes(expected),
    `subagent prompt embeds exact shared formatter output for ${code}`,
  );
  assert.ok(prompt.startsWith(STANDING_HEADING), `subagent Standing-first for ${code}`);
  assert.ok(
    prompt.indexOf(STANDING_HEADING) < prompt.indexOf("You are a package worker."),
    `subagent Standing before mission for ${code}`,
  );
  assert.match(prompt, /Parent pack: pentest/);
  assert.match(prompt, /settlement\.json|Finding Store/i);
}

// Parent language inheritance shape: child task carries agentLanguage
const inherited = buildSubagentSystemPrompt({
  pack,
  parentPackId: "pentest",
  childTask: { ...baseChild, agentLanguage: "jp" }, // alias
});
assert.match(inherited, /node policy: ja/, "subagent normalizes alias via shared formatter");

// Unset → auto
const unset = buildSubagentSystemPrompt({
  pack,
  parentPackId: "pentest",
  childTask: { target: {}, scope: {} },
});
assert.match(unset, /node policy: auto/);

// --- #391 T5: Package worker on shared four-layer seam ---
{
  const childTask = { ...baseChild, agentLanguage: "en" as const };
  const layers = buildSubagentPromptLayers({
    pack,
    parentPackId: "pentest",
    nodeType: "class_probe",
    skillId: "sqli",
    skillBody: "skill-body-marker: use parameterized probes",
    childTask,
  });
  const assembled = assembleSystemPrompt(layers);
  assert.equal(
    buildSubagentSystemPrompt({
      pack,
      parentPackId: "pentest",
      nodeType: "class_probe",
      skillId: "sqli",
      skillBody: "skill-body-marker: use parameterized probes",
      childTask,
    }),
    assembled,
    "buildSubagentSystemPrompt equals assemble(buildSubagentPromptLayers)",
  );

  // Layer ownership
  assert.ok(layers.base.startsWith(STANDING_HEADING), "worker Base Standing-first");
  assert.ok(
    layers.profession.includes("You are a package worker."),
    "worker Profession owns compact mission",
  );
  assert.ok(
    layers.profession.includes("Act toward this_turn_goal."),
    "worker Profession owns compact work",
  );
  assert.ok(layers.runtime.includes("Tools:"), "worker Runtime owns tools");
  assert.ok(
    layers.runtime.includes("Parent pack: pentest"),
    "worker Runtime owns parent pack + node_type label",
  );
  assert.ok(
    layers.runtime.includes("node_type=class_probe"),
    "worker Runtime owns node_type",
  );
  assert.ok(
    layers.runtime.includes("## Return contract"),
    "worker Runtime owns return contract",
  );
  assert.ok(
    layers.runtime.includes("## Loaded skill (sqli)"),
    "worker Runtime owns loaded skill body",
  );
  assert.ok(
    layers.runtime.includes("skill-body-marker: use parameterized probes"),
    "worker Runtime embeds skill body text",
  );
  assert.ok(
    layers.task.includes("Target envelope:"),
    "worker Task owns child target",
  );
  assert.ok(
    layers.task.includes("Scope envelope:"),
    "worker Task owns child scope",
  );
  assert.ok(
    !layers.profession.includes("Tools:"),
    "Profession does not own tools list",
  );
  assert.ok(
    !layers.runtime.includes("Target envelope:"),
    "Runtime does not own Task target JSON",
  );
  assert.ok(
    !layers.base.includes("You are a package worker."),
    "Base does not own Profession mission",
  );

  // Order: Standing → profession mission → tools/return → target
  const standingIdx = assembled.indexOf(STANDING_HEADING);
  const missionIdx = assembled.indexOf("You are a package worker.");
  const toolsIdx = assembled.indexOf("Tools:");
  const returnIdx = assembled.indexOf("## Return contract");
  const skillIdx = assembled.indexOf("## Loaded skill");
  const targetIdx = assembled.indexOf("Target envelope:");
  assert.ok(standingIdx === 0, "Standing at absolute start");
  assert.ok(missionIdx > standingIdx, "profession mission after Base Standing");
  assert.ok(toolsIdx > missionIdx, "tools after profession");
  assert.ok(returnIdx > toolsIdx, "return contract after tools (Runtime)");
  assert.ok(skillIdx > returnIdx, "loaded skill after return contract (Runtime)");
  assert.ok(targetIdx > skillIdx, "Task target after Runtime");

  // Skill-id-only (body missing) still Runtime
  const noBody = buildSubagentPromptLayers({
    pack,
    parentPackId: "pentest",
    skillId: "xss",
    childTask,
  });
  assert.match(
    noBody.runtime,
    /Requested skill_id=xss was not loaded/,
    "missing skill body note stays in Runtime",
  );

  // No skill: progressive-load one-liner in Runtime
  const noSkill = buildSubagentPromptLayers({
    pack,
    parentPackId: "pentest",
    childTask,
  });
  assert.match(
    noSkill.runtime,
    /Load at most one skill/,
    "no-skill progressive load guidance in Runtime",
  );
}

console.log("subagent-language.test.ts: ok");
