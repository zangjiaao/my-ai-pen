/**
 * Spec #321 Graph: whole participation = one map; stage advance does not mint revisions (E5);
 * restart archives (E4); failed L1 + open L2 refuses seal.
 * Run: npx tsx src/stores/task-map-graph.test.ts
 */
import assert from "node:assert/strict";
import { TaskMapHistory, shouldSealPlanTree } from "./task-map.js";
import { TodoStore } from "./todo.js";

function stageTree(
  stages: Array<{ id: string; status: string; todos?: Array<{ title: string; status: string }> }>,
): unknown[] {
  const nodes: unknown[] = [];
  for (const s of stages) {
    nodes.push({
      node_id: `stage-${s.id}`,
      title: s.id,
      kind: "stage",
      level: "stage",
      status: s.status,
      source: "plan",
    });
    for (const [i, t] of (s.todos || []).entries()) {
      nodes.push({
        node_id: `todo-${s.id}-${i}`,
        title: t.title,
        kind: "task",
        level: "work_item",
        status: t.status,
        parent_id: `stage-${s.id}`,
        source: "plan",
      });
    }
  }
  return nodes;
}

// Shared TaskMap on TodoStore (Free → Graph handoff)
const store = new TodoStore();
store.apply({ op: "init", free_map: true, items: ["Free recon"] });
store.apply({ op: "done", free_map: true, task: "Free recon" });
assert.equal(store.taskMapProjection().live_sealed, true);

const map = store.getTaskMap();
// E4: Graph start archives Free sealed map
map.archiveThenInstall(
  stageTree([
    {
      id: "surface",
      status: "running",
      todos: [{ title: "Map endpoints", status: "running" }],
    },
  ]),
  { work_mode: "graph", graph_id: "app_assessment", title: "应用评估" },
);
assert.equal(map.archivedCount(), 1);
assert.equal(map.revisionCount(), 2);
assert.equal(map.projection().task_map_revisions.find((r) => r.is_live)!.work_mode, "graph");

// E5: stage advance × N — no new archive
const revBefore = map.revisionCount();
for (let i = 0; i < 4; i++) {
  map.mutateLive(
    stageTree([
      {
        id: "surface",
        status: i < 2 ? "running" : "done",
        todos: [{ title: "Map endpoints", status: i < 2 ? "running" : "done" }],
      },
      {
        id: "probe",
        status: i >= 2 ? "running" : "pending",
        todos: i >= 2 ? [{ title: "Probe XSS", status: "running" }] : [],
      },
    ]),
    { work_mode: "graph" },
  );
}
assert.equal(map.revisionCount(), revBefore, "stage advance does not grow revisions");
assert.equal(map.archivedCount(), 1);

// Failed L1 + open L2 refuse seal
const openDebt = stageTree([
  {
    id: "surface",
    status: "failed",
    todos: [{ title: "Unfinished L2", status: "pending" }],
  },
]);
assert.equal(shouldSealPlanTree(openDebt), false);
map.mutateLive(openDebt, { work_mode: "graph" });
assert.equal(map.isSealed, false, "refuse auto-seal with open L2 under failed L1");

// Drop open L2 → may seal
map.mutateLive(
  stageTree([
    {
      id: "surface",
      status: "failed",
      todos: [{ title: "Unfinished L2", status: "skipped" }],
    },
  ]),
  { work_mode: "graph" },
);
assert.equal(map.isSealed, true);

// E4 restart again
map.archiveForRestart(
  stageTree([{ id: "surface", status: "pending", todos: [{ title: "Fresh", status: "pending" }] }]),
  { work_mode: "graph", graph_id: "app_assessment" },
);
assert.equal(map.archivedCount(), 2);
assert.equal(map.isSealed, false);

// E6 settle no archive
const c = map.archivedCount();
map.onSessionSettleOrPark();
assert.equal(map.archivedCount(), c);

console.log("task-map-graph.test.ts: ok");
