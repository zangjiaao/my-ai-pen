/**
 * Spec #474 S1: composer restore from Case snapshot (not Case sticky template).
 * Run: npx tsx src/lib/composerCaseRestore.test.ts
 */
import assert from "node:assert/strict";
import {
  resolveActiveComposerPartner,
  type MentionTarget,
} from "../components/ChatComposer";
import {
  engagementTemplateFromGraphId,
  pickDefaultMentionTarget,
  restoreComposerFromCaseSnapshot,
  shouldShowCaseLoadingSkeleton,
  shouldShowComposerLoadingSkeleton,
} from "./composerCaseRestore";

function target(partial: Partial<MentionTarget> & { name: string; expertId: string }): MentionTarget {
  return {
    kind: "expert",
    key: `expert:${partial.expertId}`,
    label: partial.name,
    subtitle: "",
    nodeId: "n1",
    selectable: true,
    packId: "default",
    ...partial,
  };
}

const assistant = target({ name: "助理", expertId: "e-default", packId: "default" });
const pentest = target({ name: "渗透", expertId: "e-pen", packId: "pentest" });
const otherPentest = target({ name: "渗透乙", expertId: "e-pen-2", packId: "pentest" });
const offlinePentest = target({
  name: "离线渗透",
  expertId: "e-offline",
  packId: "pentest",
  selectable: false,
});

const experts = [
  { id: "e-default", is_default: true, enabled: true },
  { id: "e-pen", is_default: false, enabled: true },
  { id: "e-pen-2", is_default: false, enabled: true },
  { id: "e-offline", is_default: false, enabled: true },
];

const catalog = [assistant, pentest, otherPentest, offlinePentest];

{
  assert.equal(
    resolveActiveComposerPartner(null),
    null,
    "composer must not invent the first expert while Case restore is pending",
  );
  assert.equal(resolveActiveComposerPartner(assistant), assistant);
  assert.equal(resolveActiveComposerPartner(offlinePentest), null);
}

{
  assert.equal(
    shouldShowCaseLoadingSkeleton({
      activeCaseId: "case-b",
      openingCaseId: "case-b",
      messagesLoading: false,
    }),
    true,
  );
  assert.equal(
    shouldShowCaseLoadingSkeleton({
      activeCaseId: "case-b",
      openingCaseId: null,
      messagesLoading: true,
    }),
    true,
  );
  assert.equal(
    shouldShowCaseLoadingSkeleton({
      activeCaseId: "case-b",
      openingCaseId: "case-a",
      messagesLoading: false,
    }),
    false,
    "a stale Case A request cannot keep Case B's skeleton open",
  );
  assert.equal(
    shouldShowCaseLoadingSkeleton({
      activeCaseId: "case-b",
      openingCaseId: null,
      messagesLoading: false,
    }),
    false,
  );
}

{
  assert.equal(
    shouldShowComposerLoadingSkeleton({
      activeCaseId: null,
      caseSurfaceLoading: false,
      homeRestoreDone: false,
      mentionCatalogLoaded: false,
      hasSelectableMention: false,
      hasSelectedMention: false,
    }),
    true,
    "blank-home route resolution keeps the composer skeleton visible",
  );
  assert.equal(
    shouldShowComposerLoadingSkeleton({
      activeCaseId: null,
      caseSurfaceLoading: false,
      homeRestoreDone: true,
      mentionCatalogLoaded: true,
      hasSelectableMention: true,
      hasSelectedMention: false,
    }),
    true,
    "selectable catalog waits for the default partner pick",
  );
  assert.equal(
    shouldShowComposerLoadingSkeleton({
      activeCaseId: null,
      caseSurfaceLoading: false,
      homeRestoreDone: true,
      mentionCatalogLoaded: true,
      hasSelectableMention: true,
      hasSelectedMention: true,
    }),
    false,
  );
  assert.equal(
    shouldShowComposerLoadingSkeleton({
      activeCaseId: null,
      caseSurfaceLoading: false,
      homeRestoreDone: true,
      mentionCatalogLoaded: true,
      hasSelectableMention: false,
      hasSelectedMention: false,
    }),
    false,
    "an honestly empty/offline catalog renders the real composer",
  );
  assert.equal(
    shouldShowComposerLoadingSkeleton({
      activeCaseId: "case-b",
      caseSurfaceLoading: true,
      homeRestoreDone: true,
      mentionCatalogLoaded: true,
      hasSelectableMention: true,
      hasSelectedMention: true,
    }),
    true,
    "existing Case loading remains authoritative",
  );
}

{
  const out = restoreComposerFromCaseSnapshot(
    {
      task_context: { expert_id: "e-pen", goal_mode: false, engagement_template: "redteam_deep" },
      sessions: { "e-pen": { work_mode: "graph", graph_id: "app_assessment" } },
    },
    catalog,
    experts,
  );
  assert.equal(out.partner?.expertId, "e-pen", "pentest partner from task.expert_id");
  assert.equal(out.engagementTemplate, "app_assessment", "Session graph → composer template");
}

