/**
 * Thin wrapper around host `agent-browser` CLI (OMP-style assist: give the agent eyes).
 * No Docker sandbox dependency — uses PATH agent-browser + local Chromium install.
 */

import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

export type AgentBrowserResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  unavailable?: boolean;
  error?: string;
};

/** Prefer a real Node next to us so Windows/npm agent-browser shims can exec. */
function pathWithNode(): string {
  const nodeDir = dirname(process.execPath);
  const extra = [
    nodeDir,
    "/tmp/node-v22.14.0-linux-x64/bin",
    process.env.PATH || "",
  ].filter(Boolean);
  return extra.join(":");
}

export function resolveAgentBrowserBin(): string {
  return process.env.NODE4_AGENT_BROWSER_BIN || process.env.AGENT_BROWSER_BIN || "agent-browser";
}

/**
 * Run agent-browser with per-task session isolation.
 */
export function runAgentBrowser(
  args: string[],
  options: {
    taskId: string;
    taskDir: string;
    timeoutMs?: number;
    env?: Record<string, string>;
  },
): Promise<AgentBrowserResult> {
  const bin = resolveAgentBrowserBin();
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 60_000, 5_000), 180_000);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: pathWithNode(),
    AGENT_BROWSER_SESSION: process.env.AGENT_BROWSER_SESSION || `n4-${options.taskId}`,
    AGENT_BROWSER_SCREENSHOT_DIR:
      process.env.AGENT_BROWSER_SCREENSHOT_DIR || `${options.taskDir}/browser`,
    ...options.env,
  };

  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      env,
      cwd: options.taskDir,
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: AgentBrowserResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      finish({
        exitCode: null,
        stdout: stdout.slice(0, 50_000),
        stderr: stderr.slice(0, 20_000),
        error: `agent-browser timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);

    child.stdout?.on("data", (d) => {
      stdout += String(d);
      if (stdout.length > 200_000) stdout = stdout.slice(-150_000);
    });
    child.stderr?.on("data", (d) => {
      stderr += String(d);
      if (stderr.length > 80_000) stderr = stderr.slice(-60_000);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      const msg = err instanceof Error ? err.message : String(err);
      const unavailable = /ENOENT|not found/i.test(msg);
      finish({
        exitCode: null,
        stdout,
        stderr,
        unavailable,
        error: unavailable
          ? `agent-browser not found (${bin}). Install: npm i -g agent-browser && agent-browser install`
          : msg,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish({
        exitCode: code,
        stdout: stdout.slice(0, 50_000),
        stderr: stderr.slice(0, 20_000),
      });
    });
  });
}

/** Best-effort parse of `cookies get --json` output into name→value map. */
export function parseCookiesJson(text: string): Record<string, string> {
  const jar: Record<string, string> = {};
  const trimmed = text.trim();
  if (!trimmed) return jar;
  try {
    const data = JSON.parse(trimmed) as unknown;
    const list = Array.isArray(data)
      ? data
      : data && typeof data === "object" && Array.isArray((data as { cookies?: unknown }).cookies)
        ? ((data as { cookies: unknown[] }).cookies as unknown[])
        : null;
    if (list) {
      for (const row of list) {
        if (!row || typeof row !== "object") continue;
        const r = row as Record<string, unknown>;
        const name = String(r.name || r.key || "").trim();
        const value = r.value != null ? String(r.value) : "";
        if (name) jar[name] = value;
      }
      return jar;
    }
  } catch {
    // fall through: Cookie: a=b; c=d
  }
  for (const part of trimmed.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name) jar[name] = value;
  }
  return jar;
}

// silence unused import if fileURLPath not needed
void fileURLToPath;
