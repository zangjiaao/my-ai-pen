/**
 * End-to-end smoke on shipped tool paths: subagent handoff, fact, large shell.
 * Writes proof lines to stdout for goal scratch capture.
 */
import { mkdtemp, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvidenceStore } from "../stores/evidence.js";
import { GoalStore } from "../stores/goal.js";
import { ProcessFactStore } from "../stores/process-fact.js";
import { TodoStore } from "../stores/todo.js";
import type { PlatformMessage, PlatformSink, TaskEnvelope, ToolRuntime } from "../types.js";
import { createSubagentTool } from "./subagent.js";
import { createFactTool } from "./fact.js";
import { createShellTool } from "./shell.js";
import { createFindingTool } from "./finding.js";
import { SubagentHost } from "../runtime/subagent.js";
import { MODEL_TOOL_OUTPUT_CHARS } from "../runtime/tool-output-governance.js";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

function textOf(r: { content?: Array<{ type: string; text?: string }> }): string {
  return (r.content || []).map((c) => c.text || "").join("");
}

async function exec(tool: { execute?: (...args: any[]) => Promise<any> }, id: string, params: unknown): Promise<any> {
  if (!tool.execute) throw new Error("tool missing execute");
  return tool.execute(id, params);
}

const root = await mkdtemp(join(tmpdir(), "node4-cs-smoke-"));
const taskDir = join(root, "task1");
const messages: PlatformMessage[] = [];
const platform: PlatformSink = {
  async send(m) {
    messages.push(m);
  },
};

const task: TaskEnvelope = {
  taskId: "task1",
  conversationId: "c-cs",
  instruction: "cyberstrike adopted smoke",
  target: { value: "http://127.0.0.1:9" },
  scope: { allow: ["127.0.0.1"] },
  engagement: "pentest",
};

const goals = new GoalStore();
const runtime: ToolRuntime = {
  task,
  workspaceDir: root,
  taskDir,
  platform,
  todo: new TodoStore(),
  evidence: new EvidenceStore(join(taskDir, "evidence")),
  findingsDir: join(taskDir, "findings"),
  goals,
  processFacts: new ProcessFactStore(join(taskDir, "facts")),
  rolePackId: "pentest",
  lifecycle: { subagentDepth: 0, recentObservations: [] },
};
runtime.subagents = new SubagentHost({
  task,
  taskDir,
  evidence: runtime.evidence,
  platform,
  goals,
});

await runtime.processFacts!.ensureDir();
await import("node:fs/promises").then((fs) =>
  Promise.all([
    fs.mkdir(join(taskDir, "findings"), { recursive: true }),
    fs.mkdir(join(taskDir, "evidence"), { recursive: true }),
    fs.mkdir(join(taskDir, "subagents"), { recursive: true }),
    fs.mkdir(join(taskDir, "tool-output"), { recursive: true }),
  ]),
);

// --- A1: missing handoff ---
const subTool = createSubagentTool(runtime);
const miss = textOf(
  await exec(subTool, "m1", {
    assignment: "no structured fields",
    command: "echo should-not-run",
  }),
);
assert(miss.includes("handoff incomplete") || miss.includes("missing"), `missing handoff: ${miss.slice(0, 200)}`);
console.log("A1 missing-handoff: reject ok");

// --- A1 complete + D3 nest ---
const okSub = JSON.parse(
  textOf(
    await exec(subTool, "s1", {
      target: "http://127.0.0.1:9/",
      scope: "127.0.0.1 only",
      already_done: "none",
      this_turn_goal: "echo proof",
      success_criteria: "stdout contains child-ok",
      command: "echo child-ok",
      timeout_seconds: 30,
    }),
  ),
);
assert(okSub.ok && okSub.evidence_id, `complete handoff: ${JSON.stringify(okSub).slice(0, 300)}`);
console.log("A1 complete-handoff: ok", okSub.subagent_id);

runtime.lifecycle.subagentDepth = 1;
const nested = textOf(
  await exec(subTool, "n1", {
    target: "http://127.0.0.1:9/",
    scope: "x",
    already_done: "y",
    this_turn_goal: "z",
    success_criteria: "w",
    command: "echo no",
  }),
);
assert(nested.includes("nested subagent"), `nest ban: ${nested.slice(0, 200)}`);
runtime.lifecycle.subagentDepth = 0;
console.log("D3 nest-ban: ok");

// --- A2/A5 facts ---
const factTool = createFactTool(runtime);
const up = JSON.parse(
  textOf(
    await exec(factTool, "f1", {
      op: "upsert",
      fact_key: "target/lab",
      summary: "Lab root returns 200",
      body: "curl probe detail: status 200 body len 12",
    }),
  ),
);
assert(up.ok && up.fact_key === "target/lab", "fact upsert");
const listed = JSON.parse(textOf(await exec(factTool, "f2", { op: "list" })));
assert(listed.count === 1 && !JSON.stringify(listed.facts[0]).includes("body len 12"), "list index only");
const got = JSON.parse(textOf(await exec(factTool, "f3", { op: "get", fact_key: "target/lab" })));
assert(got.fact.body.includes("body len 12"), "get full body");
console.log("A2/A5 fact write-read: ok");

// finding remains separate (does not use fact store)
const finding = createFindingTool(runtime);
// soft check: tool exists and errors without full booking fields rather than writing assets
const badFind = textOf(await exec(finding, "find1", { action: "confirm", title: "x" }));
assert(
  badFind.toLowerCase().includes("error") ||
    badFind.includes("required") ||
    badFind.includes("location") ||
    badFind.includes("proof"),
  "finding still gated",
);
console.log("A2 finding separate: ok");

// --- C3 large shell ---
const shell = createShellTool(runtime);
// Generate large stdout without filling disk too hard
const largeCmd = `python3 -c "print('Z'*${MODEL_TOOL_OUTPUT_CHARS + 8000})"`;
const shellOut = JSON.parse(textOf(await exec(shell, "sh1", { command: largeCmd, timeout_seconds: 60 })));
assert(shellOut.output_truncated === true, `expected truncated: ${JSON.stringify(shellOut).slice(0, 400)}`);
assert(shellOut.output_archive, "archive path");
await access(join(taskDir, shellOut.output_archive));
const arch = await readFile(join(taskDir, shellOut.output_archive), "utf8");
assert(arch.includes("ZZZZ"), "archive readable full-ish content");
assert(String(shellOut.stdout).length < MODEL_TOOL_OUTPUT_CHARS + 2000, "model stdout bounded");
console.log("C3 shell governance: ok", shellOut.output_archive);

console.log("cyberstrike-adopted.smoke.ts: ALL OK");
await rm(root, { recursive: true, force: true });
