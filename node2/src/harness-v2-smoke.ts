/**
 * Harness v2 smoke: pure todo ops, finish without checklist hard-reject,
 * evidence-oriented completed with findings, session terminal status,
 * poc write path presence.
 */
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { applyTodoOp, TodoStore, formatTodoSummary } from "./stores/todo.js";
import { PlanStore } from "./stores/plan.js";
import { CoverageStore } from "./stores/coverage.js";
import { EvidenceStore } from "./stores/evidence.js";
import { TrafficStore } from "./stores/traffic.js";
import { createTodoTool, projectTodoIntoPlan } from "./tools/todo.js";
import { createFinishScanTool } from "./tools/finish.js";
import { createPocTool } from "./tools/poc.js";
import {
  allowCompletedDespiteCoverageGaps,
  finishScanSettlesTask,
  resolveTerminalTaskStatus,
} from "./runtime/finish-settlement.js";
import { buildSystemPrompt } from "./runtime/prompt.js";
import type { PlatformMessage, PlatformSink, ToolRuntime, TaskEnvelope } from "./types.js";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const scratchRoot = process.env.HARNESS_SMOKE_DIR || join(process.cwd(), "tmp", "node2-harness-v2-smoke");
const taskId = `harness-v2-${Date.now()}`;
const taskDir = join(scratchRoot, taskId);

const messages: PlatformMessage[] = [];
const platform: PlatformSink = {
  async send(message) {
    messages.push(message);
  },
};

const task: TaskEnvelope = {
  taskId,
  conversationId: "conv-harness-v2",
  instruction: "authorized lab assessment",
  engagement: "assess",
  target: { value: "http://127.0.0.1:8080" },
  scope: { allow: ["127.0.0.1:8080"] },
  snapshot: {},
};

