import { spawn } from "node:child_process";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ToolRuntime } from "../types.js";
import { emitEvidence, jsonResult, textResult } from "./common.js";

const DEFAULT_TIMEOUT_SEC = 180;
const MAX_TIMEOUT_SEC = 300;
const MIN_TIMEOUT_SEC = 1;
const STDOUT_CAP = 250_000;
const STDERR_CAP = 100_000;

/**
 * OMP-class shell density: one call should pack multi-step probes
 * (cookie jar → curl chain → python parse). Cwd is always the task workspace.
 * Timeout kills the whole process group so hung children cannot outlive the tool.
 */
export function createShellTool(runtime: ToolRuntime): ToolDefinition<any> {
  return {
    name: "shell",
    label: "Shell",
    description: [
      "Run bash in the task workspace. Prefer HIGH DENSITY: one command packing cookie jars, curl pipelines, python one-liners, and parsing — not one curl per call.",
      "Use scripts/ under the task dir for multi-step exploits; write then shell python scripts/x.py.",
      "Avoid endless single-request loops and unbounded brute force without a tight bound; prefer scripted targeted probes.",
      `timeout_seconds optional (default ${DEFAULT_TIMEOUT_SEC}, max ${MAX_TIMEOUT_SEC}); hung process groups are killed on tool timeout or session cancel.`,
    ].join(" "),
    parameters: Type.Object({
      command: Type.String(),
      timeout_seconds: Type.Optional(Type.Number()),
    }),
    async execute(_id: string, params: any, signal?: AbortSignal) {
      const command = String(params.command || "").trim();
      if (!command) return textResult("error: command required");
      const combined = combineSignals(signal, runtime.lifecycle.abortSignal);
      if (combined?.aborted) {
        return jsonResult(
          { ok: false, timedOut: false, aborted: true, exitCode: null, stdout: "", stderr: "aborted before start" },
          { isError: true },
        );
      }
      const timeoutSec = clampTimeoutSec(params.timeout_seconds);
      const timeoutMs = timeoutSec * 1000;
      const result = await runShell(command, runtime.taskDir, timeoutMs, combined);
      const evidenceId = await emitEvidence(runtime, "shell", `shell: ${command.slice(0, 120)}`, {
        command,
        timeout_seconds: timeoutSec,
        ...result,
      });
      return jsonResult({
        ok: result.exitCode === 0 && !result.timedOut && !result.aborted,
        evidence_id: evidenceId,
        timeout_seconds: timeoutSec,
        ...result,
      });
    },
  };
}

export function clampTimeoutSec(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_SEC;
  return Math.min(MAX_TIMEOUT_SEC, Math.max(MIN_TIMEOUT_SEC, Math.floor(n)));
}

/** Prefer AbortSignal.any when both tool + session-cancel signals exist (Node 20+). */
export function combineSignals(a?: AbortSignal, b?: AbortSignal): AbortSignal | undefined {
  if (a && b) {
    const anyFn = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
    if (typeof anyFn === "function") return anyFn([a, b]);
    // Fallback: proxy via new controller
    const c = new AbortController();
    const forward = () => {
      if (!c.signal.aborted) c.abort();
    };
    if (a.aborted || b.aborted) forward();
    else {
      a.addEventListener("abort", forward, { once: true });
      b.addEventListener("abort", forward, { once: true });
    }
    return c.signal;
  }
  return a || b;
}

export type ShellRunResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
};

/**
 * Spawn bash -lc in a new process group so timeout/abort can kill the tree.
 * Exported for smokes.
 */
export function runShell(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ShellRunResult> {
  return new Promise((resolvePromise) => {
    let settled = false;
    const settle = (value: ShellRunResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise(value);
    };

    // detached + new process group: kill(-pid) reaps children (python brute, curl, etc.)
    const child = spawn("/bin/bash", ["-lc", command], {
      cwd,
      env: { ...process.env, HOME: cwd },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;

    const killTree = (sig: NodeJS.Signals = "SIGKILL") => {
      if (child.pid == null) return;
      try {
        process.kill(-child.pid, sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          // already dead
        }
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree("SIGKILL");
    }, timeoutMs);

    const onAbort = () => {
      aborted = true;
      killTree("SIGKILL");
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };

    child.stdout?.on("data", (d) => {
      stdout += String(d);
      if (stdout.length > STDOUT_CAP) stdout = stdout.slice(-STDOUT_CAP);
    });
    child.stderr?.on("data", (d) => {
      stderr += String(d);
      if (stderr.length > STDERR_CAP) stderr = stderr.slice(-STDERR_CAP);
    });
    child.on("close", (code) => {
      settle({ exitCode: code, stdout, stderr, timedOut, aborted });
    });
    child.on("error", (err) => {
      settle({ exitCode: 127, stdout, stderr: err.message, timedOut, aborted });
    });
  });
}
