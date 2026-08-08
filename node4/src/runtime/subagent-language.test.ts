/**
 * Subagent system prompt language injection (#134 / #137).
 * Run: npx tsx src/runtime/subagent-language.test.ts
 */
import assert from "node:assert/strict";
import { buildSubagentSystemPrompt } from "./subagent-session.js";
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

console.log("subagent-language.test.ts: ok");
