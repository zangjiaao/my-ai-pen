/**
 * Platform bridge smoke: drive the same normalize + event path as main.ts handlers.
 *
 * LIMITATION (verification plan step 3 fallback): does NOT open a live WebSocket to
 * PLATFORM_WS_URL. Exercises shipped normalizeTaskAssign + tools + finish settlement
 * + task_complete emission on the real tool path. Live platform WS requires NODE_TOKEN
 * and a running backend; when unavailable this structural/unit path is used.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { TodoStore } from "./stores/todo.js";
import { EvidenceStore } from "./stores/evidence.js";
import { resolveTerminalTaskStatus, finishScanSettlesTask } from "./runtime/finish-settlement.js";
import { createTodoTool } from "./tools/todo.js";
import { createScriptTool } from "./tools/script.js";
import { createFindingTool } from "./tools/finding.js";
import { createFinishTool } from "./tools/finish.js";
import type { PlatformMessage, PlatformSink, TaskEnvelope, ToolRuntime } from "./types.js";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

/** Same normalization as main.ts task_assign handler. */
export function normalizeTaskAssign(message: Record<string, unknown>): TaskEnvelope {
  const taskId = String(message.task_id || message.taskId || "t");
  const conversationId = String(message.conversation_id || message.conversationId || taskId);
  const targetRaw = message.target;
  const target =
    targetRaw && typeof targetRaw === "object" && !Array.isArray(targetRaw)
      ? (targetRaw as Record<string, unknown>)
      : { type: "url", value: String(message.target || "") };
  const scopeRaw = message.scope;
  const scope =
    scopeRaw && typeof scopeRaw === "object" && !Array.isArray(scopeRaw)
      ? (scopeRaw as Record<string, unknown>)
      : { allow: [] };
  return {
    taskId,
    conversationId,
    instruction: String(message.initial_instruction || message.instruction || ""),
    target,
    scope,
  };
}

async function main() {
  console.log(
    JSON.stringify({
      mode: "structural_fallback_no_live_ws",
      limitation:
        "No live PLATFORM_WS_URL connection in this smoke. Drives shipped task_assign normalize + tool/finish/task_complete handlers only. Live WS requires NODE_TOKEN + running platform backend.",
      live_ws: false,
    }),
  );
  const events: PlatformMessage[] = [];
  const platform: PlatformSink = {
    async send(m) {
      events.push(m);
    },
  };

  const assign = {
    type: "task_assign",
    task_id: "plat-smoke-1",
    conversation_id: "conv-plat",
    initial_instruction: "authorized platform smoke",
    target: { type: "url", value: "http://127.0.0.1:1" },
    scope: { allow: ["127.0.0.1:1"] },
  };
  const task = normalizeTaskAssign(assign);
  assert(task.taskId === "plat-smoke-1", "task id");
  assert(task.conversationId === "conv-plat", "conversation id");

  const root = join(process.cwd(), "tmp", "node4-platform-smoke");
  const taskDir = join(root, task.taskId);
  await mkdir(join(taskDir, "evidence"), { recursive: true });
  await mkdir(join(taskDir, "findings"), { recursive: true });
  await mkdir(join(taskDir, "scripts"), { recursive: true });

  const runtime: ToolRuntime = {
    task,
    workspaceDir: root,
    taskDir,
    platform,
    todo: new TodoStore(),
    evidence: new EvidenceStore(join(taskDir, "evidence")),
    findingsDir: join(taskDir, "findings"),
    lifecycle: {},
  };

  await platform.send({ type: "task_start", conversation_id: task.conversationId, task_id: task.taskId });
  await createTodoTool(runtime).execute!("a", { op: "init", items: ["Act", "Book", "Close"] });
  const script = createScriptTool(runtime);
  await script.execute!("b", { action: "write", filename: "p.py", content: "print('p')\n" });
  const run = JSON.parse((await script.execute!("c", { action: "run", filename: "p.py" })).content[0].text);
  await createFindingTool(runtime).execute!("d", {
    action: "confirm",
    title: "Platform smoke finding",
    evidence_ids: [run.evidence_id],
  });
  await createFinishTool(runtime).execute!("e", {
    status: "completed",
    summary: "platform path complete",
    evidence_ids: [run.evidence_id],
  });

  const settle = finishScanSettlesTask(runtime.lifecycle.finishScan);
  assert(settle.canComplete, "settled");
  const terminal = resolveTerminalTaskStatus({ gateCanComplete: false, finishStatus: runtime.lifecycle.finishScan?.status });
  assert(terminal === "completed", "terminal completed");
  await platform.send({
    type: "task_complete",
    conversation_id: task.conversationId,
    task_id: task.taskId,
    status: terminal,
    summary: runtime.lifecycle.finishScan?.summary,
  });

  const types = events.map((e) => e.type);
  for (const need of ["task_start", "todo_updated", "evidence_created", "vuln_found", "finish_scan_requested", "task_complete"]) {
    assert(types.includes(need), `missing event ${need}: ${types.join(",")}`);
  }
  const complete = events.filter((e) => e.type === "task_complete").pop();
  assert(complete?.status === "completed", "task_complete status completed");

  console.log(
    JSON.stringify(
      {
        ok: true,
        live_ws: false,
        limitation: "structural fallback — no live platform WebSocket",
        path: "task_assign_normalize → tools → finish → task_complete",
        events: types,
        terminal: complete?.status,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
