/**
 * Pure unit checks for engagement → RoE mapping (no NLP invent).
 * Run: node --import tsx src/runtime/engagement-roe.test.ts
 */
import {
  formatRoeInjection,
  isKnownEngagementTemplate,
  resolveEngagementRoe,
} from "./engagement-roe.js";
import { buildSystemPrompt } from "./prompt.js";
import { PENTEST_ROLE_PACK } from "../roles/index.js";
import type { TaskEnvelope } from "../types.js";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
  console.log("ok", msg);
}

// Assessment: post-ex OFF
const assess = resolveEngagementRoe({ engagementTemplate: "app_assessment" });
assert(assess.allowPostex === false, "app_assessment postex off");
assert(assess.bans.some((b) => /webshell|lateral|Privilege/i.test(b)), "assessment bans host takeover");
const assessText = formatRoeInjection(assess);
assert(assessText.includes("allow_postex: false"), "injection has allow_postex false");
assert(assessText.includes("postex-host") || assessText.includes("Do NOT use post-exploitation"), "assessment blocks postex skills");

// Deep: post-ex ON
const deep = resolveEngagementRoe({ engagementTemplate: "redteam_deep" });
assert(deep.allowPostex === true, "redteam_deep postex on");
const deepText = formatRoeInjection(deep);
assert(deepText.includes("allow_postex: true"), "injection has allow_postex true");
assert(deepText.includes("Post-exploitation skills"), "deep allows postex");

// Explicit override wins over template
assert(
  resolveEngagementRoe({ engagementTemplate: "redteam_deep", allowPostex: false }).allowPostex === false,
  "explicit allow_postex false overrides deep",
);
assert(
  resolveEngagementRoe({ engagementTemplate: "app_assessment", allowPostex: true }).allowPostex === true,
  "explicit allow_postex true overrides assessment",
);

// Conservative default (blank)
assert(resolveEngagementRoe({}).allowPostex === false, "blank defaults postex off");
assert(resolveEngagementRoe({ engagement: "pentest" }).allowPostex === false, "plain pentest postex off");

// Known templates only for isKnown helper (not free-text invent path)
assert(isKnownEngagementTemplate("app_assessment"), "known app_assessment");
assert(isKnownEngagementTemplate("redteam_deep"), "known redteam_deep");
assert(!isKnownEngagementTemplate("please do a red team on dvwa"), "free text not a template");

// System prompt differs by engagement
const baseTask: TaskEnvelope = {
  taskId: "t1",
  conversationId: "c1",
  instruction: "Assess authorized target",
  target: { type: "url", value: "http://example.test" },
  scope: { allow: ["example.test"] },
  engagement: "pentest",
};
const pAssess = buildSystemPrompt(
  { ...baseTask, engagementTemplate: "app_assessment", allowPostex: false },
  PENTEST_ROLE_PACK,
);
const pDeep = buildSystemPrompt(
  { ...baseTask, engagementTemplate: "redteam_deep", allowPostex: true },
  PENTEST_ROLE_PACK,
);
assert(pAssess.includes("allow_postex: false"), "system prompt assessment");
assert(pDeep.includes("allow_postex: true"), "system prompt deep");
assert(pAssess.includes("withheld") || pAssess.includes("Do NOT use post-exploitation"), "assessment skill gate");
assert(pDeep.includes("pentest-postex-host") || pDeep.includes("Post-exploitation skills may be used"), "deep lists postex");
// No free-text keyword invent: instruction alone must not flip RoE
const fromInstructionOnly = buildSystemPrompt(
  {
    ...baseTask,
    instruction: "please red team and lateral move on the whole network",
  },
  PENTEST_ROLE_PACK,
);
assert(fromInstructionOnly.includes("allow_postex: false"), "instruction free text does not invent postex");

console.log("\nALL engagement-roe tests passed");
