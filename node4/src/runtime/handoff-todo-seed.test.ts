/**
 * Spec #354 / Free cold-continue: seed TodoStore from pending_handoff_todos.
 */
import assert from "node:assert/strict";
import { seedTodoFromHandoff } from "./handoff-todo-seed.js";
import { freeInitReplaceDenied } from "../stores/todo.js";

// --- empty / missing ---
{
  const empty = seedTodoFromHandoff({});
  assert.equal(empty.openCount(), 0);
  const emptyList = seedTodoFromHandoff({ pendingHandoffTodos: [] });
  assert.equal(emptyList.openCount(), 0);
}

// --- sealed map (all terminal) stays empty so Free may init fresh ---
{
  const sealed = seedTodoFromHandoff({
    pendingHandoffTodos: [
      {
        name: "Done phase",
        tasks: [
          { title: "a", status: "done" },
          { content: "b", status: "completed" },
        ],
      },
    ],
  });
  assert.equal(sealed.openCount(), 0);
  assert.equal(sealed.snapshot().length, 0);
}

// --- open map restores phases + progress; silent init replace denied ---
{
  const store = seedTodoFromHandoff({
    pendingHandoffTodos: [
      {
        name: "侦察",
        tasks: [
          { title: "目标可达性与指纹识别", status: "running" },
          { title: "端口服务与Web技术栈", status: "pending" },
          { title: "API/路由/目录枚举", status: "pending" },
        ],
      },
      {
        name: "认证与会话",
        tasks: [{ content: "登录认证机制测试", status: "pending" }],
      },
    ],
  });
  assert.equal(store.openCount(), 4);
  const snap = store.snapshot();
  assert.equal(snap.length, 2);
  assert.equal(snap[0]?.name, "侦察");
  assert.equal(snap[0]?.tasks[0]?.status, "in_progress");
  assert.equal(snap[0]?.tasks[0]?.content, "目标可达性与指纹识别");
  assert.equal(snap[1]?.name, "认证与会话");

  const denied = freeInitReplaceDenied(snap, false);
  assert.ok(denied, "seeded Free map blocks silent todo.init replace");

  const wipe = store.apply({
    op: "init",
    free_map: true,
    list: [{ phase: "New", items: ["should not land"] }],
  });
  assert.equal(wipe.errors.length > 0, true);
  assert.equal(store.openCount(), 4, "map unchanged after denied replace");
}

// --- completed siblings preserved when open items remain ---
{
  const store = seedTodoFromHandoff({
    pendingHandoffTodos: [
      {
        name: "Recon",
        tasks: [
          { title: "done one", status: "done" },
          { title: "open two", status: "pending" },
        ],
      },
    ],
  });
  const recon = store.snapshot()[0];
  assert.ok(recon);
  assert.equal(recon!.tasks.length, 2);
  assert.equal(recon!.tasks.find((t) => t.content === "done one")?.status, "completed");
  assert.ok(
    ["pending", "in_progress"].includes(
      recon!.tasks.find((t) => t.content === "open two")?.status || "",
    ),
  );
}

console.log("handoff-todo-seed.test.ts: ok");
