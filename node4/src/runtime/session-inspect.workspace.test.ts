/**
 * Post-run inspect counts Case-level findings/evidence.
 * Run: npx tsx src/runtime/session-inspect.workspace.test.ts
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writePostRunInspectArtifacts } from "./session-inspect.js";

const root = await mkdtemp(join(tmpdir(), "inspect-ws-"));
try {
  const caseDir = join(root, "case-c1");
  const expert = join(caseDir, "expert-e1");
  const pi = join(expert, "pi-s1");
  await mkdir(join(caseDir, "findings"), { recursive: true });
  await mkdir(join(caseDir, "evidence"), { recursive: true });
  await mkdir(join(caseDir, "surfaces"), { recursive: true });
  await mkdir(join(expert, "scripts"), { recursive: true });
  await mkdir(pi, { recursive: true });
  await writeFile(join(caseDir, "findings", "f1.json"), "{}", "utf8");
  await writeFile(join(caseDir, "evidence", "e1.json"), "{}", "utf8");
  await writeFile(join(pi, "events.jsonl"), "{}\n", "utf8");
  await writeFile(join(pi, "agent-summary.json"), "{}", "utf8");

  const dump = await writePostRunInspectArtifacts({
    taskDir: pi,
    caseDir,
    sessionDir: expert,
    taskId: "task-1",
    terminalStatus: "completed",
    summary: "ok",
    messages: [{ role: "assistant", content: "hi" }],
    continueCount: 0,
    stopReason: "natural_stop",
    bookedFindingCount: 1,
  });

  const manifest = JSON.parse(await readFile(dump.manifestPath, "utf8")) as {
    findingFiles: number;
    evidenceFiles: number;
    artifacts: string[];
  };
  assert.equal(manifest.findingFiles, 1);
  assert.equal(manifest.evidenceFiles, 1);
  assert.ok(manifest.artifacts.includes("findings"));
  assert.ok(manifest.artifacts.includes("evidence"));
  assert.ok(manifest.artifacts.includes("surfaces"));
  assert.ok(manifest.artifacts.includes("scripts"));
  assert.ok(manifest.artifacts.includes("events.jsonl"));
  console.log("session-inspect.workspace.test.ts ok");
} finally {
  await rm(root, { recursive: true, force: true });
}
