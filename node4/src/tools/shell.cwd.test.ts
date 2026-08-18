/**
 * Shell cwd is the expert sandbox so scripts/ written by write() are visible.
 * Run: npx tsx src/tools/shell.cwd.test.ts
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveShellCwd, runShellOnHost } from "./shell.js";

assert.equal(
  resolveShellCwd({
    sessionDir: "/e",
    piDir: "/p",
    workspaceDir: "/w",
    task: { conversationId: "c", expertId: "e" } as any,
  }),
  "/e",
);
assert.equal(
  resolveShellCwd({
    piDir: "/p",
    workspaceDir: "/w",
    task: { conversationId: "", expertId: "" } as any,
  }),
  "/p",
);

const root = await mkdtemp(join(tmpdir(), "shcwd-"));
try {
  const expert = join(root, "expert");
  const pi = join(expert, "pi-x");
  await mkdir(join(expert, "scripts"), { recursive: true });
  await mkdir(pi, { recursive: true });
  await writeFile(join(expert, "scripts", "probe.py"), "print(1)\n");
  const cwd = resolveShellCwd({
    sessionDir: expert,
    piDir: pi,
    workspaceDir: root,
    task: { conversationId: "c", expertId: "e" } as any,
  });
  const hit = await runShellOnHost("test -f scripts/probe.py", cwd, 5_000);
  assert.equal(hit.exitCode, 0, "scripts visible from expert cwd");
  const miss = await runShellOnHost("test -f scripts/probe.py", pi, 5_000);
  assert.notEqual(miss.exitCode, 0, "scripts missing from pi cwd");
  console.log("shell.cwd.test.ts ok");
} finally {
  await rm(root, { recursive: true, force: true });
}
