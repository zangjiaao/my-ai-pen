/**
 * Graph L1/L2 plan store — no wipe across stages.
 * Run: npx tsx src/runtime/hard-graph-plan.test.ts
 */
import assert from "node:assert/strict";
import {
  HardGraphPlanStore,
  buildHardGraphProgress,
  emitHardGraphPlanTreeUpdate,
  scoreTodoGoalMatch,
  FUZZY_BIND_MIN_SCORE,
} from "./hard-graph-plan.js";
import type { HardGraphDefinition } from "./hard-graph-definition.js";
import type { PlatformMessage } from "../types.js";

const graph: HardGraphDefinition = {
  discipline: "hard",
  id: "test_graph",
  label: "Test Graph",
  stages: [
    { id: "init", success: "ok", require: { summary: true }, tools: { allow: ["todo"] }, max_retries: 0 },
    { id: "surface", success: "ok", require: { summary: true }, tools: { allow: ["todo"] }, max_retries: 0 },
    { id: "class_probe", success: "ok", require: { summary: true }, tools: { allow: ["todo", "subagent"] }, max_retries: 0 },
  ],
};

const plan = new HardGraphPlanStore(graph);
let tree = plan.toPlanTree();
const l1 = tree.filter((n) => n.level === "phase");
assert.equal(l1.length, 3, "L1 has all stages at start");
assert.ok(l1.every((n) => n.status === "pending"));
assert.ok(l1.every((n) => n.source === "plan"));

plan.setStageStatus("init", "running");
plan.setStageTodos("init", [
  { node_id: "todo-a", title: "Record RoE", status: "running", level: "work_item", kind: "task", source: "plan" },
  { node_id: "todo-b", title: "Handoff", status: "pending", level: "work_item", kind: "task", source: "plan" },
]);
tree = plan.toPlanTree();
assert.equal(tree.find((n) => n.node_id === "graph-stage-init")?.status, "running");
const initTodos = tree.filter((n) => n.parent_id === "graph-stage-init");
assert.equal(initTodos.length, 2);
assert.ok(initTodos.every((n) => n.parent_id === "graph-stage-init"));

plan.setStageStatus("init", "done");
plan.setStageTodos("init", [
  { node_id: "todo-a", title: "Record RoE", status: "done", level: "work_item", kind: "task", source: "plan" },
  { node_id: "todo-b", title: "Handoff", status: "done", level: "work_item", kind: "task", source: "plan" },
]);
plan.setStageStatus("surface", "running");
plan.setStageTodos("surface", [
  { node_id: "todo-s1", title: "Map URLs", status: "running", level: "work_item", kind: "task", source: "plan" },
]);
tree = plan.toPlanTree();
assert.equal(tree.find((n) => n.node_id === "graph-stage-init")?.status, "done");
assert.equal(tree.filter((n) => n.parent_id === "graph-stage-init").length, 2, "init L2 preserved");
assert.equal(tree.find((n) => n.node_id === "graph-stage-surface")?.status, "running");
assert.equal(tree.filter((n) => n.parent_id === "graph-stage-surface").length, 1);
// class_probe still pending with no wipe
assert.equal(tree.find((n) => n.node_id === "graph-stage-class_probe")?.status, "pending");

plan.upsertStageWorkItem("class_probe", {
  node_id: "pkg-sqli",
  title: "Package SQLi",
  status: "running",
  agent_id: "sub_sqli",
  owner_agent_name: "Worker 1",
  kind: "task",
  source: "plan",
});
tree = plan.toPlanTree();
const pkg = tree.find((n) => n.node_id === "pkg-sqli");
assert.ok(pkg);
assert.equal(pkg!.parent_id, "graph-stage-class_probe");
assert.equal((pkg as any).agent_id, "sub_sqli");

// Main-authored todos + explicit attach preferred over fuzzy.
plan.setStageTodos("class_probe", [
  { node_id: "todo-sqli", title: "SQL Injection (sqli)", status: "pending", level: "work_item", kind: "task", source: "plan" },
  { node_id: "todo-xss", title: "Reflected XSS (xss_r)", status: "pending", level: "work_item", kind: "task", source: "plan" },
]);
// pkg-* from before setStageTodos must be preserved
assert.ok(plan.toPlanTree().some((n) => n.node_id === "pkg-sqli"), "pkg preserved across setStageTodos");

const explicit = plan.attachWorker("class_probe", "todo-sqli", {
  agent_id: "sub_w2",
  owner_agent_name: "Worker 2",
  status: "running",
});
assert.equal(explicit, "todo-sqli");
const sqli = plan.toPlanTree().find((n) => n.node_id === "todo-sqli") as any;
assert.equal(sqli.owner_agent_name, "Worker 2");
assert.equal(sqli.agent_id, "sub_w2");
assert.equal(sqli.status, "running");

