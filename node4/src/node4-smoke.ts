/**
 * Node4 unit smokes: todo ops, script write/run, finding+finish settlement, no completed demotion.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { applyTodoOp, TodoStore, formatTodoSummary } from "./stores/todo.js";
import { EvidenceStore } from "./stores/evidence.js";
import {
  allowCompletedDespiteCoverageGaps,
  finishScanSettlesTask,
  resolveTerminalTaskStatus,
} from "./runtime/finish-settlement.js";
import { createTodoTool } from "./tools/todo.js";
import { createScriptTool } from "./tools/script.js";
import { createFindingTool } from "./tools/finding.js";
import { createFinishTool } from "./tools/finish.js";
import { buildSystemPrompt } from "./runtime/prompt.js";
import type { PlatformMessage, PlatformSink, TaskEnvelope, ToolRuntime } from "./types.js";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const root = join(process.cwd(), "tmp", `node4-smoke-${Date.now()}`);
const messages: PlatformMessage[] = [];
const platform: PlatformSink = {
  async send(m) {
    messages.push(m);
  },
};

async function main() {
  // pure todo
  const pure = applyTodoOp([], {
    op: "init",
    list: [
      { phase: "Recon", items: ["Probe login", "Map modules"] },
      { phase: "Exploit", items: ["Run SQLi script"] },
    ],
  });
  assert(pure.errors.length === 0, "init ok");
  assert(pure.phases[0].tasks[0].status === "in_progress", "auto in_progress");
  const done = applyTodoOp(pure.phases, { op: "done", task: "Probe login" });
  assert(done.phases[0].tasks[1].status === "in_progress", "auto promote");
  assert(formatTodoSummary(done.phases).includes("[x]"), "summary marks");

  // settlement
  assert(resolveTerminalTaskStatus({ gateCanComplete: false, finishStatus: "completed" }) === "completed", "no demote");
  assert(finishScanSettlesTask({ status: "completed", findingsDedupedCount: 1 }).canComplete, "settle completed");
  assert(allowCompletedDespiteCoverageGaps({ eligibilityAllowed: false, confirmedFindingCount: 1 }), "findings waive");

  // runtime tools
  const taskId = "smoke-task";
  const taskDir = join(root, taskId);
  await mkdir(join(taskDir, "evidence"), { recursive: true });
  await mkdir(join(taskDir, "findings"), { recursive: true });
  await mkdir(join(taskDir, "scripts"), { recursive: true });
  const task: TaskEnvelope = {
    taskId,
    conversationId: "c1",
    instruction: "smoke",
    target: { value: "http://127.0.0.1:9" },
    scope: { allow: ["127.0.0.1:9"] },
  };
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

  const todoTool = createTodoTool(runtime);
  await todoTool.execute!("t1", {
    op: "init",
    items: ["Write exploit", "Confirm finding", "Finish"],
  });
  assert(runtime.todo.openCount() === 3, "open count");
  assert(messages.some((m) => m.type === "todo_updated"), "todo event");

  const script = createScriptTool(runtime);
  await script.execute!("s1", {
    action: "write",
    filename: "hello.py",
    content: "print('node4-ok')\n",
  });
  const run = JSON.parse((await script.execute!("s2", { action: "run", filename: "hello.py" })).content[0].text);
  assert(run.ok === true && String(run.stdout).includes("node4-ok"), `script run: ${JSON.stringify(run).slice(0, 200)}`);
  const evidenceId = run.evidence_id as string;
  assert(evidenceId, "evidence from script");

  // leave todo open — must not block completed
  const finding = createFindingTool(runtime);
  await finding.execute!("f1", {
    action: "confirm",
    title: "Demo · GET /x",
    severity: "high",
    finding_kind: "vuln",
    evidence_ids: [evidenceId],
    description: "smoke finding",
  });
  assert(messages.some((m) => m.type === "vuln_found"), "vuln event");

  const finish = createFinishTool(runtime);
  const fin = JSON.parse(
    (
      await finish.execute!("fin1", {
        status: "completed",
        summary: "Smoke complete with one finding.",
        evidence_ids: [evidenceId],
      })
    ).content[0].text,
  );
  assert(fin.ok === true, `finish ok: ${JSON.stringify(fin).slice(0, 300)}`);
  assert(runtime.lifecycle.finishScan?.status === "completed", "lifecycle completed");
  assert(fin.open_todo >= 1, "todo still open but finish accepted");

  const terminal = resolveTerminalTaskStatus({
    gateCanComplete: false,
    finishStatus: runtime.lifecycle.finishScan?.status,
  });
  assert(terminal === "completed", "terminal completed despite gate false");
  await platform.send({
    type: "task_complete",
    conversation_id: task.conversationId,
    task_id: task.taskId,
    status: terminal,
    summary: runtime.lifecycle.finishScan?.summary,
  });
  assert(messages.some((m) => m.type === "task_complete" && m.status === "completed"), "task_complete completed");

  // vacuous completed rejected
  const runtime2: ToolRuntime = {
    ...runtime,
    task: { ...task, taskId: "smoke2" },
    taskDir: join(root, "smoke2"),
    findingsDir: join(root, "smoke2", "findings"),
    evidence: new EvidenceStore(join(root, "smoke2", "evidence")),
    todo: new TodoStore(),
    lifecycle: {},
  };
  await mkdir(runtime2.findingsDir, { recursive: true });
  await mkdir(join(root, "smoke2", "evidence"), { recursive: true });
  const blocked = JSON.parse(
    (await createFinishTool(runtime2).execute!("fin2", { status: "completed", summary: "nothing" })).content[0].text,
  );
  assert(blocked.ok === false && blocked.blocked === true, "vacuous completed blocked");

  const prompt = buildSystemPrompt(task);
  assert(prompt.includes("todo") && prompt.includes("script"), "short prompt");
  assert(!prompt.includes("coverage(plan)"), "no coverage ceremony");

  // structural: TUI deferred in design doc
  const { readFile } = await import("node:fs/promises");
  const docPath = join(process.cwd(), "..", "docs", "node4-harness.md");
  const doc = await readFile(docPath, "utf8");
  assert(/TUI/i.test(doc) && /[Dd]efer|[Rr]eserved/.test(doc), "docs defer TUI");

  console.log(
    JSON.stringify(
      {
        ok: true,
        pure_todo: true,
        script_run: true,
        finish_with_open_todo: true,
        no_demote_completed: true,
        vacuous_completed_blocked: true,
        taskDir,
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
