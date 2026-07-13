/**
 * Browser sandbox for Node4 — Docker strix-sandbox (same class as Node2/Node3).
 * Prefer sandbox so Chromium deps live in the container, not on the host.
 *
 * Env:
 * - NODE4_BROWSER_SANDBOX=0|false → force host agent-browser only
 * - NODE4_BROWSER_SANDBOX_IMAGE (default ghcr.io/usestrix/strix-sandbox:1.0.0)
 * - NODE4_DOCKER_BIN (default docker)
 */

import { spawn } from "node:child_process";
import type { ToolRuntime } from "../types.js";
import { runAgentBrowser, type AgentBrowserResult } from "./agent-browser-cli.js";

export type SandboxExecResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  unavailable?: boolean;
  error?: string;
  via?: "sandbox" | "host";
};

type SessionRecord = {
  containerName: string;
  image: string;
  taskId: string;
  started: boolean;
};

const sessions = new Map<string, SessionRecord>();

function dockerBin(): string {
  return process.env.NODE4_DOCKER_BIN?.trim() || process.env.NODE2_DOCKER_BIN?.trim() || "docker";
}

function sandboxImage(): string {
  return (
    process.env.NODE4_BROWSER_SANDBOX_IMAGE?.trim() ||
    process.env.NODE2_SCANNER_SANDBOX_IMAGE?.trim() ||
    "ghcr.io/usestrix/strix-sandbox:1.0.0"
  );
}

export function isBrowserSandboxPreferred(): boolean {
  const raw = (process.env.NODE4_BROWSER_SANDBOX ?? "1").trim().toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "off" || raw === "host");
}

function containerNameFor(taskId: string): string {
  const safe = taskId.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 48);
  return `node4-browser-${safe}`;
}

function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function runProcess(command: string, argv: string[], timeoutMs: number): Promise<SandboxExecResult> {
  return new Promise((resolve) => {
    const child = spawn(command, argv, { shell: false });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    const finish = (result: SandboxExecResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    child.stdout?.on("data", (c: Buffer) => stdout.push(c));
    child.stderr?.on("data", (c: Buffer) => stderr.push(c));
    child.on("error", (error: NodeJS.ErrnoException) => {
      finish({
        exitCode: null,
        stdout: "",
        stderr: "",
        unavailable: error.code === "ENOENT",
        error: error.message,
      });
    });
    child.on("close", (exitCode) => {
      finish({
        exitCode,
        stdout: Buffer.concat(stdout).toString("utf8").slice(0, 256 * 1024),
        stderr: Buffer.concat(stderr).toString("utf8").slice(0, 64 * 1024),
      });
    });
  });
}

export async function ensureBrowserSandbox(taskId: string): Promise<SessionRecord> {
  const existing = sessions.get(taskId);
  if (existing?.started) return existing;

  const name = containerNameFor(taskId);
  const image = sandboxImage();
  const docker = dockerBin();

  await runProcess(docker, ["rm", "-f", name], 30_000);

  const started = await runProcess(
    docker,
    [
      "run",
      "-d",
      "--name",
      name,
      "--add-host",
      "host.docker.internal:host-gateway",
      "--cap-add",
      "NET_ADMIN",
      "--cap-add",
      "NET_RAW",
      "-e",
      "NO_PROXY=localhost,127.0.0.1,host.docker.internal",
      "-e",
      "no_proxy=localhost,127.0.0.1,host.docker.internal",
      "-e",
      `AGENT_BROWSER_SESSION=node4-${taskId.slice(0, 32)}`,
      "--entrypoint",
      "bash",
      image,
      "-lc",
      "sleep infinity",
    ],
    120_000,
  );

  if (started.unavailable || started.exitCode !== 0) {
    throw new Error(
      `Failed to start browser sandbox: ${started.error || started.stderr || started.stdout || `exit ${started.exitCode}`}`,
    );
  }

  const record: SessionRecord = { containerName: name, image, taskId, started: true };
  sessions.set(taskId, record);
  return record;
}

export async function execInBrowserSandbox(
  taskId: string,
  argv: string[],
  timeoutMs = 120_000,
): Promise<SandboxExecResult> {
  const session = await ensureBrowserSandbox(taskId);
  const docker = dockerBin();
  const shellCmd = argv.map(shellQuote).join(" ");
  const result = await runProcess(
    docker,
    ["exec", session.containerName, "bash", "-lc", shellCmd],
    timeoutMs,
  );
  return { ...result, via: "sandbox" };
}

export async function stopBrowserSandbox(taskId: string): Promise<void> {
  const session = sessions.get(taskId);
  if (!session) return;
  const docker = dockerBin();
  await runProcess(
    docker,
    ["exec", session.containerName, "bash", "-lc", "agent-browser close --all >/dev/null 2>&1 || true"],
    30_000,
  );
  await runProcess(docker, ["rm", "-f", session.containerName], 30_000);
  sessions.delete(taskId);
}

/**
 * Run agent-browser: sandbox first (default), host fallback when sandbox disabled or fails to start.
 */
export async function runBrowserCommand(
  runtime: ToolRuntime,
  args: string[],
  timeoutMs = 120_000,
): Promise<SandboxExecResult & { text: string }> {
  const preferSandbox = isBrowserSandboxPreferred();

  if (preferSandbox) {
    try {
      const result = await execInBrowserSandbox(runtime.task.taskId, ["agent-browser", ...args], timeoutMs);
      const text = `${result.stdout || ""}${result.stderr ? `\n${result.stderr}` : ""}`.trim();
      // If docker exec fails because binary missing, surface clearly
      if (result.unavailable) {
        throw new Error(result.error || "docker unavailable");
      }
      return { ...result, text, via: "sandbox" };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Fall through to host only if sandbox cannot start
      const host = await runAgentBrowser(args, {
        taskId: runtime.task.taskId,
        taskDir: runtime.taskDir,
        timeoutMs,
      });
      const text = `${host.stdout || ""}${host.stderr ? `\n${host.stderr}` : ""}${host.error ? `\n${host.error}` : ""}`.trim();
      return {
        exitCode: host.exitCode,
        stdout: host.stdout,
        stderr: host.stderr,
        unavailable: host.unavailable,
        error: host.error
          ? `sandbox failed (${msg.slice(0, 200)}); host fallback: ${host.error}`
          : `sandbox failed (${msg.slice(0, 200)}); used host agent-browser`,
        text,
        via: "host",
      };
    }
  }

  const host = await runAgentBrowser(args, {
    taskId: runtime.task.taskId,
    taskDir: runtime.taskDir,
    timeoutMs,
  });
  const text = `${host.stdout || ""}${host.stderr ? `\n${host.stderr}` : ""}`.trim();
  return {
    exitCode: host.exitCode,
    stdout: host.stdout,
    stderr: host.stderr,
    unavailable: host.unavailable,
    error: host.error,
    text,
    via: "host",
  };
}

/** Rewrite localhost targets so container can reach host services. */
export function rewriteUrlForSandbox(value: string): string {
  if (!/^https?:\/\//i.test(value)) return value;
  try {
    const url = new URL(value);
    if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname)) return value;
    url.hostname = "host.docker.internal";
    return url.toString();
  } catch {
    return value;
  }
}
