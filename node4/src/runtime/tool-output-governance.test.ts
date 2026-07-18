/**
 * Large tool-output truncate + archive (C3).
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  archiveAndGovernToolOutput,
  MODEL_TOOL_OUTPUT_CHARS,
  truncateStreamsForModel,
} from "./tool-output-governance.js";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

const small = truncateStreamsForModel("hello", "err");
assert(!small.truncated && small.stdout === "hello", "small not truncated");

const bigOut = "A".repeat(MODEL_TOOL_OUTPUT_CHARS + 5000);
const cut = truncateStreamsForModel(bigOut, "");
assert(cut.truncated, "large truncated");
assert(cut.stdout.length < bigOut.length, "stdout shorter");
assert(cut.stdout.includes("omitted") || cut.stdout.includes("truncated"), "omit marker");

const root = await mkdtemp(join(tmpdir(), "node4-outgov-"));
try {
  const governed = await archiveAndGovernToolOutput({
    taskDir: root,
    tool: "shell",
    command: "yes | head -c 200000",
    stdout: bigOut,
    stderr: "warn-line\n",
  });
  assert(governed.truncated, "governed truncated");
  assert(governed.archived_path, "archive path set");
  assert(governed.stdout.length < bigOut.length, "model stdout bounded");
  assert(governed.archived_path!.startsWith("tool-output/"), "under tool-output/");
  const full = await readFile(join(root, governed.archived_path!), "utf8");
  assert(full.includes(bigOut.slice(0, 100)), "archive has full content start");
  assert(full.includes("--- stdout ---"), "archive structure");
  assert(governed.stdout.includes(governed.archived_path!), "model text points at archive");

  const tiny = await archiveAndGovernToolOutput({
    taskDir: root,
    tool: "shell",
    stdout: "ok",
    stderr: "",
  });
  assert(!tiny.truncated && !tiny.archived_path, "tiny not archived");

  console.log("tool-output-governance.test.ts: ok");
} finally {
  await rm(root, { recursive: true, force: true });
}
