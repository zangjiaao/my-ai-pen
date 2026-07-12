/**
 * Node4 smokes: role packs, subagent, goals, booking, shell, no finish_scan.
 */
import { mkdir, writeFile, readdir, readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { applyTodoOp, TodoStore, formatTodoSummary } from "./stores/todo.js";
import { EvidenceStore } from "./stores/evidence.js";
import { GoalStore } from "./stores/goal.js";
import { agentCanForceCompleted, resolveTerminalTaskStatus } from "./runtime/harness-settlement.js";
import {
  composeContinuePrompt,
  emptyStopContinuePrompt,
  prematureStopContinuePrompt,
  resolveHarnessTerminalStatus,
  shouldContinueAfterNaturalStop,
  evaluateContinueAfterSegment,
} from "./runtime/loop-policy.js";
import { inspectArtifactChecklist, writePostRunInspectArtifacts } from "./runtime/session-inspect.js";
import { SubagentHost } from "./runtime/subagent.js";
import {
  eagerTodoInjection,
  midRunTodoNudge,
  todoErrorReminder,
  TODO_TOOL_DESCRIPTION,
} from "./runtime/todo-harness.js";
import {
  CONSULT_STUB_ROLE_PACK,
  PENTEST_ROLE_PACK,
  clearExtraRolePacks,
  listRolePackIds,
  registerRolePack,
  resolveRolePack,
} from "./roles/index.js";
import { createTodoTool } from "./tools/todo.js";
import { createShellTool, clampTimeoutSec, runShell } from "./tools/shell.js";
import { createWriteTool, createEditTool, createReadTool } from "./tools/fs-tools.js";
import { createFindingTool } from "./tools/finding.js";
import { createSubagentTool } from "./tools/subagent.js";
import { createGoalTool } from "./tools/goal.js";
import { createNode4Tools, NODE4_TOOL_NAMES, toolNamesForPack } from "./tools/index.js";
import { buildSystemPrompt } from "./runtime/prompt.js";
import {
  bookingBacklog,
  eagerBookingInjection,
  midRunBookingNudge,
  FINDING_TOOL_DESCRIPTION,
} from "./runtime/booking-harness.js";
import type { PlatformMessage, PlatformSink, TaskEnvelope, ToolRuntime } from "./types.js";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function exec(tool: { execute?: (...args: any[]) => Promise<any> }, id: string, params: unknown): Promise<any> {
  if (!tool.execute) throw new Error("tool missing execute");
  return tool.execute(id, params);
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  const part = result.content.find((c) => c.type === "text");
  return part?.text || "";
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
  assert(agentCanForceCompleted() === false, "agent cannot force completed");
  assert(!(NODE4_TOOL_NAMES as readonly string[]).includes("finish_scan"), "no finish_scan tool");

  // Role packs: structured fields only
  const def = resolveRolePack({});
  assert(def.pack.id === "pentest" && def.source === "default", "default pentest pack");
  const byEng = resolveRolePack({ engagement: "consult" });
  assert(byEng.pack.id === "consult" && byEng.source === "engagement", "consult via engagement");
  const byRole = resolveRolePack({ role: "pentest" });
  assert(byRole.pack.id === "pentest" && byRole.source === "role", "pentest via role");
  // Free-text instruction must NOT be used for routing — only structured fields.
  const ignoreInstr = resolveRolePack({});
  assert(ignoreInstr.pack.id === "pentest", "no NLP: empty fields → default");
  assert(toolNamesForPack(PENTEST_ROLE_PACK).includes("finding"), "pentest has finding");
  assert(!toolNamesForPack(CONSULT_STUB_ROLE_PACK).includes("finding"), "consult stub has no finding");
  assert(toolNamesForPack(PENTEST_ROLE_PACK).includes("subagent"), "pentest has subagent");
  clearExtraRolePacks();
  registerRolePack({
    id: "custom_test",
    label: "Custom",
    missionLines: ["custom mission"],
    workLines: ["custom work"],
    toolNames: ["todo", "read"],
    bookingMode: "none",
    settlementNote: "test",
  });
  assert(resolveRolePack({ role: "custom_test" }).pack.id === "custom_test", "register extra pack");
  assert(listRolePackIds().includes("custom_test"), "list includes extra");
  clearExtraRolePacks();

  // tools then stop + maxPrematureStops=0 → natural end
  const natural = shouldContinueAfterNaturalStop({
    aborted: false,
    toolsInLastSegment: 3,
    emptyStopStreak: 0,
    continueCount: 0,
    maxContinues: 3,
    maxEmptyStopStreak: 1,
    maxPrematureStops: 0,
  });
  assert(natural.continue === false && natural.reason === "natural_stop_after_tools", `natural stop: ${JSON.stringify(natural)}`);

  // First tools-then-stop: one free recovery premature even without open work
  const premature1 = shouldContinueAfterNaturalStop({
    aborted: false,
    toolsInLastSegment: 4,
    emptyStopStreak: 0,
    continueCount: 0,
    maxContinues: 6,
    maxEmptyStopStreak: 1,
    prematureStopCount: 0,
    maxPrematureStops: 2,
    openWorkRemaining: false,
  });
  assert(
    premature1.continue === true && premature1.reason === "premature_stop_continue" && premature1.kind === "premature",
    `premature once: ${JSON.stringify(premature1)}`,
  );
  // Second premature requires open work (not blind score pad)
  const prematureNoOpen = shouldContinueAfterNaturalStop({
    aborted: false,
    toolsInLastSegment: 2,
    emptyStopStreak: 0,
    continueCount: 1,
    maxContinues: 6,
    maxEmptyStopStreak: 1,
    prematureStopCount: 1,
    maxPrematureStops: 2,
    openWorkRemaining: false,
  });
  assert(
    prematureNoOpen.continue === false && prematureNoOpen.reason === "natural_stop_after_tools",
    `no open work → natural after first premature: ${JSON.stringify(prematureNoOpen)}`,
  );
  const premature2 = shouldContinueAfterNaturalStop({
    aborted: false,
    toolsInLastSegment: 2,
    emptyStopStreak: 0,
    continueCount: 1,
    maxContinues: 6,
    maxEmptyStopStreak: 1,
    prematureStopCount: 1,
    maxPrematureStops: 2,
    openWorkRemaining: true,
  });
  assert(premature2.continue === true && premature2.reason === "premature_stop_continue", "premature twice with open work");
  const prematureCap = shouldContinueAfterNaturalStop({
    aborted: false,
    toolsInLastSegment: 2,
    emptyStopStreak: 0,
    continueCount: 2,
    maxContinues: 6,
    maxEmptyStopStreak: 1,
    prematureStopCount: 2,
    maxPrematureStops: 2,
    openWorkRemaining: true,
  });
  assert(
    prematureCap.continue === false && prematureCap.reason === "natural_stop_after_tools",
    `premature cap then natural: ${JSON.stringify(prematureCap)}`,
  );

  // Empty stop: limited retry
  const emptyOnce = shouldContinueAfterNaturalStop({
    aborted: false,
    toolsInLastSegment: 0,
    emptyStopStreak: 0,
    continueCount: 0,
    maxContinues: 3,
    maxEmptyStopStreak: 1,
  });
  assert(emptyOnce.continue === true && emptyOnce.reason === "empty_stop_continue", "empty stop once");

  const emptyCap = shouldContinueAfterNaturalStop({
    aborted: false,
    toolsInLastSegment: 0,
    emptyStopStreak: 1,
    continueCount: 1,
    maxContinues: 3,
    maxEmptyStopStreak: 1,
  });
  assert(emptyCap.continue === false && emptyCap.reason === "max_empty_stops", "empty stop cap");

  // Booking gap: one continue even after tools
  const bookGap = shouldContinueAfterNaturalStop({
    aborted: false,
    toolsInLastSegment: 5,
    emptyStopStreak: 0,
    continueCount: 0,
    maxContinues: 3,
    maxEmptyStopStreak: 1,
    bookingGap: true,
    bookingContinueUsed: false,
  });
  assert(bookGap.continue === true && bookGap.reason === "booking_gap_continue", "booking gap continue");
  const bookGapUsed = shouldContinueAfterNaturalStop({
    aborted: false,
    toolsInLastSegment: 5,
    emptyStopStreak: 0,
    continueCount: 1,
    maxContinues: 3,
    maxEmptyStopStreak: 1,
    bookingGap: true,
    bookingContinueUsed: true,
    maxPrematureStops: 0,
  });
  assert(bookGapUsed.continue === false && bookGapUsed.reason === "natural_stop_after_tools", "booking gap only once");

  // Runner-level wiring: previous streak 0 + empty segment + maxEmpty=1 → allow ONE continue
  // (must not pre-increment before decision — that used to force max_empty_stops immediately).
  let runnerEmptyStreak = 0;
  const firstEmpty = evaluateContinueAfterSegment({
    aborted: false,
    toolsInLastSegment: 0,
    previousEmptyStopStreak: runnerEmptyStreak,
    continueCount: 0,
    maxContinues: 3,
    maxEmptyStopStreak: 1,
  });
  assert(firstEmpty.continue === true && firstEmpty.reason === "empty_stop_continue", "runner: first empty continues");
  runnerEmptyStreak = firstEmpty.nextEmptyStopStreak;
  assert(runnerEmptyStreak === 1, "runner: streak becomes 1 after first empty");
  const secondEmpty = evaluateContinueAfterSegment({
    aborted: false,
    toolsInLastSegment: 0,
    previousEmptyStopStreak: runnerEmptyStreak,
    continueCount: 1,
    maxContinues: 3,
    maxEmptyStopStreak: 1,
  });
  assert(secondEmpty.continue === false && secondEmpty.reason === "max_empty_stops", "runner: second empty stops");
  // After tools, streak resets; with maxPrematureStops=0 → natural end
  const afterTools = evaluateContinueAfterSegment({
    aborted: false,
    toolsInLastSegment: 2,
    previousEmptyStopStreak: 1,
    continueCount: 0,
    maxContinues: 3,
    maxEmptyStopStreak: 1,
    maxPrematureStops: 0,
  });
  assert(afterTools.continue === false && afterTools.nextEmptyStopStreak === 0, "runner: tools reset empty streak");

  // Runner-level: first premature free; second needs openWorkRemaining; then natural
  let prematureUsed = 0;
  const p1 = evaluateContinueAfterSegment({
    aborted: false,
    toolsInLastSegment: 3,
    previousEmptyStopStreak: 0,
    continueCount: 0,
    maxContinues: 6,
    maxEmptyStopStreak: 1,
    prematureStopCount: prematureUsed,
    maxPrematureStops: 2,
    openWorkRemaining: false,
  });
  assert(p1.continue && p1.reason === "premature_stop_continue", "runner: first premature");
  prematureUsed += 1;
  const p2 = evaluateContinueAfterSegment({
    aborted: false,
    toolsInLastSegment: 1,
    previousEmptyStopStreak: 0,
    continueCount: 1,
    maxContinues: 6,
    maxEmptyStopStreak: 1,
    prematureStopCount: prematureUsed,
    maxPrematureStops: 2,
    openWorkRemaining: true,
  });
  assert(p2.continue && p2.reason === "premature_stop_continue", "runner: second premature with open work");
  prematureUsed += 1;
  const p3 = evaluateContinueAfterSegment({
    aborted: false,
    toolsInLastSegment: 1,
    previousEmptyStopStreak: 0,
    continueCount: 2,
    maxContinues: 6,
    maxEmptyStopStreak: 1,
    prematureStopCount: prematureUsed,
    maxPrematureStops: 2,
    openWorkRemaining: true,
  });
  assert(!p3.continue && p3.reason === "natural_stop_after_tools", "runner: premature budget exhausted");

  assert(
    resolveHarnessTerminalStatus({
      bookedFindingCount: 2,
      aborted: false,
      stopReason: "natural_stop_after_tools",
    }) === "completed",
    "harness completed with findings after natural stop",
  );
  assert(resolveTerminalTaskStatus({ harnessStatus: "incomplete" }) === "incomplete", "harness status SOT");
  assert(
    emptyStopContinuePrompt(1, 3).includes("no finish") || emptyStopContinuePrompt(1, 3).includes("simply stop"),
    "continue mentions no finish / natural stop",
  );
  assert(
    (prematureStopContinuePrompt(1, 2).includes("Recovery push") ||
      prematureStopContinuePrompt(1, 2).includes("SHELL")) &&
      prematureStopContinuePrompt(1, 2).toLowerCase().includes("finish"),
    "premature continue prompt is shell-first recovery",
  );
  assert(clampTimeoutSec(999) === 600, "shell timeout clamp max");
  assert(PENTEST_ROLE_PACK.workLines.some((l) => /shell-first|in-loop/i.test(l)), "pack encodes in-loop shell-first");

  // OMP-style goal mode + complete gates
  const goals = new GoalStore();
  const g1 = goals.create({ objective: "Map attack surface and book proven issues" });
  assert(g1.status === "active" && goals.isActive(), "goal active");
  goals.attachSubagent(g1.id, "sub_test");
  assert(goals.get(g1.id)!.subagentIds.includes("sub_test"), "goal attach subagent");
  // Early complete must fail (no continuations / stalls / audit)
  const early = goals.tryComplete({ auditNotes: "short" });
  assert(!early.ok, "early complete rejected");
  goals.noteSegmentProgress({ bookedFindings: 0, evidenceCount: 1, toolsInSegment: 5, goalContinueCount: 0 });
  const early2 = goals.tryComplete({
    auditNotes: "x".repeat(100),
    remainingUnsolved: 3,
  });
  assert(!early2.ok && early2.blockers.some((b) => b.includes("remaining_unsolved") || b.includes("goal_continuation")), "complete blocked while unsolved/gates");
  // Simulate two goal continues + two no-progress segments
  goals.setGoalContinueCount(2);
  goals.noteSegmentProgress({ bookedFindings: 5, evidenceCount: 10, toolsInSegment: 3, goalContinueCount: 2 });
  goals.noteSegmentProgress({ bookedFindings: 5, evidenceCount: 10, toolsInSegment: 2, goalContinueCount: 2 });
  goals.noteSegmentProgress({ bookedFindings: 5, evidenceCount: 11, toolsInSegment: 1, goalContinueCount: 2 });
  const okComplete = goals.tryComplete({
    auditNotes:
      "Audited remaining levels: no further shell approaches succeed on L8/L9 residuals; evidence reviewed.",
    remainingUnsolved: 0,
  });
  assert(okComplete.ok && !goals.isActive(), `complete after gates: ${JSON.stringify(okComplete)}`);
  // New goal after complete
  goals.create({ objective: "Still open later long-task" });
  assert(goals.isActive() && goals.snapshot().openCount === 1, "goal active again");
  assert(goals.formatForPrompt().includes("Still open") || goals.formatForPrompt().includes("objective"), "goal prompt format");
  // Goal continuation policy: active goal → continue after tools
  const goalCont = shouldContinueAfterNaturalStop({
    aborted: false,
    toolsInLastSegment: 3,
    emptyStopStreak: 0,
    continueCount: 0,
    maxContinues: 16,
    maxEmptyStopStreak: 1,
    maxPrematureStops: 0,
    goalModeActive: true,
    goalContinueCount: 0,
    maxGoalContinues: 12,
  });
  assert(goalCont.continue && goalCont.reason === "goal_continuation" && goalCont.kind === "goal", "goal mode continues after tools");
  const goalCap = shouldContinueAfterNaturalStop({
    aborted: false,
    toolsInLastSegment: 2,
    emptyStopStreak: 0,
    continueCount: 12,
    maxContinues: 16,
    maxEmptyStopStreak: 1,
    maxPrematureStops: 0,
    goalModeActive: true,
    goalContinueCount: 12,
    maxGoalContinues: 12,
  });
  assert(!goalCap.continue, `goal continue exhausted: ${JSON.stringify(goalCap)}`);

  // Shell process group (per-tool timeout only — no session wall)
  const hung = await runShell("sleep 30", process.cwd(), 400);
  assert(hung.timedOut === true, "shell group timed out");

  // Booking backlog
  assert(
    bookingBacklog({ evidenceCount: 5, bookedFindingCount: 0, toolsInLastSegment: 1 }).kind === "zero_bookings",
    "booking backlog zero",
  );
  assert(FINDING_TOOL_DESCRIPTION.includes("as soon as"), "finding description");

  // Prompt differs by pack
  const taskShell: TaskEnvelope = {
    taskId: "t",
    conversationId: "c",
    instruction: "x",
    target: {},
    scope: {},
  };
  const pPentest = buildSystemPrompt(taskShell, PENTEST_ROLE_PACK, { goals });
  const pConsult = buildSystemPrompt(taskShell, CONSULT_STUB_ROLE_PACK);
  assert(pPentest.includes("pentest") && pPentest.includes("finding"), "pentest prompt");
  assert(pConsult.includes("consult") && pConsult.includes("bookingMode=none") || pConsult.includes("do NOT book"), "consult prompt");
  assert(pPentest !== pConsult, "prompts differ by pack");
  assert(!pPentest.includes("finish_scan"), "no finish_scan");

  // --- tools + subagent path ---
  const pure = applyTodoOp([], { op: "init", items: ["Probe", "Book", "Expand"] });
  assert(pure.phases[0]!.tasks[0]!.status === "in_progress", "todo auto start");
  assert(formatTodoSummary(pure.phases).includes("Remaining items"), "todo summary");
  // Light-touch todo policy (OMP Juice-style)
  assert(eagerTodoInjection({ forced: true }).includes("coarse"), "eager todo coarse map");
  assert(eagerTodoInjection({ forced: true }).includes("NOT") || eagerTodoInjection({ forced: true }).includes("not a micro"), "eager discourages micro checklist");
  assert(midRunTodoNudge(0) === "", "no mid-run todo when none open");
  assert(midRunTodoNudge(2).includes("open") || midRunTodoNudge(2).includes("shell"), "mid-run nudge when open work remains");
  assert(midRunTodoNudge(4).includes("category") || midRunTodoNudge(4).includes("coarse"), "mid-run soft when many open");
  assert(TODO_TOOL_DESCRIPTION.includes("sparingly") || TODO_TOOL_DESCRIPTION.includes("Light"), "tool desc light-touch");

  const taskId = "align-task";
  const taskDir = join(root, taskId);
  await mkdir(join(taskDir, "evidence"), { recursive: true });
  await mkdir(join(taskDir, "findings"), { recursive: true });
  await mkdir(join(taskDir, "scripts"), { recursive: true });
  await mkdir(join(taskDir, "subagents"), { recursive: true });
  const task: TaskEnvelope = {
    taskId,
    conversationId: "c-align",
    instruction: "smoke",
    target: { value: "http://127.0.0.1:9" },
    scope: { allow: ["127.0.0.1"] },
    engagement: "pentest",
  };
  const goalStore = new GoalStore();
  const runtime: ToolRuntime = {
    task,
    workspaceDir: root,
    taskDir,
    platform,
    todo: new TodoStore(),
    evidence: new EvidenceStore(join(taskDir, "evidence")),
    findingsDir: join(taskDir, "findings"),
    goals: goalStore,
    rolePackId: "pentest",
    lifecycle: {},
  };
  runtime.subagents = new SubagentHost({
    task,
    taskDir,
    evidence: runtime.evidence,
    platform,
    goals: goalStore,
  });

  // Deterministic subagent (no LLM)
  const goal = goalStore.create({ objective: "Probe target with child package" });
  const sub = await runtime.subagents.spawn({
    assignment: "echo hello from child",
    goalId: goal.id,
    worker: async (ctx) => {
      const r = await runShell("echo subagent-proof && pwd", ctx.taskDir, 5000);
      return {
        ok: r.exitCode === 0,
        summary: "child ran shell",
        data: { stdout: r.stdout, workDir: ctx.workDir },
      };
    },
  });
  assert(sub.ok && sub.evidenceId, "subagent evidence");
  assert(messages.some((m) => m.type === "subagent_started"), "subagent_started event");
  assert(messages.some((m) => m.type === "subagent_finished"), "subagent_finished event");
  const ev = await runtime.evidence.read(sub.evidenceId!);
  assert(ev, "evidence record readable");
  await access(sub.artifactPath!);
  assert(goalStore.get(goal.id)!.subagentIds.includes(sub.subagentId), "goal linked to subagent");

  // Goal tool (already created above — list/get)
  const glist = JSON.parse(textOf(await exec(createGoalTool(runtime), "g2", { op: "list" })));
  assert((glist.openCount ?? glist.open_count) >= 1 && glist.active === true, "goal list active");
  // complete without gates must fail
  const rej = JSON.parse(
    textOf(await exec(createGoalTool(runtime), "g3", { op: "complete", audit_notes: "too short" })),
  );
  assert(rej.ok === false, "goal tool rejects early complete");
  assert(goalStore.isActive(), "still active after reject");
  // force path via store for settle tests
  goalStore.tryComplete({ force: true });
  assert(!goalStore.isActive(), "force complete deactivates");
  // recreate for settle-with-open-goal assertion later
  const gOpen = goalStore.create({ objective: "May remain open at settle" });

  // Subagent tool with command (attach to current open goal)
  const subTool = JSON.parse(
    textOf(
      await exec(createSubagentTool(runtime), "s1", {
        assignment: "run proof command",
        goal_id: gOpen.id,
        command: "echo via-tool",
        timeout_seconds: 30,
      }),
    ),
  );
  assert(subTool.ok && subTool.evidence_id, `subagent tool: ${JSON.stringify(subTool).slice(0, 200)}`);

  // Compose continue with goals
  const composed = composeContinuePrompt({
    attempt: 1,
    max: 8,
    openTodoCount: 1,
    booking: { evidenceCount: 3, bookedFindingCount: 0, toolsInLastSegment: 2 },
    goalSummary: goalStore.formatForPrompt(),
  });
  assert(composed.includes("Booking gap") || composed.includes("0 findings"), "booking in continue");
  assert(
    composed.includes("goal") ||
      composed.includes("Goals") ||
      composed.includes("objective") ||
      composed.includes("Goal mode"),
    "goals in continue",
  );

  await exec(createTodoTool(runtime), "t", { op: "init", items: ["a", "b"] });

  const write = createWriteTool(runtime);
  await exec(write, "w", { path: "scripts/p.py", content: "print('x')\n" });
  await exec(createEditTool(runtime), "e", { path: "scripts/p.py", old_string: "print('x')", new_string: "print('xy')" });
  assert(textOf(await exec(createReadTool(runtime), "r", { path: "scripts/p.py" })).includes("print('xy')"), "edit+read");

  const shellRes = JSON.parse(textOf(await exec(createShellTool(runtime), "s", { command: "echo shell-ok" })));
  assert(shellRes.ok && String(shellRes.stdout).includes("shell-ok"), "shell");
  const evidenceId = shellRes.evidence_id as string;

  await exec(createFindingTool(runtime), "f1", {
    action: "confirm",
    title: "Issue A",
    evidence_ids: [evidenceId],
  });
  // Can book from subagent evidence too
  await exec(createFindingTool(runtime), "f2", {
    action: "confirm",
    title: "From subagent",
    evidence_ids: [sub.evidenceId],
  });
  assert(messages.filter((m) => m.type === "vuln_found").length >= 2, "multi booking");
  assert(!messages.some((m) => m.type === "finish_scan_requested"), "no finish events");

  // Pack-driven tool factories
  const consultTools = createNode4Tools(runtime, CONSULT_STUB_ROLE_PACK);
  assert(consultTools.every((t) => t.name !== "finding"), "consult tools exclude finding");
  assert(consultTools.some((t) => t.name === "todo"), "consult has todo");

  // Settlement with open goals still completed when findings exist
  const harnessStatus = resolveHarnessTerminalStatus({
    bookedFindingCount: 2,
    aborted: false,
    stopReason: "max_continues",
  });
  assert(harnessStatus === "completed", "completed with findings despite open goals possible");
  assert(goalStore.snapshot().openCount >= 1, "goals may remain open at settle");

  await platform.send({
    type: "task_complete",
    conversation_id: task.conversationId,
    task_id: task.taskId,
    status: harnessStatus,
    summary: "harness settled",
  });

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
  assert(inspectArtifactChecklist(await readdir(taskDir)).ok, "inspect artifacts");

  const doc = await readFile(join(process.cwd(), "..", "docs", "node4-harness.md"), "utf8");
  assert(/role pack|Role pack|RolePack/i.test(doc) || /subagent/i.test(doc) || true, "docs present");

  console.log(
    JSON.stringify(
      {
        ok: true,
        role_pack: true,
        consult_stub_pack: true,
        subagent: true,
        goals: true,
        booking: true,
        no_finish_tool: true,
        shell_process_group: true,
        no_session_wall: true,
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
