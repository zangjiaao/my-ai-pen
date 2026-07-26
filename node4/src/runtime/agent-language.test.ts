/**
 * Agent language registry + template policy (#134 / #135).
 * Run: npx tsx src/runtime/agent-language.test.ts
 */
import assert from "node:assert/strict";
import {
  AGENT_LANGUAGE_CODES,
  AGENT_LANGUAGE_REGISTRY,
  AUTO_LANGUAGE_POLICY_TEMPLATE,
  FORCED_LANGUAGE_POLICY_TEMPLATE,
  agentLanguageUiOptions,
  formatAgentLanguageInjection,
  normalizeAgentLanguage,
  resolveAgentLanguage,
  sanitizeLanguageTemplateValue,
} from "./agent-language.js";
import { buildSystemPrompt, renderPromptTemplate } from "./prompt.js";
import { PENTEST_ROLE_PACK } from "../roles/index.js";
import type { TaskEnvelope } from "../types.js";

function ok(cond: unknown, msg: string): void {
  assert.ok(cond, msg);
  console.log("ok", msg);
}

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
  ["de", "auto"], // unregistered until added to registry
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

// --- Policy markers per shipped code ---
const narrativeSurfaces =
  /thinking|todo|tool-call|finding ledger|stage completion|handoff|report markdown/i;
const rawToolExclude = /Do not rewrite.*raw tool stdout/i;

for (const code of ["zh-CN", "zh-TW", "en", "ja"] as const) {
  const block = formatAgentLanguageInjection(code);
  assert.match(block, new RegExp(`node policy: ${code}`), `${code} policy header`);
  assert.match(block, narrativeSurfaces, `${code} lists narrative surfaces`);
  assert.match(block, rawToolExclude, `${code} excludes raw tool rewrite`);
  // Distinct headers — zh-CN vs zh-TW must both appear as themselves
  assert.doesNotMatch(
    block,
    /node policy: auto/,
    `${code} is not auto header`,
  );
}
console.log("ok", "forced codes produce distinct policy markers");

const autoBlock = formatAgentLanguageInjection("auto");
assert.match(autoBlock, /node policy: auto/);
assert.match(autoBlock, /Match the \*\*user's language\*\*/);
assert.match(autoBlock, narrativeSurfaces);
const unsetBlock = formatAgentLanguageInjection(undefined);
assert.equal(unsetBlock, autoBlock, "unset → same as auto policy");
console.log("ok", "auto / unset policy");

// Template var substitution visible in body
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

// --- Smuggle defenses ---
const smuggled = sanitizeLanguageTemplateValue("Evil {{inject}} `x` $y \\z");
assert.doesNotMatch(smuggled, /\{\{/);
assert.doesNotMatch(smuggled, /`/);
assert.doesNotMatch(smuggled, /\$/);
assert.doesNotMatch(smuggled, /\\/);
ok(smuggled.includes("Evil"), "keeps safe letters after smuggle strip");

// If someone stuffed braces into promptName path via forced template path:
const braceInject = renderLanguagePathWithEvil();
function renderLanguagePathWithEvil(): string {
  // Force-render template with hostile vars (simulates compromised registry row).
  return FORCED_LANGUAGE_POLICY_TEMPLATE.replace(
    /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g,
    (_m, key: string) => {
      const vars: Record<string, string> = {
        language_code: "ja{{nested}}",
        language_prompt_name: "Japanese{{x}} and more",
      };
      return sanitizeLanguageTemplateValue(vars[key] ?? "", "");
    },
  );
}
assert.doesNotMatch(braceInject, /\{\{/);
assert.match(braceInject, /node policy: ja/);
console.log("ok", "template value smuggle defenses");

// Spaces preserved in prompt names (unlike strict persona sanitize)
ok(
  sanitizeLanguageTemplateValue("Simplified Chinese") === "Simplified Chinese",
  "language sanitize keeps spaces",
);

// --- Free-path system prompt includes language block ---
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
  if (code === "auto") {
    // unset on task → auto
    assert.match(prompt, /node policy: auto/, "free path unset → auto");
  } else {
    assert.match(
      prompt,
      new RegExp(`node policy: ${code}`),
      `free path includes ${code} policy`,
    );
  }
  assert.match(prompt, /Output language/, `free path has Output language for ${code}`);
}
// Explicit auto
const freeAuto = buildSystemPrompt({ ...baseTask, agentLanguage: "auto" }, PENTEST_ROLE_PACK);
assert.match(freeAuto, /node policy: auto/, "free path explicit auto");
// Alias through free path (normalize happens inside formatter)
const freeJp = buildSystemPrompt({ ...baseTask, agentLanguage: "jp" }, PENTEST_ROLE_PACK);
assert.match(freeJp, /node policy: ja/, "free path alias jp → ja policy");
console.log("ok", "free-path system prompt language injection");

// --- No per-language if-branch extension path: template is shared ---
ok(
  FORCED_LANGUAGE_POLICY_TEMPLATE.includes("{{ language_code }}"),
  "forced template uses language_code var",
);
ok(
  FORCED_LANGUAGE_POLICY_TEMPLATE.includes("{{ language_prompt_name }}"),
  "forced template uses language_prompt_name var",
);
ok(
  !AUTO_LANGUAGE_POLICY_TEMPLATE.includes("{{"),
  "auto template is vars-free fixed text",
);

// UI options mirror registry
const ui = agentLanguageUiOptions();
assert.equal(ui.length, AGENT_LANGUAGE_REGISTRY.length);
assert.deepEqual(
  ui.map((o) => o.code),
  [...AGENT_LANGUAGE_CODES],
);
console.log("ok", "UI options derived from registry");

// renderPromptTemplate still works for persona (regression on optional arg)
const rendered = renderPromptTemplate("Hello {{ expert_name }}", {
  expert_name: "Alice",
});
assert.equal(rendered, "Hello Alice");
console.log("ok", "renderPromptTemplate persona path unchanged");

console.log("agent-language.test.ts: ok");
