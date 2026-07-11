/**
 * Node4 OMP-align smokes: shell/write/edit, booking, non-terminal finish,
 * continue policy, post-run inspectability.
 */
import { mkdir, writeFile, readdir, readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { applyTodoOp, TodoStore } from "./stores/todo.js";
import { EvidenceStore } from "./stores/evidence.js";
import {
  agentCanForceCompletedViaFinish,
  agentStatusIsTerminal,
  finishScanSettlesTask,
  resolveTerminalTaskStatus,
} from "./runtime/finish-settlement.js";
import {
  emptyStopContinuePrompt,
  resolveHarnessTerminalStatus,
  shouldContinueAfterNaturalStop,
} from "./runtime/loop-policy.js";
import { inspectArtifactChecklist, writePostRunInspectArtifacts } from "./runtime/session-inspect.js";
import { createTodoTool } from "./tools/todo.js";
import { createShellTool } from "./tools/shell.js";
import { createWriteTool, createEditTool, createReadTool } from "./tools/fs-tools.js";
import { createFindingTool } from "./tools/finding.js";
import { createFinishTool } from "./tools/finish.js";
import { buildSystemPrompt } from "./runtime/prompt.js";
import type { PlatformMessage, PlatformSink, TaskEnvelope, ToolRuntime } from "./types.js";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const root = join(process.cwd(), "tmp", `node4-align-${Date.now()}`);
const messages: PlatformMessage[] = [];
const platform: PlatformSink = {
  async send(m) {
    messages.push(m);
  },
};

async function main() {
  // --- pure policies ---
  assert(agentCanForceCompletedViaFinish() === false, "agent cannot force completed");
  assert(finishScanSettlesTask({ status: "completed", findingsDedupedCount: 5 }).settled === false, "finish non-settling");
  assert(agentStatusIsTerminal({ kind: "summary", summary: "x", calledAt: "" }) === false, "status non-terminal");

  const cont = shouldContinueAfterNaturalStop({
    timedOut: false,
    aborted: false,
    toolsInLastSegment: 3,
    emptyStopStreak: 0,
    continueCount: 0,
    maxContinues: 8,
    maxEmptyStopStreak: 3,
    agentBlocked: false,
  });
  assert(cont.continue === true && cont.reason === "premature_stop_continue", `premature continue: ${JSON.stringify(cont)}`);

  const emptyCap = shouldContinueAfterNaturalStop({
    timedOut: false,
    aborted: false,
    toolsInLastSegment: 0,
    emptyStopStreak: 3,
    continueCount: 1,
    maxContinues: 8,
    maxEmptyStopStreak: 3,
    agentBlocked: false,
  });
  assert(emptyCap.continue === false && emptyCap.reason === "max_empty_stops", "empty stop cap");

  assert(
    resolveHarnessTerminalStatus({
      agentBlocked: false,
      bookedFindingCount: 2,
      timedOut: true,
      aborted: false,
      stopReason: "wall_budget",
    }) === "completed",
    "harness completed after budget with findings",
  );
  assert(
    resolveTerminalTaskStatus({ finishStatus: "completed", harnessStatus: "incomplete" }) === "incomplete",
    "harness status wins over agent finish completed",
  );
  assert(emptyStopContinuePrompt(1, 8).includes("Continue"), "continue prompt");

  // --- tools ---
  const pure = applyTodoOp([], { op: "init", items: ["Probe", "Book", "Expand"] });
  assert(pure.phases[0].tasks[0].status === "in_progress", "todo auto start");

  const taskId = "align-task";
  const taskDir = join(root, taskId);
  await mkdir(join(taskDir, "evidence"), { recursive: true });
  await mkdir(join(taskDir, "findings"), { recursive: true });
  await mkdir(join(taskDir, "scripts"), { recursive: true });
  const task: TaskEnvelope = {
    taskId,
    conversationId: "c-align",
    instruction: "smoke",
    target: { value: "http://127.0.0.1:9" },
    scope: { allow: ["127.0.0.1"] },
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

  await createTodoTool(runtime).execute!("t", { op: "init", items: ["a", "b"] });

  const write = createWriteTool(runtime);
  await write.execute!("w", { path: "scripts/p.py", content: "print('x')\n# marker\n" });
  const edit = createEditTool(runtime);
  await edit.execute!("e", { path: "scripts/p.py", old_string: "print('x')", new_string: "print('xy')" });
  const read = createReadTool(runtime);
  const readOut = await read.execute!("r", { path: "scripts/p.py" });
  assert(String(readOut.content[0].text).includes("print('xy')"), "edit+read");

  const shell = createShellTool(runtime);
  const shellRes = JSON.parse((await shell.execute!("s", { command: "echo shell-ok && pwd" })).content[0].text);
  assert(shellRes.ok === true && String(shellRes.stdout).includes("shell-ok"), `shell: ${JSON.stringify(shellRes).slice(0, 200)}`);
  const evidenceId = shellRes.evidence_id as string;

  // Multi booking mid-run
  await createFindingTool(runtime).execute!("f1", {
    action: "confirm",
    title: "Issue A",
    evidence_ids: [evidenceId],
  });
  await createFindingTool(runtime).execute!("f2", {
    action: "confirm",
    title: "Issue B",
    evidence_ids: [evidenceId],
  });
  assert(messages.filter((m) => m.type === "vuln_found").length === 2, "multi booking");

  // finish_scan does NOT settle / does NOT force completed
  const fin = JSON.parse(
    (
      await createFinishTool(runtime).execute!("fin", {
        status: "completed",
        summary: "I want to stop with findings",
      })
    ).content[0].text,
  );
  assert(fin.non_terminal === true, "finish non_terminal");
  assert(fin.ok === true, "status note ok");
  const stillNotSettled = finishScanSettlesTask({ status: "completed", findingsDedupedCount: 2 });
  assert(stillNotSettled.settled === false, "calling finish does not settle loop");

  // Harness settles after loop — simulate
  const harnessStatus = resolveHarnessTerminalStatus({
    agentBlocked: false,
    bookedFindingCount: 2,
    timedOut: false,
    aborted: false,
    stopReason: "max_continues",
  });
  assert(harnessStatus === "completed", "harness completes after work");
  await platform.send({
    type: "task_complete",
    conversation_id: task.conversationId,
    task_id: task.taskId,
    status: harnessStatus,
    summary: "harness settled",
  });
  assert(
    messages.some((m) => m.type === "task_complete" && m.status === "completed"),
    "task_complete from harness",
  );

  // Post-run inspect artifacts
  await writeFile(join(taskDir, "events.jsonl"), "{}\n", "utf8");
  const dump = await writePostRunInspectArtifacts({
    taskDir,
    taskId,
    terminalStatus: harnessStatus,
    summary: "done",
    messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "ok" }],
    continueCount: 2,
    stopReason: "max_continues",
    bookedFindingCount: 2,
  });
  await access(dump.manifestPath);
  await access(dump.transcriptPath);
  const names = await readdir(taskDir);
  const checklist = inspectArtifactChecklist(names);
  assert(checklist.ok, `missing inspect artifacts: ${checklist.missing.join(",")}`);
  const manifest = JSON.parse(await readFile(join(taskDir, "session-manifest.json"), "utf8"));
  assert(manifest.transcriptMessages === 2, "manifest counts messages");
  const transcript = await readFile(join(taskDir, "transcript.jsonl"), "utf8");
  assert(transcript.includes("assistant"), "transcript readable post-dispose");

  const prompt = buildSystemPrompt(task);
  assert(prompt.includes("NOT a software engineering") || prompt.includes("NOT a coding"), "pentest role");
  assert(prompt.includes("shell") && prompt.includes("finding"), "tools mentioned");
  assert(!prompt.includes("finish_scan once: completed only with"), "old finish-stop guidance gone");

  const doc = await readFile(join(process.cwd(), "..", "docs", "node4-harness.md"), "utf8");
  assert(/booking/i.test(doc) && /inspect/i.test(doc) && /non-terminal|does NOT end/i.test(doc), "docs align");

  console.log(
    JSON.stringify(
      {
        ok: true,
        shell_write_edit: true,
        multi_booking: true,
        finish_non_terminal: true,
        agent_cannot_force_completed: true,
        continue_policy: true,
        post_run_inspectable: true,
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
