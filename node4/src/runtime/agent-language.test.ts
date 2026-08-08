/**
 * Agent language registry + template policy (#134 / #135) + review fixes.
 * Run: npx tsx src/runtime/agent-language.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGENT_LANGUAGE_CODES,
  AGENT_LANGUAGE_REGISTRY,
  AUTO_LANGUAGE_POLICY_TEMPLATE,
  FORCED_LANGUAGE_POLICY_TEMPLATE,
  agentLanguageCatalogPath,
  extractAgentLanguageFromMessage,
  formatAgentLanguageInjection,
  normalizeAgentLanguage,
  resolveAgentLanguage,
  sanitizeLanguageTemplateValue,
} from "./agent-language.js";
import { buildSystemPrompt, renderPromptTemplate } from "./prompt.js";
import { PENTEST_ROLE_PACK } from "../roles/index.js";
import type { TaskEnvelope } from "../types.js";
import { normalizeTaskAssign } from "../platform-smoke.js";

function ok(cond: unknown, msg: string): void {
  assert.ok(cond, msg);
  console.log("ok", msg);
}

// --- Catalog JSON is the single structural source ---
const catalogPath = agentLanguageCatalogPath();
const catalog = JSON.parse(readFileSync(catalogPath, "utf8")) as {
  default: string;
  languages: Array<{ code: string; ui_label: string; prompt_name?: string; aliases?: string[] }>;
};
ok(catalog.default === "auto", "catalog default is auto");
ok(
  catalog.languages.map((r) => r.code).join(",") === AGENT_LANGUAGE_CODES.join(","),
  "registry codes match catalog JSON",
);

// Cross-stack shipped copies must be byte-identical to Node's catalog.
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../../..");
const shipPaths = [
  join(repoRoot, "shared/agent-language-catalog.json"),
  join(repoRoot, "platform/backend/app/services/agent_language_catalog.json"),
  join(repoRoot, "platform/frontend/src/lib/agent-language-catalog.json"),
];
const nodeBytes = readFileSync(catalogPath);
for (const p of shipPaths) {
  if (!existsSync(p)) {
    throw new Error(`missing shipped catalog copy: ${p}`);
  }
  assert.equal(
    readFileSync(p).toString("utf8"),
    nodeBytes.toString("utf8"),
    `catalog byte-identical: ${p}`,
  );
}
console.log("ok", "shipped catalog copies are byte-identical");

// --- Registry shape ---
ok(
  AGENT_LANGUAGE_CODES.join(",") === "auto,zh-CN,zh-TW,en,ja",
  "shipped catalog codes exactly auto,zh-CN,zh-TW,en,ja",
);
ok(
  AGENT_LANGUAGE_REGISTRY.every((e) => e.code && e.uiLabel),
  "every registry row has code + uiLabel",
);
ok(
  AGENT_LANGUAGE_REGISTRY.filter((e) => e.code !== "auto").every((e) => e.promptName),
  "forced rows have promptName",
);
ok(
  normalizeAgentLanguage("zh-CN") !== normalizeAgentLanguage("zh-TW"),
  "zh-CN and zh-TW never collapse",
);

// --- Normalize / aliases ---
const aliasCases: Array<[unknown, string]> = [
  [undefined, "auto"],
  [null, "auto"],
  ["", "auto"],
  ["auto", "auto"],
  ["follow", "auto"],
  ["zh-CN", "zh-CN"],
  ["zh", "zh-CN"],
  ["zh-cn", "zh-CN"],
  ["chinese", "zh-CN"],
  ["中文", "zh-CN"],
  ["简体", "zh-CN"],
  ["zh-TW", "zh-TW"],
  ["zh-tw", "zh-TW"],
  ["繁體", "zh-TW"],
  ["繁体", "zh-TW"],
  ["traditional chinese", "zh-TW"],
  ["en", "en"],
  ["english", "en"],
  ["en-US", "en"],
  ["ja", "ja"],
  ["jp", "ja"],
  ["japanese", "ja"],
  ["日本語", "ja"],
  ["JA", "ja"],
  ["not-a-locale", "auto"],
  ["de", "auto"],
  ["{{evil}}", "auto"],
];
for (const [raw, want] of aliasCases) {
  assert.equal(normalizeAgentLanguage(raw), want, `normalize(${JSON.stringify(raw)})`);
}
console.log("ok", "alias / normalize matrix");

// --- Resolve ---
const autoR = resolveAgentLanguage(undefined);
ok(autoR.mode === "auto" && autoR.code === "auto", "unset resolves auto");
const jaR = resolveAgentLanguage("jp");
ok(jaR.mode === "forced" && jaR.code === "ja" && jaR.promptName === "Japanese", "jp → forced ja");
const twR = resolveAgentLanguage("繁體");
ok(
  twR.mode === "forced" && twR.code === "zh-TW" && twR.promptName === "Traditional Chinese",
  "繁體 → forced zh-TW",
);

// --- Policy markers per shipped code (#352 Standing shell) ---
const STANDING_HEADING = "## Standing node policies";
const narrativeSurfaces =
  /thinking|todo|tool-call|finding ledger|stage completion|handoff|report markdown/i;
const thinkingSameSurface =
  /thinking\/reasoning shown in Chat|thinking\/reasoning text shown in Chat/i;
const sameLanguageNotSideChannel = /same.?language|not an English-only/i;
const rawToolExclude = /Do not rewrite.*raw tool stdout/i;

for (const code of ["zh-CN", "zh-TW", "en", "ja"] as const) {
  const block = formatAgentLanguageInjection(code);
  assert.ok(block.startsWith(STANDING_HEADING), `${code} starts with Standing shell`);
  assert.match(block, new RegExp(`node policy: ${code}`), `${code} policy header`);
  assert.match(block, /### Output language \(node policy:/, `${code} language under Standing as ###`);
  assert.match(block, narrativeSurfaces, `${code} lists narrative surfaces`);
  assert.match(block, thinkingSameSurface, `${code} names thinking shown in Chat`);
  assert.match(block, sameLanguageNotSideChannel, `${code} treats thinking as same-language surface`);
  assert.match(block, rawToolExclude, `${code} excludes raw tool rewrite`);
  assert.doesNotMatch(block, /node policy: auto/, `${code} is not auto header`);
}
console.log("ok", "forced codes produce distinct Standing policy markers");

const autoBlock = formatAgentLanguageInjection("auto");
assert.ok(autoBlock.startsWith(STANDING_HEADING), "auto starts with Standing shell");
assert.match(autoBlock, /node policy: auto/);
assert.match(autoBlock, /Match the \*\*user's language\*\*/);
assert.match(autoBlock, narrativeSurfaces);
assert.match(autoBlock, thinkingSameSurface, "auto names thinking shown in Chat");
assert.match(autoBlock, sameLanguageNotSideChannel, "auto treats thinking as same-language surface");
assert.match(autoBlock, rawToolExclude, "auto excludes raw tool rewrite");
const unsetBlock = formatAgentLanguageInjection(undefined);
assert.equal(unsetBlock, autoBlock, "unset → same as auto policy");
console.log("ok", "auto / unset Standing policy");

