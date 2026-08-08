/**
 * Spec #321 S1 — Task Map lifecycle (E1/E2/E5/E6) pure + Free TodoStore.
 * Run: npx tsx src/stores/task-map.test.ts
 */
import assert from "node:assert/strict";
import {
  TaskMapHistory,
  countsFromPlanTree,
  shouldSealPlanTree,
  buildRevisionLabel,
} from "./task-map.js";
import {
  TodoStore,
  freeInitReplaceDenied,
  applyTodoOp,
  type TodoPhase,
} from "./todo.js";

function workItems(
  items: Array<{ title: string; status?: string }>,
): unknown[] {
  return items.map((it, i) => ({
    node_id: `todo-task-tasks-${i}`,
    title: it.title,
    status: it.status || "pending",
    kind: "task",
    level: "work_item",
    source: "plan",
  }));
}

// --- pure helpers ---
assert.deepEqual(countsFromPlanTree([]), { done: 0, total: 0, open: 0 });
const sample = workItems([
  { title: "A", status: "done" },
  { title: "B", status: "running" },
  { title: "C", status: "pending" },
]);
assert.deepEqual(countsFromPlanTree(sample), { done: 1, total: 3, open: 2 });
assert.equal(shouldSealPlanTree(sample), false);
assert.equal(
  shouldSealPlanTree(workItems([{ title: "A", status: "done" }, { title: "B", status: "skipped" }])),
  true,
);
assert.equal(shouldSealPlanTree([]), false, "empty not sealed");

// Failed L1 + open L2 → refuse seal
const failedL1OpenL2 = [
  { node_id: "stage-surface", title: "Surface", kind: "stage", level: "stage", status: "failed" },
  {
    node_id: "todo-1",
    title: "Still open",
    kind: "task",
    level: "work_item",
    status: "pending",
    parent_id: "stage-surface",
  },
];
assert.equal(shouldSealPlanTree(failedL1OpenL2), false, "failed L1 + open L2 no seal");

const failedL1ClosedL2 = [
  { node_id: "stage-surface", title: "Surface", kind: "stage", level: "stage", status: "failed" },
  {
    node_id: "todo-1",
    title: "Dropped",
    kind: "task",
    level: "work_item",
    status: "skipped",
    parent_id: "stage-surface",
  },
];
assert.equal(shouldSealPlanTree(failedL1ClosedL2), true, "failed L1 but L2 closed may seal");

assert.ok(buildRevisionLabel({ work_mode: "free", done: 1, total: 2 }).includes("Free"));
assert.equal(
  buildRevisionLabel({ work_mode: "graph", title: "My Plan", done: 0, total: 1 }),
  "My Plan",
);

// --- freeInitReplaceDenied E2 sealed path ---
const seedPhases: TodoPhase[] = [
  {
    name: "Tasks",
    tasks: [
      { content: "Map surface", status: "completed" },
      { content: "Probe auth", status: "completed" },
    ],
  },
];
assert.equal(
  freeInitReplaceDenied(seedPhases, false, { liveSealed: true }),
  undefined,
  "E2: sealed + init no grant allowed",
);
assert.ok(
  freeInitReplaceDenied(seedPhases, false, { liveSealed: false }),
  "open-ish non-empty without grant denied",
);
assert.equal(freeInitReplaceDenied(seedPhases, true, { liveSealed: false }), undefined);

// --- TaskMapHistory E1/E2/E5/E6 ---
const map = new TaskMapHistory();
assert.equal(map.isEmpty, true);
assert.equal(map.revisionCount(), 0);

// First install (empty Session)
const live1 = map.installLive(workItems([{ title: "A" }, { title: "B" }]), { work_mode: "free" });
assert.ok(live1);
assert.equal(map.isSealed, false);
assert.equal(map.revisionCount(), 1);
assert.equal(map.archivedCount(), 0);

// E5 maintain — mutate live, no new revision
map.mutateLive(workItems([{ title: "A", status: "done" }, { title: "B", status: "running" }]));
assert.equal(map.liveRevisionId, live1, "same live id on E5");
assert.equal(map.revisionCount(), 1);
assert.equal(map.archivedCount(), 0);

// E1 seal when all terminal
map.mutateLive(workItems([{ title: "A", status: "done" }, { title: "B", status: "skipped" }]));
assert.equal(map.isSealed, true, "E1 sealed");
assert.equal(map.liveRevisionId, live1, "E1 keeps same live id");
assert.equal(map.revisionCount(), 1, "E1 does not mint revision");

// E6 settle alone — no archive
map.onSessionSettleOrPark();
assert.equal(map.revisionCount(), 1);
assert.equal(map.archivedCount(), 0);
assert.equal(map.liveRevisionId, live1);

// E2 sealed + new plan → archive then new live
const live2 = map.archiveThenInstall(workItems([{ title: "Chapter 2" }]), { work_mode: "free" });
assert.notEqual(live2, live1);
assert.equal(map.archivedCount(), 1);
assert.equal(map.revisionCount(), 2);
assert.equal(map.isSealed, false);
const archivedTree = map.getArchivedPlanTree(
  map.projection().task_map_revisions.find((r) => !r.is_live)!.id,
);
assert.ok(archivedTree);
assert.equal(
  (archivedTree as Array<{ title?: string }>).filter((n) => n.title === "A" || n.title === "B").length,
  2,
);

// Archived immutable: mutate live must not change archived snapshot
map.mutateLive(workItems([{ title: "Chapter 2", status: "done" }, { title: "Extra" }]));
const archivedAgain = map.getArchivedPlanTree(
  map.projection().task_map_revisions.find((r) => !r.is_live)!.id,
);
assert.deepEqual(archivedAgain, archivedTree, "archived plan_tree immutable");