async function main() {
  await mkdir(taskDir, { recursive: true });

  // --- Pure todo transitions ---
  const pure = applyTodoOp([], {
    op: "init",
    list: [
      { phase: "Recon", items: ["Map login and modules", "Capture session cookie"] },
      { phase: "Injection", items: ["Probe SQLi on id", "Confirm with dump"] },
    ],
  });
  assert(pure.errors.length === 0, "init should succeed");
  assert(pure.phases[0].tasks[0].status === "in_progress", "first pending auto-promotes");
  assert(pure.phases.flatMap((p) => p.tasks).filter((t) => t.status === "in_progress").length === 1, "single in_progress");

  const afterDone = applyTodoOp(pure.phases, { op: "done", task: "Map login and modules" });
  assert(afterDone.errors.length === 0, "done ok");
  assert(afterDone.phases[0].tasks[0].status === "completed", "done marks completed");
  assert(afterDone.phases[0].tasks[1].status === "in_progress", "next auto-starts");
  assert(afterDone.completedTasks.length === 1, "completion transition");

  const bad = applyTodoOp(afterDone.phases, { op: "done", task: "task-1" });
  assert(bad.errors.length > 0, "task-1 id rejected");
  assert(bad.phases[0].tasks[1].status === "in_progress", "failed op discarded");

  const summary = formatTodoSummary(afterDone.phases);
  assert(summary.includes("[x]") && summary.includes("[/]"), "summary tree marks");

  // --- Runtime todo tool + plan projection ---
  const todo = new TodoStore();
  const runtime: ToolRuntime = {
    task,
    workspaceDir: scratchRoot,
    platform,
    plan: new PlanStore(),
    todo,
    coverage: new CoverageStore(),
    evidence: new EvidenceStore(join(taskDir, "evidence")),
    traffic: new TrafficStore(),
    pocCatalogPath: join(process.cwd(), "poc-catalog", "web-vulns.json"),
    workflowRuns: [],
    lifecycle: {},
  };
  runtime.plan.start();

  const todoTool = createTodoTool(runtime);
  const initResult = await todoTool.execute!("call_init", {
    op: "init",
    list: [{ phase: "Assess", items: ["Login DVWA", "Test command injection", "Write report"] }],
  });
  const initText = initResult.content[0].text;
  assert(initText.includes("Login DVWA"), "todo tool returns phases");
  assert(todo.openCount() === 3, "3 open after init with one in_progress counted open");
  projectTodoIntoPlan(runtime);
  const planSnap = runtime.plan.snapshot();
  assert(planSnap.some((n) => n.source === "todo" && n.title === "Login DVWA"), "todo projected to plan");
  assert(messages.some((m) => m.type === "todo_updated"), "todo_updated event");
  assert(messages.some((m) => m.type === "plan_tree_updated" && Array.isArray((m as any).todo_phases)), "plan carries todo_phases");

  // Open checklist alone must not block completed when findings+evidence exist.
  runtime.plan.upsert({
    node_id: "legacy-open",
    title: "Legacy open step",
    status: "pending",
    kind: "task",
    level: "work_item",
    parent_id: "workflow-testing",
    source: "agent",
  });
  assert((runtime.plan.openIntentionalChecklist?.() || []).length >= 1, "legacy checklist open");

  const evidence = await runtime.evidence.create({
    type: "tool_output",
    sourceTool: "http",
    summary: "cmd injection proof",
    data: { out: "uid=33(www-data)" },
  });
  const findingsDir = join(taskDir, "findings");
  await mkdir(findingsDir, { recursive: true });
  await writeFile(
    join(findingsDir, "f1.json"),
    JSON.stringify({
      id: "f1",
      title: "OS Command Injection · POST /vulnerabilities/exec/",
      severity: "critical",
      action: "confirm",
      evidence_ids: [evidence.id],
      finding_kind: "vuln",
    }),
    "utf8",
  );

  const finishTool = createFinishScanTool(runtime);
  const finishOk = await finishTool.execute!("call_finish", {
    status: "completed",
    summary: "Confirmed 1 critical command injection with evidence.",
    evidence_ids: [evidence.id],
  });
  const finishBody = JSON.parse(finishOk.content[0].text);
  assert(finishBody.ok === true, `finish should allow completed with open checklist: ${finishOk.content[0].text.slice(0, 400)}`);
  assert(finishBody.finish_scan?.status === "completed", "status completed");
  const softGaps = finishBody.finish_scan?.coverageGaps || [];
  assert(
    softGaps.some((g: string) => String(g).includes("soft_open") || String(g).includes("soft_")),
    "soft open notes recorded",
  );

  // Without findings, assess completed still blocked by conversion gaps (evidence-oriented).
  const taskId2 = `${taskId}-nofind`;
  const taskDir2 = join(scratchRoot, taskId2);
  await mkdir(join(taskDir2, "evidence"), { recursive: true });
  const runtime2: ToolRuntime = {
    ...runtime,
    task: { ...task, taskId: taskId2 },
    plan: new PlanStore(),
    todo: new TodoStore(),
    coverage: new CoverageStore(),
    evidence: new EvidenceStore(join(taskDir2, "evidence")),
    traffic: new TrafficStore(),
    lifecycle: {},
  };
  runtime2.plan.start();
  await runtime2.coverage.mark({
    endpoint: "/vulnerabilities/sqli/",
    param: "id",
    vulnClass: "sql-injection",
    status: "observed",
  });
  const finishBlocked = await createFinishScanTool(runtime2).execute!("call_finish2", {
    status: "completed",
    summary: "Nothing confirmed yet but claiming complete.",
  });
  const blockedBody = JSON.parse(finishBlocked.content[0].text);
  assert(blockedBody.ok === false && blockedBody.blocked === true, "no findings + gaps still blocks completed");

  // PoC write path (no sandbox run required for this smoke)
  const pocTool = createPocTool(runtime);
  const written = await pocTool.execute!("call_poc", {
    action: "write",
    filename: "probe.py",
    content: "print('ok')\n",
  });
  const writtenBody = JSON.parse(written.content[0].text);
  assert(writtenBody.ok === true, "poc write ok");
  const disk = await readFile(writtenBody.path, "utf8");
  assert(disk.includes("print"), "poc file on disk");

  // Prompt contract
  const prompt = buildSystemPrompt(task);
  assert(prompt.includes("todo"), "prompt mentions todo");
  assert(prompt.includes("Harness v2") || prompt.includes("Main loop"), "prompt is harness v2");
  assert(!prompt.includes("finish_scan(completed) is rejected while intentional"), "prompt does not mandate checklist gate");
  assert(prompt.toLowerCase().includes("poc"), "prompt mentions poc");

  // Session settlement: finish_scan(completed) + findings must not demote to incomplete
  // even when assess conversion eligibility would fail (mirrors session-runner path).
  assert(
    allowCompletedDespiteCoverageGaps({ eligibilityAllowed: false, confirmedFindingCount: 2 }) === true,
    "findings waive conversion gaps",
  );
  assert(
    allowCompletedDespiteCoverageGaps({ eligibilityAllowed: false, confirmedFindingCount: 0 }) === false,
    "no findings keep conversion hard gate",
  );
  const settlement = finishScanSettlesTask({
    status: "completed",
    confirmedFindings: ["SQL Injection · GET /x"],
    findingsDedupedCount: 1,
  });
  assert(settlement.canComplete === true && settlement.settled === true, "finishScanSettlesTask completed");
  const demoted = resolveTerminalTaskStatus({
    gateCanComplete: false,
    finishStatus: "completed",
  });
  assert(demoted === "completed", `must not demote completed→incomplete, got ${demoted}`);

  // End-to-end finish tool → lifecycle record → terminal status (session-runner contract)
  assert(runtime.lifecycle.finishScan?.status === "completed", "lifecycle finish stored completed");
  const endToEndTerminal = resolveTerminalTaskStatus({
    // Simulate old buggy gate that re-checked conversion without findings bypass
    gateCanComplete: false,
    finishStatus: runtime.lifecycle.finishScan?.status,
  });
  assert(endToEndTerminal === "completed", "session terminal must be completed after accepted finish");

  // Emit the same task_complete shape session-runner uses for completed settlement
  await platform.send({
    type: "task_complete",
    conversation_id: task.conversationId,
    task_id: task.taskId,
    status: endToEndTerminal,
    summary: runtime.lifecycle.finishScan?.summary || "done",
  });
  const terminalMsgs = messages.filter((m) => m.type === "task_complete");
  assert(
    terminalMsgs.some((m) => m.status === "completed"),
    `task_complete status=completed required, got ${JSON.stringify(terminalMsgs.map((m) => m.status))}`,
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        pure_todo: true,
        finish_with_open_checklist: true,
        finish_without_findings_blocked: true,
        session_terminal_completed: true,
        no_demote_completed: true,
        poc_write: true,
        prompt_v2: true,
        taskDir,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
