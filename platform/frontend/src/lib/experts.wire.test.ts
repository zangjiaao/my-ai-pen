/**
 * Spec #284 G6: composer Graph wire fields for user_message.
 * Run: npx tsx src/lib/experts.wire.test.ts
 */
import {
  canSetExpertAsDefault,
  composerEngagementWireFields,
  ENGAGEMENT_TEMPLATES,
  engagementTemplatesForPack,
  FREE_COMPOSER_WIRE_ALIASES,
  packDeclaresEngagementTemplate,
  composerTemplateForPack,
} from "./experts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

assert(engagementTemplatesForPack("pentest").length === ENGAGEMENT_TEMPLATES.length, "pentest declares product Graphs");
assert(engagementTemplatesForPack("default").length === 0, "default currently declares none");
assert(engagementTemplatesForPack("code-audit").length === 0, "other packs currently declare none");
assert(packDeclaresEngagementTemplate("pentest", "app_assessment"), "pentest declares app_assessment");
assert(!packDeclaresEngagementTemplate("default", "app_assessment"), "assistant does not declare pentest Graphs");
assert(
  composerTemplateForPack("pentest", "app_assessment") === "app_assessment",
  "handoff/manual partner keep Graph the pack declares",
);
assert(
  composerTemplateForPack("default", "app_assessment") === null,
  "handoff to undeclared pack drops Graph to 不指定",
);
assert(composerTemplateForPack("pentest", null) === null, "不指定 stays 不指定");

// G6: product Graph selected on a declaring pack → engagement_template on wire
for (const t of ENGAGEMENT_TEMPLATES) {
  const w = composerEngagementWireFields(t.id, { packId: "pentest" });
  assert(w.engagement_template === t.id, `template ${t.id}`);
  assert(w.allow_postex === t.allowPostex, `postex ${t.id}`);
}

// 不指定 / free → omit; lockstep with platform _FREE_COMPOSER_KEYS (living spec §6.9)
assert(
  FREE_COMPOSER_WIRE_ALIASES.includes("false") && FREE_COMPOSER_WIRE_ALIASES.includes("不指定"),
  "FREE_COMPOSER_WIRE_ALIASES exported for lockstep",
);
for (const v of [null, undefined, ...FREE_COMPOSER_WIRE_ALIASES] as const) {
  const w = composerEngagementWireFields(v as string | null | undefined, { packId: "pentest" });
  assert(w.engagement_template === undefined, `omit free alias ${String(v)}`);
  assert(w.allow_postex === undefined, `omit postex ${String(v)}`);
}
// Catalog default allow_postex when options omit (redteam_deep → true)
{
  const deep = composerEngagementWireFields("redteam_deep", { packId: "pentest" });
  assert(deep.allow_postex === true, "catalog default postex for redteam_deep");
  const assess = composerEngagementWireFields("app_assessment", { packId: "pentest" });
  assert(assess.allow_postex === false, "catalog default postex for app_assessment");
  const cycle = composerEngagementWireFields("hypothesis_cycle", { packId: "pentest" });
  assert(cycle.engagement_template === "hypothesis_cycle", "hypothesis_cycle selectable");
  assert(cycle.allow_postex === false, "hypothesis_cycle postex false");
}

// Simulate user_message / user_steer commonPayload spread (G6 contract, no React)
{
  const wire = composerEngagementWireFields("app_assessment", { packId: "pentest" });
  const commonPayload = {
    engagement: "pentest",
    role: "pentest",
    expert_id: "exp-1",
    ...wire,
  };
  assert(
    commonPayload.engagement_template === "app_assessment",
    "user_message/steer payload includes engagement_template",
  );
  const freePayload = {
    engagement: "pentest",
    ...composerEngagementWireFields(null, { packId: "pentest" }),
  };
  assert(
    !("engagement_template" in freePayload) || freePayload.engagement_template === undefined,
    "不指定 omits engagement_template on wire",
  );
}

// Pack that does not declare the Graph omits template (assistant / other Experts)
const nonPen = composerEngagementWireFields("app_assessment", { packId: "default" });
assert(nonPen.engagement_template === undefined, "undeclared pack omits template");

// Unknown junk is not inventing Graph
const junk = composerEngagementWireFields("please use hard graph", { packId: "pentest" });
assert(junk.engagement_template === undefined, "no NLP invent");

assert(canSetExpertAsDefault(true, "online"), "enabled online expert may become default");
assert(!canSetExpertAsDefault(true, "offline"), "offline expert may not become default");
assert(!canSetExpertAsDefault(false, "online"), "disabled expert may not become default");

console.log("experts.wire.test.ts: ok");