// Re-attach by agent_id updates status without fuzzy.
const re = plan.reattachWorkerByAgent("class_probe", {
  agent_id: "sub_w2",
  owner_agent_name: "Worker 2",
  status: "done",
});
assert.equal(re, "todo-sqli");
assert.equal((plan.toPlanTree().find((n) => n.node_id === "todo-sqli") as any).status, "done");

// Subsequent todo status update keeps Worker chip
plan.setStageTodos("class_probe", [
  { node_id: "todo-sqli", title: "SQL Injection (sqli)", status: "done", level: "work_item", kind: "task", source: "plan" },
  { node_id: "todo-xss", title: "Reflected XSS (xss_r)", status: "pending", level: "work_item", kind: "task", source: "plan" },
]);
const sqli2 = plan.toPlanTree().find((n) => n.node_id === "todo-sqli") as any;
assert.equal(sqli2.owner_agent_name, "Worker 2", "worker chip survives todo rewrite");
assert.equal(sqli2.status, "done");

// Single free todo (only XSS free after SQLi is bound) — no scoring.
const single = plan.bindWorkerToSingleFreeTodo("class_probe", {
  agent_id: "sub_w3",
  owner_agent_name: "Worker 3",
  status: "running",
});
assert.equal(single, "todo-xss", "single free todo binds without fuzzy");

// Two free rows → single_free refuses (use surface stage for a clean slate).
plan.setStageTodos("surface", [
  { node_id: "todo-s-a", title: "Map A", status: "pending", level: "work_item", kind: "task", source: "plan" },
  { node_id: "todo-s-b", title: "Map B", status: "pending", level: "work_item", kind: "task", source: "plan" },
]);
assert.equal(
  plan.bindWorkerToSingleFreeTodo("surface", {
    agent_id: "sub_none",
    owner_agent_name: "Worker",
    status: "running",
  }),
  null,
  "two free todos → no single_free",
);

// Fuzzy last-resort on surface: strong title match to Map A.
const fuzzy = plan.bindWorkerToBestTodo("surface", {
  agent_id: "sub_map",
  owner_agent_name: "Worker 5",
  goal: "Map A endpoints thoroughly",
  status: "running",
});
assert.equal(fuzzy, "todo-s-a");

// resolveWorkerBind prefers explicit plan_node_id over goal fuzzy.
const resolved = plan.resolveWorkerBind("class_probe", {
  agent_id: "sub_w2",
  owner_agent_name: "Worker 2",
  plan_node_id: "todo-sqli",
  goal: "something else entirely",
  status: "done",
});
assert.equal(resolved?.path, "explicit");
assert.equal(resolved?.node_id, "todo-sqli");

// Without plan_node_id, reattach by agent wins over fuzzy.
const reattached = plan.resolveWorkerBind("class_probe", {
  agent_id: "sub_w3",
  owner_agent_name: "Worker 3",
  goal: "unrelated goal text that would not match",
  status: "running",
});
assert.equal(reattached?.path, "reattach");
assert.equal(reattached?.node_id, "todo-xss");

// Never steal another worker's chip even with high score.
const steal = plan.bindWorkerToBestTodo("class_probe", {
  agent_id: "sub_thief",
  owner_agent_name: "Worker 9",
  goal: "SQL Injection (sqli) full probe",
  status: "running",
});
assert.equal(steal, null, "must not steal Worker 2's todo-sqli");
assert.equal((plan.toPlanTree().find((n) => n.node_id === "todo-sqli") as any).agent_id, "sub_w2");

// Weak shared-token goals must stay below fuzzy threshold.
const weakScore = scoreTodoGoalMatch("Authentication bypass", "Test authorization bypass flows");
assert.ok(weakScore < FUZZY_BIND_MIN_SCORE, `weak token score ${weakScore} should be < ${FUZZY_BIND_MIN_SCORE}`);

plan.setStageTodos("class_probe", [
  { node_id: "todo-sqli", title: "SQL Injection (sqli)", status: "done", level: "work_item", kind: "task", source: "plan", agent_id: "sub_w2", owner_agent_name: "Worker 2" },
  { node_id: "todo-xss", title: "Reflected XSS (xss_r)", status: "running", level: "work_item", kind: "task", source: "plan", agent_id: "sub_w3", owner_agent_name: "Worker 3" },
  { node_id: "todo-auth", title: "Session management", status: "pending", level: "work_item", kind: "task", source: "plan" },
]);
const weakBind = plan.bindWorkerToBestTodo("class_probe", {
  agent_id: "sub_weak",
  owner_agent_name: "Worker 4",
  goal: "Generic testing work",
  status: "running",
});
assert.equal(weakBind, null, "weak goal must not bind");

