import { spawn } from "node:child_process";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolRuntime } from "../types.js";
import { buildShellEnv } from "../runtime/pen-tools-path.js";
import { isShellInPenToolsEnabled, runShellInPenTools } from "../runtime/pen-tools-shell.js";
import { recordActObservation, jsonResult, textResult } from "./common.js";
import { archiveAndGovernToolOutput } from "../runtime/tool-output-governance.js";

const DEFAULT_TIMEOUT_SEC = 240;
const MAX_TIMEOUT_SEC = 600;
const MIN_TIMEOUT_SEC = 1;
/** Capture cap while streaming from the process (full archive if truncated for model). */
const STDOUT_CAP = 250_000;
const STDERR_CAP = 100_000;

/**
 * OMP-class shell density: primary act surface.
 * Multi-step probes in one call; independent probes as parallel tool calls same turn.
 * Timeout kills the whole process group so hung children cannot outlive the tool.
 */
export function createShellTool(runtime: ToolRuntime): AgentTool<any> {
  return {
    name: "shell",
    label: "Shell",
    description: [
      "PRIMARY act tool. Run bash in the task workspace.",
      "HIGH DENSITY: pack cookie jars, curl pipelines, python one-liners, and parsing in ONE command (chain with && when order matters).",
      "Independent probes: issue multiple shell tool calls in the SAME turn (they can run in parallel).",
      "Prefer shell over http for multi-step recon/exploit. Use scripts/ for longer exploits (write then shell python scripts/x.py).",
      "Scanners (nuclei/nmap/…) run in first-party pen-sandbox when Docker image is available (shell-in-container; else host PATH shims). Prefer narrow product tags for commercial stacks.",
      "Avoid one-request-per-call thrash and unbounded brute force; use bounded scripted probes.",
      `timeout_seconds optional (default ${DEFAULT_TIMEOUT_SEC}, max ${MAX_TIMEOUT_SEC}); process group / container killed on timeout or session cancel.`,
      "Large stdout/stderr is truncated for the model and archived under task tool-output/ for read re-fetch.",
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
      const governed = await archiveAndGovernToolOutput({
        taskDir: runtime.taskDir,
        tool: "shell",
        command,
        stdout: result.stdout,
        stderr: result.stderr,
      });
      const modelResult = {
        exitCode: result.exitCode,
        stdout: governed.stdout,
        stderr: governed.stderr,
        timedOut: result.timedOut,
        aborted: result.aborted,
        output_truncated: governed.truncated,
        output_archive: governed.archived_path || null,
        output_original_chars: governed.original_total_chars,
      };
      // Act only — Case evidence is created at finding(confirm) from agent proof.
      // Observations keep fuller streams (pre-model truncate) when still in capture cap.
      recordActObservation(runtime, "shell", shellEvidenceSummary(command, result), {
        command,
        timeout_seconds: timeoutSec,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        timedOut: result.timedOut,
        aborted: result.aborted,
        output_archive: governed.archived_path,
      });
      return jsonResult({
        ok: result.exitCode === 0 && !result.timedOut && !result.aborted,
        timeout_seconds: timeoutSec,
        ...modelResult,
      });
    },
  };
}

export function clampTimeoutSec(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_SEC;
  return Math.min(MAX_TIMEOUT_SEC, Math.max(MIN_TIMEOUT_SEC, Math.floor(n)));
}

/** Short, human-readable evidence title: exit + first useful stdout line (not script boilerplate). */
export function shellEvidenceSummary(
  command: string,
  result: { exitCode: number | null; stdout?: string; stderr?: string; timedOut?: boolean; aborted?: boolean },
): string {
  const exit =
    result.aborted ? "aborted" : result.timedOut ? "timeout" : `exit=${result.exitCode ?? "?"}`;
  const out = String(result.stdout || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("===") && l.length > 2);
  if (out) return `shell ${exit} | ${out.slice(0, 100)}`;
  const err = String(result.stderr || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean);
  if (err) return `shell ${exit} | stderr: ${err.slice(0, 80)}`;
  const cmdOne = command.replace(/\s+/g, " ").trim().slice(0, 80);
  return `shell ${exit} | ${cmdOne}`;
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
 * Spawn bash -lc. Prefer pen-tools container (S4) when image present; else host with PATH shims (S1).
 * Exported for smokes.
 */
export function runShell(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ShellRunResult> {
  if (isShellInPenToolsEnabled()) {
    return runShellInPenTools(command, cwd, timeoutMs, signal);
  }
  return runShellOnHost(command, cwd, timeoutMs, signal);
}

/** Host bash -lc with pen-tools bin on PATH (wrappers). */
export function runShellOnHost(
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
    // Prepend sandbox/pen-tools/bin so nuclei/nmap shims resolve without host apt install.
    const child = spawn("/bin/bash", ["-lc", command], {
      cwd,
      env: { ...buildShellEnv(process.env), HOME: cwd },
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
