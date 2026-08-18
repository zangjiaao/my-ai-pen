import { spawn } from "node:child_process";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolRuntime } from "../types.js";
import { buildShellEnv } from "../runtime/pen-tools-path.js";
import {
  isShellInPenToolsEnabled,
  runShellInPenTools,
  type PenToolsShellOptions,
} from "../runtime/pen-tools-shell.js";
import { resolveBrowserSandboxSeat } from "../runtime/browser-sandbox-image.js";
import {
  ensureSessionWorkspace,
  resolveSessionWorkspaceDir,
} from "../runtime/session-workspace.js";
import { recordActObservation, jsonResult, textResult } from "./common.js";
import { archiveAndGovernToolOutput } from "../runtime/tool-output-governance.js";
import {
  assertDestructiveAllowed,
  resolveEngagementRoe,
} from "../runtime/engagement-roe.js";
import { emitShellHttpTraffic } from "../runtime/traffic-collect.js";

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
      "Run bash in the Session workspace (sticky pen-sandbox /workspace when available).",
      "Prefer http/session/browser for a single Web request so Traffic/Surface and proof bind to that exchange.",
      "Use shell for scanners, multi-step pipelines, and scripts/ exploits (write then `python3 scripts/x.py` from /workspace).",
      "HIGH DENSITY when you do use shell: pack cookie jars, curl pipelines, and parsing in ONE command (chain with && when order matters).",
      "Independent probes: issue multiple shell tool calls in the SAME turn (they can run in parallel).",
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
      // Spec #139 NC-RoE-Destructive: host gate (default deny) before execute
      const roe = resolveEngagementRoe({
        engagementTemplate: runtime.task.engagementTemplate || runtime.task.graphId,
        engagement: runtime.task.engagement || runtime.task.role,
        allowPostex: runtime.task.allowPostex,
        allowDestructive: runtime.task.allowDestructive,
      });
      const dest = assertDestructiveAllowed(roe, command);
      if (!dest.ok) {
        return textResult(`error: ${dest.error}`, { isError: true });
      }
      const combined = combineSignals(signal, runtime.lifecycle.abortSignal);
      if (combined?.aborted) {
        return jsonResult(
          { ok: false, timedOut: false, aborted: true, exitCode: null, stdout: "", stderr: "aborted before start" },
          { isError: true },
        );
      }
      const timeoutSec = clampTimeoutSec(params.timeout_seconds);
      const timeoutMs = timeoutSec * 1000;
      const startedMs = Date.now();
      const shellOpts = await resolveStickyShellOpts(runtime);
      const cwd = resolveShellCwd(runtime);
      const result = await runShell(command, cwd, timeoutMs, combined, shellOpts);
      const durationMs = Date.now() - startedMs;
      const governed = await archiveAndGovernToolOutput({
        piDir: runtime.piDir,
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
      // Spec #309 expansion: best-effort Traffic audit from curl/wget/httpie shell.
      // Prefer full capture streams (pre-model truncate). Never fail the tool on emit.
      await emitShellHttpTraffic(runtime, {
        command,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        aborted: result.aborted,
        durationMs,
      }).catch(() => {});
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
      // Field order matters: platform/node wire clips result_text (~4–12k).
      // Streams + exit first so long commands never starve stdout/stderr on the wire.
      // Full command still last for legacy recovery; Main row prefers args/content.command.
      return jsonResult({
        ok: result.exitCode === 0 && !result.timedOut && !result.aborted,
        exitCode: modelResult.exitCode,
        timedOut: modelResult.timedOut,
        aborted: modelResult.aborted,
        output_truncated: modelResult.output_truncated,
        output_archive: modelResult.output_archive,
        output_original_chars: modelResult.output_original_chars,
        stdout: modelResult.stdout,
        stderr: modelResult.stderr,
        timeout_seconds: timeoutSec,
        command,
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

/** Expert sandbox (`/workspace`, scripts/). Not the pi instance dir. */
export function resolveShellCwd(
  runtime: Pick<ToolRuntime, "sessionDir" | "piDir" | "workspaceDir" | "task">,
): string {
  const session = String(runtime.sessionDir || "").trim();
  if (session) return session;
  try {
    const conv = String(runtime.task?.conversationId || "").trim();
    const exp = String(runtime.task?.expertId || "").trim();
    const ws = String(runtime.workspaceDir || "").trim();
    if (conv && exp && ws) return resolveSessionWorkspaceDir(ws, conv, exp);
  } catch {
    /* fall through */
  }
  return runtime.piDir;
}

async function resolveStickyShellOpts(
  runtime: ToolRuntime,
): Promise<PenToolsShellOptions | undefined> {
  try {
    const seat = resolveBrowserSandboxSeat(runtime.task);
    const workspaceHostPath = resolveSessionWorkspaceDir(
      runtime.workspaceDir,
      seat.conversationId,
      seat.expertId,
    );
    await ensureSessionWorkspace(workspaceHostPath);
    return { seat, workspaceHostPath };
  } catch {
    return undefined;
  }
}

/**
 * Spawn bash -lc. Prefer sticky pen-sandbox exec (Spec #428); else ephemeral container; else host.
 * Exported for smokes.
 */
export function runShell(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
  opts?: PenToolsShellOptions,
): Promise<ShellRunResult> {
  if (isShellInPenToolsEnabled()) {
    return runShellInPenTools(command, cwd, timeoutMs, signal, opts);
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
