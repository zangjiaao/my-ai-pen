import { spawn } from "node:child_process";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ToolRuntime } from "../types.js";
import { emitEvidence, jsonResult, textResult } from "./common.js";

/**
 * OMP-like shell density: run commands with cwd = taskDir.
 * Production deployments should wrap with Docker isolation.
 */
export function createShellTool(runtime: ToolRuntime): ToolDefinition<any> {
  return {
    name: "shell",
    label: "Shell",
    description:
      "Run a shell command in the task workspace (cookie files, curl pipelines, python one-liners). Prefer for high-density probing. Timeout-bounded.",
    parameters: Type.Object({
      command: Type.String(),
      timeout_seconds: Type.Optional(Type.Number()),
    }),
    async execute(_id: string, params: any) {
      const command = String(params.command || "").trim();
      if (!command) return textResult("error: command required");
      const timeoutMs = Math.min(Math.max(Number(params.timeout_seconds || 120) * 1000, 1000), 300_000);
      const result = await runShell(command, runtime.taskDir, timeoutMs);
      const evidenceId = await emitEvidence(runtime, "shell", `shell: ${command.slice(0, 120)}`, {
        command,
        ...result,
      });
      return jsonResult({
        ok: result.exitCode === 0 && !result.timedOut,
        evidence_id: evidenceId,
        ...result,
      });
    },
  };
}

function runShell(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolvePromise) => {
    const child = spawn("/bin/bash", ["-lc", command], {
      cwd,
      env: { ...process.env, HOME: cwd },
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      stdout += String(d);
      if (stdout.length > 250_000) stdout = stdout.slice(-250_000);
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
      resolvePromise({ exitCode: 127, stdout, stderr: err.message, timedOut });
    });
  });
}
