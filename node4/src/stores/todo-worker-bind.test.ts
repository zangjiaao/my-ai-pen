/**
 * Spec #301 — Free Main Todo host Worker bind (resolveWorkerBind priority).
 * Run: npx tsx src/stores/todo-worker-bind.test.ts
 */
import assert from "node:assert/strict";
import { TodoStore, todoTaskNodeId } from "./todo.js";

const store = new TodoStore();
store.apply({
  op: "init",
  list: [
    {
      phase: "Tasks",
      items: ["Probe SQLi on login", "Map XSS surface", "Session management"],
    },
  ],
});

const sqliId = todoTaskNodeId("Tasks", "Probe SQLi on login");
const xssId = todoTaskNodeId("Tasks", "Map XSS surface");
const sessionId = todoTaskNodeId("Tasks", "Session management");

// Explicit plan_node_id
const explicit = store.resolveWorkerBind({
  agent_id: "sub_w1",
  owner_agent_name: "Worker 1",
  plan_node_id: sqliId,
  goal: "unrelated",
  status: "running",
});
assert.equal(explicit?.path, "explicit");
assert.equal(explicit?.node_id, sqliId);
const tree1 = store.toPlanNodes();
const sqliNode = tree1.find((n) => n.node_id === sqliId) as {
  agent_id?: string;
  owner_agent_name?: string;
  linked_agent_id?: string;
};
assert.equal(sqliNode?.agent_id, "sub_w1");
assert.equal(sqliNode?.owner_agent_name, "Worker 1");
assert.equal(sqliNode?.linked_agent_id, "sub_w1");

// Reattach by agent_id
const re = store.resolveWorkerBind({
  agent_id: "sub_w1",
  owner_agent_name: "Worker 1",
  goal: "something else",
  status: "done",
});
assert.equal(re?.path, "reattach");
assert.equal(re?.node_id, sqliId);

// single_free when exactly one unbound (xss + session free after only sqli bound)
// Bind xss first via single_free — wait, two free → single_free null
const multiFree = store.resolveWorkerBind({
  agent_id: "sub_w2",
  owner_agent_name: "Worker 2",
  goal: "zzzz no match tokens here",
  status: "running",
});
assert.equal(multiFree, null, "two free + weak goal → no bind (caller uses pkg)");

// Fuzzy bind
const fuzzy = store.resolveWorkerBind({
  agent_id: "sub_w2",
  owner_agent_name: "Worker 2",
  goal: "Map XSS surface carefully",
  status: "running",
});
assert.equal(fuzzy?.path, "fuzzy");
assert.equal(fuzzy?.node_id, xssId);

// single_free: only session unbound
const single = store.resolveWorkerBind({
  agent_id: "sub_w3",
  owner_agent_name: "Worker 3",
  status: "running",
});
assert.equal(single?.path, "single_free");
assert.equal(single?.node_id, sessionId);

// Never steal
const steal = store.bindWorkerToBestTodo({
  agent_id: "sub_thief",
  owner_agent_name: "Worker 9",
  goal: "Probe SQLi on login",
  status: "running",
});
assert.equal(steal, null);
assert.equal(
  (store.toPlanNodes().find((n) => n.node_id === sqliId) as { agent_id?: string }).agent_id,
  "sub_w1",
);

// pkg-* synthetic with owner
store.upsertPackageWorkItem({
  node_id: "pkg-sub_orphan",
  title: "orphan package goal",
  status: "running",
  agent_id: "sub_orphan",
  owner_agent_name: "Worker 4",
});
const pkg = store.toPlanNodes().find((n) => n.node_id === "pkg-sub_orphan") as {
  owner_agent_name?: string;
  agent_id?: string;
};
assert.equal(pkg?.owner_agent_name, "Worker 4");
assert.equal(pkg?.agent_id, "sub_orphan");
store.removePackageWorkItem("pkg-sub_orphan");
assert.ok(!store.toPlanNodes().some((n) => n.node_id === "pkg-sub_orphan"));

// Explicit miss fallthrough
const fresh = new TodoStore();
fresh.apply({
  op: "init",
  list: [{ phase: "Tasks", items: ["Unique fresh todo only"] }],
});
const miss = fresh.resolveWorkerBind({
  agent_id: "sub_miss",
  owner_agent_name: "Worker 8",
  plan_node_id: "todo-does-not-exist",
  goal: "Unique fresh todo only carefully",
  status: "running",
});
assert.ok(miss?.path === "single_free" || miss?.path === "fuzzy", `got ${miss?.path}`);
assert.equal(miss?.requested_node_id, "todo-does-not-exist");
assert.ok(miss?.hint && /not found/i.test(miss.hint));

console.log("todo-worker-bind.test.ts: ok");