{
  const out = restoreComposerFromCaseSnapshot(
    {
      task_context: { expert_id: "e-pen", engagement_template: "app_assessment" },
      sessions: { "e-pen": { work_mode: "free", graph_id: null } },
    },
    catalog,
    experts,
  );
  assert.equal(out.partner?.expertId, "e-pen", "keep pentest partner");
  assert.equal(out.engagementTemplate, null, "Session Free + Case sticky Graph → 不指定");
}

{
  const out = restoreComposerFromCaseSnapshot(
    {
      task_context: { expert_id: "e-missing", goal_mode: true, engagement_template: "app_assessment" },
    },
    catalog,
    experts,
  );
  assert.equal(out.partner?.expertId, "e-default", "missing expert → #299 default");
  assert.equal(out.engagementTemplate, null, "fallback is 不指定");
}

{
  const out = restoreComposerFromCaseSnapshot(
    {
      task_context: { expert_id: "e-offline", goal_mode: true },
      sessions: { "e-offline": { work_mode: "graph", graph_id: "app_assessment" } },
    },
    catalog,
    experts,
  );
  assert.equal(out.partner?.expertId, "e-default", "offline expert → #299 default");
  assert.equal(out.engagementTemplate, null);
}

{
  const out = restoreComposerFromCaseSnapshot(
    {
      task_context: { expert_id: "e-offline", goal_mode: true },
      sessions: { "e-offline": { work_mode: "graph", graph_id: "app_assessment" } },
    },
    [otherPentest],
    [{ id: "e-pen-2", is_default: true, enabled: true }],
  );
  assert.equal(out.partner?.expertId, "e-pen-2", "fallback may select another pentest Expert");
  assert.equal(out.engagementTemplate, null, "fallback must not inherit the old Expert Graph");
}

{
  const out = restoreComposerFromCaseSnapshot(
    {
      task_context: { expert_id: "e-default", goal_mode: true, engagement_template: "app_assessment" },
      sessions: { "e-default": { work_mode: "graph", graph_id: "app_assessment" } },
    },
    catalog,
    experts,
  );
  assert.equal(out.partner?.expertId, "e-default", "assistant partner kept");
  assert.equal(
    out.engagementTemplate,
    null,
    "pack without declared Graphs stays 不指定 even if session leftover graph_id",
  );
}

{
  const out = restoreComposerFromCaseSnapshot(
    {
      task_context: { expert_id: "e-pen-2" },
      sessions: {
        "e-pen": { work_mode: "graph", graph_id: "redteam_deep" },
        "e-pen-2": { work_mode: "graph", graph_id: "hypothesis_cycle" },
      },
    },
    catalog,
    experts,
  );
  assert.equal(out.partner?.expertId, "e-pen-2", "match expert_id not pack");
  assert.equal(out.engagementTemplate, "hypothesis_cycle", "that expert's Session graph");
}

{
  const out = restoreComposerFromCaseSnapshot(
    {
      task_context: { expert_id: "e-pen", engagement_template: "app_assessment" },
      strix_agents: [
        { expert_id: "e-pen", work_mode: "graph", graph_id: "redteam_deep" },
      ],
    },
    catalog,
    experts,
  );
  assert.equal(out.engagementTemplate, "redteam_deep", "AgentRow Session projection when sessions omitted");
}

{
  const out = restoreComposerFromCaseSnapshot(
    {
      task_context: { expert_id: "e-pen", engagement_template: "app_assessment" },
      sessions: { "e-pen": { work_mode: "free" } },
      strix_agents: [
        { expert_id: "e-pen", work_mode: "graph", graph_id: "app_assessment" },
      ],
    },
    catalog,
    experts,
  );
  assert.equal(out.engagementTemplate, null, "sessions[] wins over AgentRow leftover Graph");
}

{
  const out = restoreComposerFromCaseSnapshot(
    { task_context: { expert_id: "e-pen" } },
    catalog,
    experts,
  );
  assert.equal(out.partner?.expertId, "e-pen");
  assert.equal(out.engagementTemplate, null, "no Session record → 不指定 (not Case sticky)");
}

{
  assert.equal(engagementTemplateFromGraphId("assess"), "app_assessment");
  assert.equal(engagementTemplateFromGraphId("deep"), "redteam_deep");
  assert.equal(engagementTemplateFromGraphId("please hack"), null, "unknown id is 不指定");
}

{
  const pick = pickDefaultMentionTarget(catalog, experts);
  assert.equal(pick?.expertId, "e-default", "#299 prefers is_default");
}

console.log("ok: composerCaseRestore.test.ts");