// single_free: same-agent occupied row is NOT free (only !agent_id).
// class_probe has one unbound (todo-auth) + two occupied → single_free binds auth.
const singleUnbound = plan.bindWorkerToSingleFreeTodo("class_probe", {
  agent_id: "sub_w3",
  owner_agent_name: "Worker 3",
  status: "running",
});
assert.equal(singleUnbound, "todo-auth", "only unbound row is free");
// Same agent already on todo-xss: reattach updates status, not single_free inventing.
const reStatus = plan.resolveWorkerBind("class_probe", {
  agent_id: "sub_w3",
  owner_agent_name: "Worker 3",
  status: "done",
});
assert.equal(reStatus?.path, "reattach");
assert.equal(reStatus?.node_id, "todo-xss");

// Explicit miss → fall through with telemetry (single_free or fuzzy).
// Spec #125 merge keeps completed history (todo-a/todo-b done) so single_free may not apply.
plan.setStageTodos("init", [
  { node_id: "todo-only", title: "Unique fresh todo only", status: "pending", level: "work_item", kind: "task", source: "plan" },
]);
const miss = plan.resolveWorkerBind("init", {
  agent_id: "sub_miss",
  owner_agent_name: "Worker 8",
  plan_node_id: "todo-does-not-exist",
  goal: "Unique fresh todo only carefully",
  status: "running",
});
assert.ok(miss?.path === "single_free" || miss?.path === "fuzzy", `fallthrough path, got ${miss?.path}`);
assert.ok(miss?.node_id, "bound some L2 row");
assert.equal(miss?.requested_node_id, "todo-does-not-exist");
assert.ok(miss?.hint && /not found/i.test(miss.hint), "explicit miss hint present");

plan.removeStageWorkItem("class_probe", "pkg-sqli");
assert.ok(!plan.toPlanTree().some((n) => n.node_id === "pkg-sqli"));

const messages: PlatformMessage[] = [];
await emitHardGraphPlanTreeUpdate(
  { send: async (m) => { messages.push(m); } },
  { taskId: "t1", conversationId: "c1", expertId: "e1", expertName: "渗透大师" } as any,
  plan,
  "stage.surface",
);
assert.equal(messages[0]?.type, "plan_tree_updated");
const emitted = (messages[0] as any).plan_tree as Array<{ level?: string; owner_expert_name?: string }>;
assert.ok(emitted.some((n) => n.level === "phase"));
assert.ok(emitted.every((n) => !n.owner_expert_name || n.owner_expert_name === "渗透大师"));

// --- Spec #125 / #127: L2 merge honesty (f6ffa588 clobber shape) ---
{
  const plan2 = new HardGraphPlanStore(graph!);
  plan2.setStageTodos("class_probe", [
    {
      node_id: "todo-csrf",
      title: "CSRF probe",
      status: "done",
      level: "work_item",
      kind: "task",
      source: "plan",
      agent_id: "sub_csrf",
      owner_agent_name: "Worker CSRF",
    },
    {
      node_id: "todo-weak",
      title: "Weak session",
      status: "pending",
      level: "work_item",
      kind: "task",
      source: "plan",
    },
  ]);
  // Package completes L2 done + chip; Main todo.done on another row must not clobber.
  plan2.setStageTodos("class_probe", [
    {
      node_id: "todo-csrf",
      title: "CSRF probe",
      status: "pending", // stale Todo snapshot tries to regress
      level: "work_item",
      kind: "task",
      source: "plan",
    },
    {
      node_id: "todo-weak",
      title: "Weak session",
      status: "done",
      level: "work_item",
      kind: "task",
      source: "plan",
    },
  ]);
  const csrf = plan2.toPlanTree().find((n) => n.node_id === "todo-csrf") as any;
  assert.equal(csrf?.status, "done", "package done status preserved against weaker Todo");
  assert.equal(csrf?.agent_id, "sub_csrf", "worker chip preserved");
  assert.equal(
    (plan2.toPlanTree().find((n) => n.node_id === "todo-weak") as any)?.status,
    "done",
  );

  // Retry todo.init with new titles must not silently wipe completed package-anchored history
  plan2.setStageTodos("class_probe", [
    {
      node_id: "todo-new-wave",
      title: "New replan class",
      status: "pending",
      level: "work_item",
      kind: "task",
      source: "plan",
    },
  ]);
  assert.ok(
    plan2.toPlanTree().some((n) => n.node_id === "todo-csrf" && (n as any).status === "done"),
    "retry init must not wipe completed package-anchored L2",
  );
  assert.ok(plan2.toPlanTree().some((n) => n.node_id === "todo-new-wave"));

  // Progress must not look full-green success when stage is blocked
  plan2.setStageStatus("class_probe", "blocked");
  const prog = buildHardGraphProgress(plan2);
  assert.equal(prog.stage_blocked, true);
  assert.match(prog.label, /blocked/i);
}

console.log("hard-graph-plan.test.ts: ok");
