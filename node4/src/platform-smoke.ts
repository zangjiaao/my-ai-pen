/**
 * Platform path smoke (structural fallback when live WS unavailable).
 *
 * LIMITATION: live_ws=false — does not open PLATFORM_WS_URL.
 * Proves booking events + harness task_complete (no agent finish tool).
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TodoStore } from "./stores/todo.js";
import { EvidenceStore } from "./stores/evidence.js";
import { GoalStore } from "./stores/goal.js";
import { agentCanForceCompleted } from "./runtime/harness-settlement.js";
import { resolveHarnessTerminalStatus } from "./runtime/loop-policy.js";
import { writePostRunInspectArtifacts, inspectArtifactChecklist } from "./runtime/session-inspect.js";
import { createTodoTool } from "./tools/todo.js";
import { createShellTool } from "./tools/shell.js";
import { createFindingTool } from "./tools/finding.js";
import { NODE4_TOOL_NAMES } from "./tools/index.js";
import { resolveRolePack } from "./roles/index.js";
import type { PlatformMessage, PlatformSink, TaskEnvelope, ToolRuntime } from "./types.js";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function exec(tool: { execute?: (...args: any[]) => Promise<any> }, id: string, params: unknown): Promise<any> {
  if (!tool.execute) throw new Error("tool missing execute");
  return tool.execute(id, params);
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.find((c) => c.type === "text")?.text || "";
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
    engagement: typeof message.engagement === "string" ? message.engagement : undefined,
    role: typeof message.role === "string" ? message.role : undefined,
  };
}

async function main() {
  console.log(
    JSON.stringify({
      mode: "structural_fallback_no_live_ws",
      live_ws: false,
      limitation:
        "No live PLATFORM_WS_URL. Exercises shipped normalize + booking + harness task_complete (no agent finish).",
    }),
  );

  assert(!(NODE4_TOOL_NAMES as readonly string[]).includes("finish_scan"), "no finish tool registered");
  assert(agentCanForceCompleted() === false, "cannot force completed");
  assert(resolveRolePack({ engagement: "pentest" }).pack.id === "pentest", "platform envelope → pentest pack");

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
    engagement: "pentest",
    target: { type: "url", value: "http://127.0.0.1:1" },
    scope: { allow: ["127.0.0.1:1"] },
  });
  assert(task.engagement === "pentest", "normalize keeps engagement");

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
    goals: new GoalStore(),
    lifecycle: {},
  };

  await platform.send({ type: "task_start", conversation_id: task.conversationId, task_id: task.taskId });
  await exec(createTodoTool(runtime), "a", { op: "init", items: ["Act", "Book"] });
  const shell = JSON.parse(textOf(await exec(createShellTool(runtime), "b", { command: "echo p" })));
  await exec(createFindingTool(runtime), "c", {
    action: "confirm",
    title: "Plat finding",
    evidence_ids: [shell.evidence_id],
  });

  // Booking must not emit finish or task_complete
  assert(!events.some((e) => e.type === "task_complete"), "booking must not emit task_complete");
  assert(!events.some((e) => e.type === "finish_scan_requested"), "no finish_scan_requested");

  const status = resolveHarnessTerminalStatus({
    bookedFindingCount: 1,
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
        no_finish_tool: true,
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
