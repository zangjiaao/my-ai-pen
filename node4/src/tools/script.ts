import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ToolRuntime } from "../types.js";
import { emitEvidence, jsonResult, textResult } from "./common.js";

/**
 * Multi-step exploit path: write/read/run scripts under the task workspace.
 * Bounded timeout; production deployments should wrap with Docker isolation.
 */
export function createScriptTool(runtime: ToolRuntime): ToolDefinition<any> {
  return {
    name: "script",
    label: "Script",
    description:
      "Write/read/run Python or JS exploit scripts under the task scripts/ directory. Prefer this for multi-step chains instead of many one-off http calls.",
    parameters: Type.Object({
      action: Type.String(),
      filename: Type.Optional(Type.String()),
      content: Type.Optional(Type.String()),
      args: Type.Optional(Type.Array(Type.String())),
      timeout_seconds: Type.Optional(Type.Number()),
    }),
    async execute(_id: string, params: any) {
      const action = String(params.action || "").toLowerCase();
      const dir = join(runtime.taskDir, "scripts");
      await mkdir(dir, { recursive: true });
      if (action === "list") {
        const { readdir } = await import("node:fs/promises");
        return jsonResult({ files: await readdir(dir).catch(() => []) });
      }
      if (!params.filename) return textResult("error: filename required");
      const file = safePath(dir, String(params.filename));
      if (action === "write") {
        if (params.content == null) return textResult("error: content required");
        await writeFile(file, String(params.content), "utf8");
        return jsonResult({ ok: true, path: file });
      }
      if (action === "read") {
        return textResult(await readFile(file, "utf8"));
      }
      if (action === "run") {
        const ext = file.endsWith(".py") ? "python" : file.endsWith(".js") || file.endsWith(".mjs") ? "node" : "";
        if (!ext) return textResult("error: only .py, .js, .mjs supported");
        const timeoutMs = Math.min(Math.max(Number(params.timeout_seconds || 60) * 1000, 1000), 180_000);
        const result = await runProcess(ext === "python" ? "python3" : "node", [file, ...(params.args || []).map(String)], dir, timeoutMs);
        const evidenceId = await emitEvidence(runtime, "script", `script run ${params.filename}`, { file, ...result });
        return jsonResult({ ok: result.exitCode === 0, evidence_id: evidenceId, ...result });
      }
      return textResult("error: action must be write, read, run, or list");
    },
  };
}

function safePath(dir: string, filename: string): string {
  const base = resolve(dir);
  const target = resolve(dir, filename);
  if (!target.startsWith(base + "/") && target !== base) throw new Error("path escape blocked");
  if (filename.includes("..")) throw new Error("path escape blocked");
  return target;
}

function runProcess(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args, { cwd, env: process.env });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      stdout += String(d);
      if (stdout.length > 200_000) stdout = stdout.slice(-200_000);
    });
    child.stderr.on("data", (d) => {
      stderr += String(d);
      if (stderr.length > 100_000) stderr = stderr.slice(-100_000);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ exitCode: code, stdout, stderr, timedOut });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolvePromise({ exitCode: 127, stdout, stderr: `${stderr}\n${err.message}`, timedOut });
    });
  });
}
