import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ToolRuntime } from "../types.js";
import { observeAttackSurface } from "../runtime/coverage-auditor.js";
import { emitToolEvidence, jsonResult, textResult } from "./common.js";

export function createPocTool(runtime: ToolRuntime): ToolDefinition<any> {
  return {
    name: "poc",
    label: "PoC",
    description: "Create, read, or run a bounded PoC script under the task workspace. Supports JavaScript and Python scripts only; no shell execution.",
    promptSnippet: "Create or run bounded PoC scripts",
    promptGuidelines: [
      "Use poc when existing tools cannot express the test, especially for batch replay, race checks, or custom protocol validation.",
      "Keep PoC scripts deterministic and scoped; report evidence_id from poc run before confirming findings.",
    ],
    parameters: Type.Object({
      action: Type.String(),
      filename: Type.String(),
      content: Type.Optional(Type.String()),
      args: Type.Optional(Type.Array(Type.String())),
      timeout_seconds: Type.Optional(Type.Number()),
    }),
    async execute(_toolCallId: string, params: any) {
      const dir = join(runtime.workspaceDir, runtime.task.taskId, "poc");
      await mkdir(dir, { recursive: true });
      const file = safePath(dir, params.filename);
      if (params.action === "write") {
        if (!params.content) return textResult("error: content is required");
        await writeFile(file, params.content, "utf8");
        return jsonResult({ ok: true, path: file });
      }
      if (params.action === "read") {
        return textResult(await readFile(file, "utf8"));
      }
      if (params.action === "run") {
        const ext = file.endsWith(".py") ? "python" : file.endsWith(".js") || file.endsWith(".mjs") ? "node" : "";
        if (!ext) throw new Error("only .py, .js, and .mjs PoC files can run");
        const result = await runProcess(ext, [file, ...(params.args || [])], Math.min((params.timeout_seconds || 60) * 1000, 180_000));
        const evidenceId = await emitToolEvidence(runtime, "poc", `PoC ${params.filename}`, { file, ...result });
        await observeAttackSurface(runtime, { responseBody: `${result.stdout}\n${result.stderr}`, evidenceIds: [evidenceId], source: "poc" });
        return jsonResult({ evidence_id: evidenceId, ...result }, { evidenceId });
      }
      return textResult("error: action must be write, read, or run");
    },
  };
}

function safePath(base: string, filename: string): string {
  const resolved = resolve(base, filename);
  if (!resolved.startsWith(resolve(base))) throw new Error("filename escapes PoC workspace");
  return resolved;
}

function runProcess(command: string, argv: string[], timeoutMs: number): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, argv, { shell: false, windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolveResult({
        exitCode,
        stdout: Buffer.concat(stdout).toString("utf8").slice(0, 128 * 1024),
        stderr: Buffer.concat(stderr).toString("utf8").slice(0, 32 * 1024),
      });
    });
  });
}
