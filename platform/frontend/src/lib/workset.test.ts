/**
 * Spec #311 FE contract: Workset inventory helpers (not choice chrome).
 */
import assert from "node:assert/strict";
import {
  currentInProgressWorksetItemId,
  orderWorksetItems,
  parseWorksetProjection,
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
  "default Next order",
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

const proj = parseWorksetProjection({
  items,
  open_count: 4,
  goal: { status: "running", residual: { class: "awaiting_scope_confirm", pending_host_count: 1 } },
});
assert.equal(proj.items.length, 4);
assert.ok(worksetHasVisibleContent(proj));
assert.equal(currentInProgressWorksetItemId(proj), "run");
assert.equal(currentInProgressWorksetItemId({ items: [] }), null);
assert.equal(currentInProgressWorksetItemId(null), null);

console.log("workset.test.ts: ok");
