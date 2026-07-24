/**
 * #71 Production fan-out path: Hard stage child can use subagent host (depth 0),
 * packages land on child cache, finalize promote → parent bookable candidates.
 * Exercises shipped buildHardGraphStageChildRuntime + promoteStageSubagentPackagesToParent
 * + createSubagentTool host check — not hand-only absorb helpers.
 *
 * Run: npx tsx src/runtime/hard-graph-stage-fanout-path.test.ts
 */
import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlatformSink, ToolRuntime } from "../types.js";
import { EvidenceStore } from "../stores/evidence.js";
import { GoalStore } from "../stores/goal.js";
import { TodoStore } from "../stores/todo.js";
import { createFindingTool } from "../tools/finding.js";
import { createSubagentTool } from "../tools/subagent.js";
import { assertSubagentNestAllowed } from "./subagent-handoff.js";
import { rememberSubagentEvidence } from "./subagent-booking.js";
import { evaluateCandidatesForAcceptance } from "./subagent-result.js";
import {
  seedStageLifecycleFromParent,
} from "./hard-graph-continuity.js";
import {
  buildHardGraphStageChildRuntime,
  promoteStageSubagentPackagesToParent,
} from "./hard-graph-stage-executor.js";
import type { RolePack } from "../roles/types.js";

function textOf(result: { content?: Array<{ type?: string; text?: string }> }): string {
  const item = result.content?.find((c) => c.type === "text");
  return String(item?.text || "");
}

async function parentRuntime(): Promise<ToolRuntime> {
  const root = await mkdtemp(join(tmpdir(), "hard-stage-fanout-"));
  const taskDir = join(root, "task");
  const platform: PlatformSink = { async send() {} };
  return {
    task: {
      taskId: "stage-fanout",
      conversationId: "c",
      instruction: "probe",
      target: { type: "url", value: "http://127.0.0.1:3010" },
      scope: { allow: ["127.0.0.1"] },
      graphDiscipline: "hard",
    },
    workspaceDir: root,
    taskDir,
    platform,
    todo: new TodoStore(),
    evidence: new EvidenceStore(join(taskDir, "evidence")),
    findingsDir: join(taskDir, "findings"),
    goals: new GoalStore(),
    rolePackId: "pentest",
    lifecycle: {
      toolsInLastSegment: 0,
      recentObservations: [],
      subagentDepth: 0,
      subagentEvidenceCache: [],
    },
  } as unknown as ToolRuntime;
}

const pack: RolePack = {
  id: "pentest",
  label: "pentest",
  toolNames: ["todo", "write", "shell", "http", "subagent", "skill", "fact", "finding"],
  skillIds: [],
};

const parent = await parentRuntime();
const workDir = join(parent.taskDir, "hard-graph", "app_assessment", "stage-2-class_probe");

const tools = ["todo", "write", "shell", "http", "subagent", "skill", "fact"];
const { childRuntime } = buildHardGraphStageChildRuntime({
  parent,
  workDir,
  tools,
  pack,
});

// --- Production wiring: host present + nest allowed (this failed before #71 fix) ---
assert.ok(childRuntime.subagents, "stage child must have SubagentHost when subagent allowed");
const nest = assertSubagentNestAllowed(childRuntime.lifecycle.subagentDepth);
assert.equal(nest.ok, true, "stage captain depth must allow subagent packages");
assert.equal(childRuntime.lifecycle.subagentDepth, 0);

// Real tool entry: list must not return "host not available"
const subTool = createSubagentTool(childRuntime);
const listOut = textOf(await subTool.execute("list1", { op: "list" }));
assert.ok(!/host not available/i.test(listOut), `subagent list failed: ${listOut.slice(0, 200)}`);
assert.ok(listOut.includes("idle") || listOut.includes("ok") || listOut.includes("{"), listOut.slice(0, 120));

// Without subagent in allowlist → no host (fail-closed tool surface)
const noFan = buildHardGraphStageChildRuntime({
  parent,
  workDir: join(parent.taskDir, "stage-no-sub"),
  tools: ["todo", "write", "shell"],
  pack,
});
assert.equal(noFan.childRuntime.subagents, undefined);
const blockedTool = createSubagentTool(noFan.childRuntime);
const blocked = textOf(await blockedTool.execute("b", { op: "list" }));
assert.match(blocked, /host not available/i);

// Simulate two packages landing on stage child the way createSubagentTool does (rememberSubagentEvidence)
const PROOF_A =
  "POST /rest/user/login SQLi email returns HTTP 200 admin JWT token field in JSON body";
const PROOF_B =
  "GET /rest/memories without auth returns User.password MD5 hashes in nested JSON objects";
rememberSubagentEvidence(childRuntime, {
  subagentId: "sub_sqli_worker",
  nodeType: "class_probe",
  candidates: [
    {
      title: "Login SQLi",
      location: "http://127.0.0.1:3010/rest/user/login",
      proof_excerpt: PROOF_A,
      poc_hint: "POST login with SQLi email; observed 200 JWT for admin in body",
    },
  ],
  acceptance: evaluateCandidatesForAcceptance([
    {
      title: "Login SQLi",
      location: "http://127.0.0.1:3010/rest/user/login",
      proof_excerpt: PROOF_A,
    },
  ]),
  at: Date.now(),
});
rememberSubagentEvidence(childRuntime, {
  subagentId: "sub_memories_worker",
  nodeType: "class_probe",
  candidates: [
    {
      title: "Memories hash leak",
      location: "http://127.0.0.1:3010/rest/memories",
      proof_excerpt: PROOF_B,
    },
  ],
  acceptance: evaluateCandidatesForAcceptance([
    {
      title: "Memories hash leak",
      location: "http://127.0.0.1:3010/rest/memories",
      proof_excerpt: PROOF_B,
    },
  ]),
  at: Date.now(),
});

const promoted = promoteStageSubagentPackagesToParent(parent, childRuntime, "class_probe");
assert.equal(promoted, 2, "two worker packages promoted to parent");
const parentPacks = parent.lifecycle.subagentEvidenceCache || [];
assert.ok(parentPacks.length >= 2, "parent holds joined packages");
assert.ok(
  parentPacks.some((p) => String(p.subagentId).includes("class_probe")),
  "package keys under hard-stage:class_probe:*",
);

// Book stage seeds and confirms without act tools
const book = await parentRuntime();
book.findingsDir = parent.findingsDir;
book.evidence = parent.evidence;
book.task = parent.task;
book.platform = parent.platform;
seedStageLifecycleFromParent(parent, book);
const finding = createFindingTool(book);
const a = textOf(
  await finding.execute("a", {
    action: "confirm",
    title: "Login SQLi",
    severity: "critical",
    location: "http://127.0.0.1:3010/rest/user/login",
    description: "SQL injection auth bypass proven by class_probe fan-out worker package.",
  }),
);
assert.ok(!a.startsWith("error:"), a.slice(0, 280));
const b = textOf(
  await finding.execute("b", {
    action: "confirm",
    title: "Memories hash leak",
    severity: "high",
    location: "http://127.0.0.1:3010/rest/memories",
    description: "Public memories endpoint leaks password hashes proven by fan-out worker.",
  }),
);
assert.ok(!b.startsWith("error:"), b.slice(0, 280));
const files = (await readdir(parent.findingsDir)).filter((f) => f.endsWith(".json"));
assert.equal(files.length, 2);

console.log("hard-graph-stage-fanout-path.test.ts: ok");
