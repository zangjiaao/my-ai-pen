/**
 * Spec #284 G6: composer Graph wire fields for user_message.
 * Run: npx tsx src/lib/experts.wire.test.ts
 */
import {
  composerEngagementWireFields,
  ENGAGEMENT_TEMPLATES,
  FREE_COMPOSER_WIRE_ALIASES,
} from "./experts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

// G6: product Graph selected → engagement_template on wire
for (const t of ENGAGEMENT_TEMPLATES) {
  const w = composerEngagementWireFields(t.id, { isPentest: true });
  assert(w.engagement_template === t.id, `template ${t.id}`);
  assert(w.allow_postex === t.allowPostex, `postex ${t.id}`);
}

// 不指定 / free → omit; lockstep with platform _FREE_COMPOSER_KEYS (living spec §6.9)
assert(
  FREE_COMPOSER_WIRE_ALIASES.includes("false") && FREE_COMPOSER_WIRE_ALIASES.includes("不指定"),
  "FREE_COMPOSER_WIRE_ALIASES exported for lockstep",
);
for (const v of [null, undefined, ...FREE_COMPOSER_WIRE_ALIASES] as const) {
  const w = composerEngagementWireFields(v as string | null | undefined, { isPentest: true });
  assert(w.engagement_template === undefined, `omit free alias ${String(v)}`);
  assert(w.allow_postex === undefined, `omit postex ${String(v)}`);
}
// Catalog default allow_postex when options omit (redteam_deep → true)
{
  const deep = composerEngagementWireFields("redteam_deep", { isPentest: true });
  assert(deep.allow_postex === true, "catalog default postex for redteam_deep");
  const assess = composerEngagementWireFields("app_assessment", { isPentest: true });
  assert(assess.allow_postex === false, "catalog default postex for app_assessment");
  const cycle = composerEngagementWireFields("hypothesis_cycle", { isPentest: true });
  assert(cycle.engagement_template === "hypothesis_cycle", "hypothesis_cycle selectable");
  assert(cycle.allow_postex === false, "hypothesis_cycle postex false");
}

// Simulate user_message / user_steer commonPayload spread (G6 contract, no React)
{
  const wire = composerEngagementWireFields("app_assessment", { isPentest: true });
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
    ...composerEngagementWireFields(null, { isPentest: true }),
  };
  assert(
    !("engagement_template" in freePayload) || freePayload.engagement_template === undefined,
    "不指定 omits engagement_template on wire",
  );
}

// Non-pentest seat never sends Graph template
const nonPen = composerEngagementWireFields("app_assessment", { isPentest: false });
assert(nonPen.engagement_template === undefined, "non-pentest omits template");

// Unknown junk is not inventing Graph
const junk = composerEngagementWireFields("please use hard graph", { isPentest: true });
assert(junk.engagement_template === undefined, "no NLP invent");

console.log("experts.wire.test.ts: ok");
