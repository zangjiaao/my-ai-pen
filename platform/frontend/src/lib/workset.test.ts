/**
 * Spec #311 FE contract: 下一步 vs Tasks separation helpers.
 */
import assert from "node:assert/strict";
import {
  orderWorksetItems,
  parseWorksetProjection,
  worksetFamilyLabel,
  worksetHasVisibleContent,
  worksetInProgressLabel,
  type WorksetItem,
} from "./workset.ts";

const items: WorksetItem[] = [
  {
    id: "h1",
    family: "t_host",
    title: "side.lab",
    status: "proposed",
    auto_eligible: false,
    sort_order: 10,
    created_at: "2026-01-01T00:00:00Z",
  },
  {
    id: "s1",
    family: "t_surface",
    title: "/admin",
    status: "proposed",
    auto_eligible: true,
    sort_order: 20,
    created_at: "2026-01-01T00:00:01Z",
  },
  {
    id: "a1",
    family: "t_surface",
    title: "adopted surf",
    status: "adopted",
    sort_order: 30,
    created_at: "2026-01-01T00:00:02Z",
  },
  {
    id: "run",
    family: "t_surface",
    title: "running",
    status: "adopted",
    in_progress: true,
    expert_name: "pentest-1",
    graph_id: "app_assessment",
    work_mode: "graph",
    sort_order: 40,
    created_at: "2026-01-01T00:00:03Z",
  },
];

const ordered = orderWorksetItems(items);
assert.deepEqual(
  ordered.map((i) => i.id),
  ["run", "a1", "s1", "h1"],
  "default 下一步 order",
);

assert.equal(worksetInProgressLabel(ordered[0]!), "pentest-1 · app_assessment");
assert.equal(
  worksetInProgressLabel({
    id: "f",
    family: "t_surface",
    status: "adopted",
    in_progress: true,
    expert_name: "audit",
    work_mode: "free",
  }),
  "audit",
  "Free in-progress shows expert only",
);

assert.equal(worksetFamilyLabel("t_host"), "主机");
assert.equal(worksetFamilyLabel("t_surface"), "面");

const proj = parseWorksetProjection({
  version: 1,
  items,
  open_count: 4,
  goal: { terminal: "goal_complete", residual: { class: "awaiting_scope_confirm" } },
});
assert.equal(proj.items[0]?.id, "run");
assert.ok(worksetHasVisibleContent(proj));

// Open items survive conceptually: parse does not drop proposed when goal complete
assert.ok(proj.items.some((i) => i.status === "proposed"));

// Tasks plan_tree is a different type — ensure we don't mix fields
const planTreeShape = { node_id: "graph-stage-recon", title: "Recon", status: "done" };
assert.equal("family" in planTreeShape, false, "Tasks nodes are not Workset items");

console.log("workset.test.ts: ok");
