/**
 * Spec #528 — Worker may finding(list|get) the Case blackboard; cannot confirm/upsert.
 * Run: npx tsx src/tools/finding-worker-read.test.ts
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolRuntime } from "../types.js";
import { EvidenceStore } from "../stores/evidence.js";
import { GoalStore } from "../stores/goal.js";
import { TodoStore } from "../stores/todo.js";
import { FindingStore } from "../runtime/finding-store.js";
import { createProcessQualityState } from "../runtime/package-honesty-host.js";
import { SUBAGENT_CHILD_TOOL_NAMES } from "../runtime/subagent-session.js";
import { createFindingTool } from "./finding.js";

function textOf(result: { content?: Array<{ type?: string; text?: string }> }): string {
  return (result.content || []).map((c) => c.text || "").join(" ");
}

function parseJson(text: string): Record<string, unknown> {
  return JSON.parse(text.trim()) as Record<string, unknown>;
}

assert.ok(SUBAGENT_CHILD_TOOL_NAMES.includes("finding"));
assert.ok(SUBAGENT_CHILD_TOOL_NAMES.includes("platform_list_intel"));
assert.ok(SUBAGENT_CHILD_TOOL_NAMES.includes("platform_get_intel"));
assert.ok(!(SUBAGENT_CHILD_TOOL_NAMES as readonly string[]).includes("platform_record_intel"));
assert.ok(!(SUBAGENT_CHILD_TOOL_NAMES as readonly string[]).includes("platform_forget_intel"));
assert.ok(!(SUBAGENT_CHILD_TOOL_NAMES as readonly string[]).includes("subagent"));
assert.ok(
  !(SUBAGENT_CHILD_TOOL_NAMES as readonly string[]).includes("workset"),
  "Workers must not park Workset (Main only)",
);

const dir = await mkdtemp(join(tmpdir(), "finding-worker-read-"));
const store = new FindingStore();
const { id: bookedId } = store.upsert({
  title: "reflected xss",
  location: "http://t/login",
  severity: "high",
  proof_excerpt: "script reflected in response body enough-chars-here",
});
store.markBooked(bookedId, "local-1");

const pq = createProcessQualityState();
pq.findingStore = store;
const runtime: ToolRuntime = {
  task: {
    taskId: "t-w",
    conversationId: "c-w",
    instruction: "worker read",
    target: { type: "url", value: "http://t/login" },
    scope: { allow: ["t"] },
  },
  workspaceDir: dir,
  piDir: dir,
  platform: { send: async () => {} },
  todo: new TodoStore(),
  evidence: new EvidenceStore(join(dir, "evidence")),
  findingsDir: join(dir, "findings"),
  goals: new GoalStore(),
  lifecycle: { subagentDepth: 1, processQuality: pq },
};

const tool = createFindingTool(runtime);
const listed = await tool.execute("1", { action: "list" });
const listedJson = parseJson(textOf(listed));
assert.ok(Array.isArray(listedJson.findings));
assert.equal((listedJson.findings as unknown[]).length, 1);

const id = String((listedJson.findings as Array<{ id: string }>)[0]!.id);
const got = await tool.execute("2", { action: "get", finding_id: id });
assert.match(textOf(got), /reflected xss/);

const confirm = await tool.execute("3", { action: "confirm", title: "x" });
assert.match(textOf(confirm), /subagent must not finding\(confirm\)/);

const upsert = await tool.execute("4", { action: "upsert", title: "x", location: "http://t/x" });
assert.match(textOf(upsert), /subagent must not finding\(upsert\)/);

await rm(dir, { recursive: true, force: true });

{
  const fileDir = await mkdtemp(join(tmpdir(), "finding-worker-file-"));
  const emptyPq = createProcessQualityState();
  const fileRuntime: ToolRuntime = {
    ...runtime,
    workspaceDir: fileDir,
    piDir: fileDir,
    findingsDir: join(fileDir, "findings"),
    evidence: new EvidenceStore(join(fileDir, "evidence")),
    lifecycle: { subagentDepth: 1, processQuality: emptyPq },
  };
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(fileRuntime.findingsDir, { recursive: true });
  await writeFile(
    join(fileRuntime.findingsDir, "f_disk.json"),
    JSON.stringify({
      id: "f_disk",
      action: "confirm",
      title: "open register role admin",
      location: "http://t/api/Users",
    }),
  );
  const fileTool = createFindingTool(fileRuntime);
  const listedFiles = parseJson(textOf(await fileTool.execute("f1", { action: "list" })));
  assert.equal((listedFiles.findings as unknown[]).length, 1);
  assert.equal((listedFiles.findings as Array<{ id: string }>)[0]!.id, "f_disk");
  const gotFile = textOf(await fileTool.execute("f2", { action: "get", finding_id: "f_disk" }));
  assert.match(gotFile, /open register role admin/);
  await rm(fileDir, { recursive: true, force: true });
}

console.log("finding-worker-read.test.ts: ok");