// E3-style: open items + archiveThenInstall freezes open debt
const map2 = new TaskMapHistory();
map2.installLive(workItems([{ title: "Open A" }, { title: "Open B" }]), { work_mode: "free" });
const before = map2.projection().live_revision_id;
map2.archiveThenInstall(workItems([{ title: "Replanned" }]), { work_mode: "free" });
assert.equal(map2.archivedCount(), 1);
const debt = map2.projection().task_map_revisions.find((r) => !r.is_live)!;
assert.equal(debt.open, 2, "open items frozen into archive");
assert.notEqual(map2.liveRevisionId, before);

// Stage advance spam: mutateLive × N does not grow archived
const map3 = new TaskMapHistory();
map3.installLive(
  [
    { node_id: "s1", kind: "stage", level: "stage", status: "running", title: "S1" },
    ...workItems([{ title: "L2a" }]),
  ],
  { work_mode: "graph", graph_id: "app_assessment" },
);
for (let i = 0; i < 5; i++) {
  map3.mutateLive(
    [
      { node_id: `s${i}`, kind: "stage", level: "stage", status: "done", title: `S${i}` },
      ...workItems([{ title: `L2-${i}`, status: i === 4 ? "done" : "running" }]),
    ],
    { work_mode: "graph" },
  );
}
assert.equal(map3.archivedCount(), 0, "stage advance never archives");
assert.equal(map3.revisionCount(), 1);

// E4 restart
map3.archiveForRestart(workItems([{ title: "New graph run" }]), {
  work_mode: "graph",
  graph_id: "app_assessment",
});
assert.equal(map3.archivedCount(), 1);
assert.equal(map3.revisionCount(), 2);

// --- TodoStore Free integration (S1 + S2) ---
const store = new TodoStore();
store.apply({ op: "init", free_map: true, items: ["A", "B"] });
const p0 = store.taskMapProjection();
assert.ok(p0.live_revision_id);
assert.equal(p0.task_map_revisions.length, 1);
assert.equal(p0.live_sealed, false);

// E5 maintain
store.apply({ op: "done", free_map: true, task: "A" });
assert.equal(store.taskMapProjection().task_map_revisions.length, 1);
store.apply({ op: "done", free_map: true, task: "B" });
// after both done → sealed (E1)
assert.equal(store.taskMapProjection().live_sealed, true, "E1 store sealed");
const sealedLiveId = store.taskMapProjection().live_revision_id;

// Silent init while sealed should succeed without grant (E2) and archive
const e2 = store.apply({
  op: "init",
  free_map: true,
  items: ["Next chapter"],
});
assert.equal(e2.errors.length, 0, "E2 sealed init without grant");
const afterE2 = store.taskMapProjection();
assert.equal(afterE2.task_map_revisions.length, 2);
assert.notEqual(afterE2.live_revision_id, sealedLiveId);
assert.equal(afterE2.live_sealed, false);
assert.equal(store.snapshot()[0]!.tasks[0]!.content, "Next chapter");

// Open map + silent init denied (E3 without grant)
store.apply({ op: "append", free_map: true, phase: "Tasks", items: ["Still open"] });
assert.equal(store.openCount() > 0, true);
const denied = store.apply({
  op: "init",
  free_map: true,
  items: ["Wipe attempt"],
});
assert.ok(denied.errors.length > 0);
assert.equal(store.taskMapProjection().task_map_revisions.length, 2, "deny does not archive");
assert.ok(store.snapshot()[0]!.tasks.some((t) => t.content === "Still open"));

// Open + grant → archive (E3)
const beforeGrant = store.taskMapProjection();
const granted = store.apply({
  op: "init",
  free_map: true,
  allow_replace: true,
  items: ["Clean slate"],
});
assert.equal(granted.errors.length, 0);
const afterGrant = store.taskMapProjection();
assert.equal(afterGrant.task_map_revisions.length, beforeGrant.task_map_revisions.length + 0 + 1 - 0);
// archived grew by 1: previous live became archive, new live added → total = prev total (had live) so archived+1, live new → length = before.revisions (1 live + archives) ...
// before had 2 revs (1 archived + 1 live). After: 2 archived + 1 live = 3
assert.equal(afterGrant.task_map_revisions.length, 3);
assert.equal(store.snapshot()[0]!.tasks.length, 1);
assert.equal(store.snapshot()[0]!.tasks[0]!.content, "Clean slate");

// Archived includes prior open debt
const hist = afterGrant.task_map_revisions.filter((r) => !r.is_live);
const lastArchived = hist[hist.length - 1]!;
assert.ok(lastArchived.open >= 1 || lastArchived.total >= 1);

// Agent prose cannot seal — only item statuses
const store2 = new TodoStore();
store2.apply({ op: "init", free_map: true, items: ["Left open"] });
// no seal without terminal items
assert.equal(store2.taskMapProjection().live_sealed, false);

// applyTodoOp sealed flag
const allDone: TodoPhase[] = [
  { name: "Tasks", tasks: [{ content: "X", status: "completed" }] },
];
const sealedInit = applyTodoOp(allDone, {
  op: "init",
  free_map: true,
  live_sealed: true,
  items: ["Y"],
});
assert.equal(sealedInit.errors.length, 0);
assert.equal(sealedInit.phases[0]!.tasks[0]!.content, "Y");

console.log("task-map.test.ts: ok");