const jaBlock = formatAgentLanguageInjection("ja");
assert.match(jaBlock, /in \*\*Japanese\*\*/);
assert.match(jaBlock, /node policy: ja/);
const twBlock = formatAgentLanguageInjection("zh-TW");
assert.match(twBlock, /in \*\*Traditional Chinese\*\*/);
assert.match(twBlock, /node policy: zh-TW/);
const cnBlock = formatAgentLanguageInjection("zh-CN");
assert.match(cnBlock, /in \*\*Simplified Chinese\*\*/);
assert.notEqual(cnBlock, twBlock, "zh-CN and zh-TW policy bodies differ");
console.log("ok", "template vars language_code + language_prompt_name");

// --- Smuggle defenses (shared prompt-template engine) ---
const smuggled = sanitizeLanguageTemplateValue("Evil {{inject}} `x` $y \\z");
assert.doesNotMatch(smuggled, /\{\{/);
assert.doesNotMatch(smuggled, /`/);
assert.doesNotMatch(smuggled, /\$/);
assert.doesNotMatch(smuggled, /\\/);
ok(smuggled.includes("Evil"), "keeps safe letters after smuggle strip");

const viaSharedEngine = renderPromptTemplate(
  FORCED_LANGUAGE_POLICY_TEMPLATE,
  { language_code: "ja{{nested}}", language_prompt_name: "Japanese{{x}}" },
  { sanitizeValue: sanitizeLanguageTemplateValue },
);
assert.doesNotMatch(viaSharedEngine, /\{\{/);
assert.match(viaSharedEngine, /node policy: ja/);
console.log("ok", "template value smuggle defenses via prompt-template");

ok(
  sanitizeLanguageTemplateValue("Simplified Chinese") === "Simplified Chinese",
  "language sanitize keeps spaces",
);

// --- Free-path system prompt includes language block Standing-first (#352) ---
const baseTask = {
  taskId: "t-lang",
  conversationId: "c-lang",
  instruction: "assess target",
  target: { url: "http://t" },
  scope: {},
} as TaskEnvelope;

for (const code of ["auto", "zh-CN", "zh-TW", "en", "ja"] as const) {
  const prompt = buildSystemPrompt(
    { ...baseTask, agentLanguage: code === "auto" ? undefined : code },
    PENTEST_ROLE_PACK,
  );
  assert.ok(
    prompt.startsWith(STANDING_HEADING),
    `free path Standing-first for ${code === "auto" ? "unset→auto" : code}`,
  );
  if (code === "auto") {
    assert.match(prompt, /node policy: auto/, "free path unset → auto");
  } else {
    assert.match(
      prompt,
      new RegExp(`node policy: ${code}`),
      `free path includes ${code} policy`,
    );
  }
  assert.match(prompt, /Output language/, `free path has Output language for ${code}`);
  // Standing language precedes mission/work pack content (mission lines are not Standing).
  const standingIdx = prompt.indexOf(STANDING_HEADING);
  const rolePackIdx = prompt.indexOf("Role pack:");
  assert.ok(standingIdx === 0, `free Standing at start for ${code}`);
  assert.ok(rolePackIdx > standingIdx, `free Standing before Role pack for ${code}`);
}
const freeAuto = buildSystemPrompt({ ...baseTask, agentLanguage: "auto" }, PENTEST_ROLE_PACK);
assert.match(freeAuto, /node policy: auto/, "free path explicit auto");
assert.ok(freeAuto.startsWith(STANDING_HEADING), "free explicit auto Standing-first");
const freeJp = buildSystemPrompt({ ...baseTask, agentLanguage: "jp" }, PENTEST_ROLE_PACK);
assert.match(freeJp, /node policy: ja/, "free path alias jp → ja policy");
assert.ok(freeJp.startsWith(STANDING_HEADING), "free alias jp Standing-first");
console.log("ok", "free-path system prompt Standing-first language injection");

ok(
  FORCED_LANGUAGE_POLICY_TEMPLATE.includes("{{ language_code }}"),
  "forced template uses language_code var",
);
ok(
  FORCED_LANGUAGE_POLICY_TEMPLATE.includes("{{ language_prompt_name }}"),
  "forced template uses language_prompt_name var",
);
ok(!AUTO_LANGUAGE_POLICY_TEMPLATE.includes("{{"), "auto template is vars-free fixed text");

// --- Envelope boundary: extract always returns registry code ---
assert.equal(
  extractAgentLanguageFromMessage({
    type: "user_steer",
    text: "继续扫",
    worker_limits: { agent_language: "jp", worker_max_ms: 1000 },
  }),
  "ja",
  "extract normalizes alias jp → ja",
);
assert.equal(
  extractAgentLanguageFromMessage({
    type: "task_assign",
    agent_language: "zh-TW",
  }),
  "zh-TW",
);
assert.equal(
  extractAgentLanguageFromMessage({ type: "user_steer", text: "go on" }),
  "auto",
  "missing language → auto (not undefined)",
);
const steerLang = extractAgentLanguageFromMessage({
  worker_limits: { agent_language: "zh-TW" },
});
const steerPrompt = buildSystemPrompt(
  { ...baseTask, agentLanguage: steerLang },
  PENTEST_ROLE_PACK,
);
assert.match(steerPrompt, /node policy: zh-TW/, "language after steer-shaped rebuild");
console.log("ok", "envelope extract always returns wire code");

// --- platform-smoke normalizeTaskAssign shares language extract ---
const smoke = normalizeTaskAssign({
  type: "task_assign",
  worker_limits: { agent_language: "ja" },
  initial_instruction: "hi",
  target: { type: "url", value: "http://t" },
});
assert.equal(smoke.agentLanguage, "ja", "smoke path carries normalized language");
const smokeAlias = normalizeTaskAssign({
  agent_language: "繁體",
  initial_instruction: "x",
});
assert.equal(smokeAlias.agentLanguage, "zh-TW", "smoke normalizes alias");
console.log("ok", "platform-smoke normalizeTaskAssign language parity");

// renderPromptTemplate persona path
const rendered = renderPromptTemplate("Hello {{ expert_name }}", {
  expert_name: "Alice",
});
assert.equal(rendered, "Hello Alice");
console.log("ok", "renderPromptTemplate persona path unchanged");

console.log("agent-language.test.ts: ok");
