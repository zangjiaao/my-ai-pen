/**
 * Session workspace root for write/read/script (Spec #428 /workspace).
 * Run: npx tsx src/tools/fs-tools.workspace.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  normalizeWorkspaceRel,
  sessionWorkspaceRoot,
  toSandboxPath,
  createWriteTool,
} from "./fs-tools.js";
import type { TaskEnvelope, ToolRuntime } from "../types.js";

function ok(cond: unknown, msg: string): void {
  assert.ok(cond, msg);
}

{
  assert.equal(normalizeWorkspaceRel("scripts/sockprobe.py"), "scripts/sockprobe.py");
  assert.equal(normalizeWorkspaceRel("/workspace/scripts/sockprobe.py"), "scripts/sockprobe.py");
  assert.equal(toSandboxPath("scripts/sockprobe.py"), "/workspace/scripts/sockprobe.py");
  try {
    normalizeWorkspaceRel("scripts/../etc/passwd");
    assert.fail("expected escape blocked");
  } catch (e) {
    ok(String(e).includes("escape"), "rejects ..");
  }
}

{
  const root = mkdtempSync(join(tmpdir(), "ws-root-"));
  const expert = join(root, "case-c", "expert-e");
  const pi = join(expert, "pi-sid");
  const runtimeLike = { sessionDir: expert, taskDir: pi };
  assert.equal(sessionWorkspaceRoot(runtimeLike), expert);
  const stripped = normalizeWorkspaceRel(join(expert, "scripts", "x.py"), runtimeLike);
  assert.equal(stripped.replace(/\\/g, "/"), "scripts/x.py");
  rmSync(root, { recursive: true, force: true });
}

{
  const root = mkdtempSync(join(tmpdir(), "ws-write-"));
  const expert = join(root, "expert");
  const pi = join(expert, "pi-sid");
  const task: TaskEnvelope = {
    taskId: "t",
    conversationId: "c",
    instruction: "x",
    target: {},
    scope: {},
  };
  const runtime = {
    task,
    workspaceDir: root,
    taskDir: pi,
    sessionDir: expert,
    platform: { send: async () => undefined },
    todo: { snapshot: () => [] },
    evidence: { create: async () => ({ id: "e" }) },
    findingsDir: join(root, "findings"),
    goals: {},
    lifecycle: {},
  } as unknown as ToolRuntime;
  const write = createWriteTool(runtime);
  const result = await write.execute("1", { path: "scripts/sockprobe.py", content: "print(1)\n" });
  const text = result.content.find((c) => c.type === "text")?.text || "";
  const parsed = JSON.parse(text);
  assert.equal(parsed.path, "/workspace/scripts/sockprobe.py");
  assert.equal(parsed.relative_path, "scripts/sockprobe.py");
  const onDisk = readFileSync(join(expert, "scripts", "sockprobe.py"), "utf8");
  assert.equal(onDisk, "print(1)\n");
  try {
    readFileSync(join(pi, "scripts", "sockprobe.py"), "utf8");
    assert.fail("must not write under piDir");
  } catch {
    ok(true, "write lands in expertDir not piDir");
  }
  rmSync(root, { recursive: true, force: true });
}

console.log("fs-tools.workspace.test.ts: ok");
