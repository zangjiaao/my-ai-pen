/**
 * Platform path smoke (structural fallback when live WS unavailable).
 *
 * LIMITATION: live_ws=false — does not open PLATFORM_WS_URL.
 * Proves booking events + harness task_complete (not agent finish-driven).
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TodoStore } from "./stores/todo.js";
import { EvidenceStore } from "./stores/evidence.js";
import { agentCanForceCompletedViaFinish, finishScanSettlesTask } from "./runtime/finish-settlement.js";
import { resolveHarnessTerminalStatus } from "./runtime/loop-policy.js";
import { writePostRunInspectArtifacts, inspectArtifactChecklist } from "./runtime/session-inspect.js";
import { createTodoTool } from "./tools/todo.js";
import { createShellTool } from "./tools/shell.js";
import { createFindingTool } from "./tools/finding.js";
import { createFinishTool } from "./tools/finish.js";
import type { PlatformMessage, PlatformSink, TaskEnvelope, ToolRuntime } from "./types.js";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

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
      live_ws: false,
      limitation:
        "No live PLATFORM_WS_URL. Exercises shipped normalize + booking + non-terminal finish + harness task_complete.",
    }),
  );

  const events: PlatformMessage[] = [];
  const platform: PlatformSink = {
    async send(m) {
      events.push(m);
    },
  };

  const task = normalizeTaskAssign({
    type: "task_assign",
    task_id: "plat-align-1",
    conversation_id: "conv-plat",
    initial_instruction: "authorized",
    target: { type: "url", value: "http://127.0.0.1:1" },
    scope: { allow: ["127.0.0.1:1"] },
  });

  const root = join(process.cwd(), "tmp", "node4-platform-align");
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
  await createTodoTool(runtime).execute!("a", { op: "init", items: ["Act", "Book"] });
  const shell = JSON.parse((await createShellTool(runtime).execute!("b", { command: "echo p" })).content[0].text);
  await createFindingTool(runtime).execute!("c", {
    action: "confirm",
    title: "Plat finding",
    evidence_ids: [shell.evidence_id],
  });
  // Agent tries to "finish completed" — non-terminal, must not alone complete task
  const fin = JSON.parse(
    (await createFinishTool(runtime).execute!("d", { status: "completed", summary: "done early" })).content[0].text,
  );
  assert(fin.non_terminal === true, "finish non terminal");
  assert(finishScanSettlesTask({ status: "completed" }).settled === false, "not settled by agent");
  assert(agentCanForceCompletedViaFinish() === false, "cannot force");

  // No task_complete yet from finish
  assert(!events.some((e) => e.type === "task_complete"), "finish must not emit task_complete");

  const status = resolveHarnessTerminalStatus({
    agentBlocked: false,
    bookedFindingCount: 1,
    timedOut: false,
    aborted: false,
    stopReason: "max_continues",
  });
  await platform.send({
    type: "task_complete",
    conversation_id: task.conversationId,
    task_id: task.taskId,
    status,
    summary: "harness settled",
  });

  // Durable events log (same path session-runner keeps) so post-run inspect works.
  await writeFile(join(taskDir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
  await writePostRunInspectArtifacts({
    taskDir,
    taskId: task.taskId,
    terminalStatus: status,
    summary: "harness settled",
    messages: [{ role: "assistant", content: "worked" }],
    continueCount: 1,
    stopReason: "max_continues",
    bookedFindingCount: 1,
  });

  const names = await readdir(taskDir);
  assert(inspectArtifactChecklist(names).ok, "inspect artifacts");
  const complete = events.filter((e) => e.type === "task_complete").pop();
  assert(complete?.status === "completed", "harness completed");

  console.log(
    JSON.stringify(
      {
        ok: true,
        live_ws: false,
        finish_non_terminal: true,
        task_complete_from_harness_only: true,
        post_run_inspectable: true,
        events: events.map((e) => e.type),
        terminal: complete?.status,
        manifest: JSON.parse(await readFile(join(taskDir, "session-manifest.json"), "utf8")).schema,
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
