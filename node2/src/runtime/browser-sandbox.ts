/**
 * Long-lived strix-sandbox session for agent-browser (Node3-aligned).
 * One container per task keeps Chromium state across browser tool actions.
 */
import { spawn } from "node:child_process";
import type { ToolRuntime } from "../types.js";

export type BrowserExecResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  unavailable?: boolean;
  error?: string;
};

type SessionRecord = {
  containerName: string;
  image: string;
  taskId: string;
  preferredOrigin: string;
  started: boolean;
  proxyUrl?: string;
};

const sessions = new Map<string, SessionRecord>();

export function preferredTargetOrigin(runtime: ToolRuntime): string {
  const raw = typeof runtime.task.target?.value === "string" ? runtime.task.target.value : "";
  try {
    const url = new URL(raw);
    return url.origin;
  } catch {
    return "http://127.0.0.1";
  }
}

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

export function rewriteUrlFromSandbox(value: string, preferredOrigin: string): string {
  if (!value || !/^https?:\/\//i.test(value)) return value;
  try {
    const url = new URL(value);
    if (url.hostname !== "host.docker.internal") return value;
    const preferred = new URL(preferredOrigin);
    url.protocol = preferred.protocol;
    url.hostname = preferred.hostname;
    url.port = preferred.port;
    return url.toString();
  } catch {
    return value;
  }
}

export function rewriteCookieDomainFromSandbox(domain: string, preferredOrigin: string): string {
  if (!domain) return domain;
  if (!/host\.docker\.internal/i.test(domain)) return domain;
  try {
    const host = new URL(preferredOrigin).hostname;
    if (domain.startsWith(".")) return `.${host}`;
    return host;
  } catch {
    return domain.replace(/host\.docker\.internal/gi, "127.0.0.1");
  }
}

function dockerCommandConfig(): { command: string; prefixArgv: string[] } {
  const command = process.env.NODE2_DOCKER_BIN?.trim() || "docker";
  const rawArgs = process.env.NODE2_DOCKER_BIN_ARGS?.trim();
  if (!rawArgs) return { command, prefixArgv: [] };
  try {
    const parsed = JSON.parse(rawArgs);
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
      return { command, prefixArgv: parsed };
    }
  } catch {
    // ignore
  }
  return { command, prefixArgv: [] };
}

function runProcess(command: string, argv: string[], timeoutMs: number): Promise<BrowserExecResult> {
  return new Promise((resolve) => {
    const child = spawn(command, argv, { shell: false, windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    let settled = false;
    const finish = (result: BrowserExecResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        finish({
          exitCode: null,
          stdout: "",
          stderr: "",
          unavailable: true,
          error: error.message,
        });
        return;
      }
      finish({
        exitCode: null,
        stdout: Buffer.concat(stdout).toString("utf8").slice(0, 256 * 1024),
        stderr: Buffer.concat(stderr).toString("utf8").slice(0, 64 * 1024),
        unavailable: true,
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

function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function containerNameFor(taskId: string): string {
  const safe = taskId.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 48);
  return `node2-browser-${safe}`;
}

export function isBrowserSandboxEnabled(runtime: ToolRuntime): boolean {
  // Align with scan/poc: browser uses strix-sandbox whenever scanner sandbox is enabled (default).
  return Boolean(runtime.scannerSandbox?.enabled);
}

export async function ensureBrowserSandbox(runtime: ToolRuntime): Promise<SessionRecord> {
  if (!isBrowserSandboxEnabled(runtime)) {
    throw new Error("Browser sandbox disabled; enable NODE2_SCANNER_SANDBOX_AUTO (default true) to use strix-sandbox agent-browser.");
  }
  const taskId = runtime.task.taskId;
  const existing = sessions.get(taskId);
  if (existing?.started) {
    // Refresh proxy binding if config changed mid-run (rare).
    existing.proxyUrl = runtime.trafficProxyUrl;
    return existing;
  }

  const image = runtime.scannerSandbox?.image || "ghcr.io/usestrix/strix-sandbox:1.0.0";
  const name = containerNameFor(taskId);
  const docker = dockerCommandConfig();

  // Drop any leftover container with the same name from a prior crash.
  await runProcess(docker.command, [...docker.prefixArgv, "rm", "-f", name], 30_000);

  const dockerArgs = [
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
    `AGENT_BROWSER_SESSION_NAME=node2-${taskId.slice(0, 32)}`,
  ];
  if (runtime.trafficProxyUrl) {
    const proxy = rewriteUrlForSandbox(runtime.trafficProxyUrl);
    dockerArgs.push(
      "-e",
      `HTTP_PROXY=${proxy}`,
      "-e",
      `HTTPS_PROXY=${proxy}`,
      "-e",
      `http_proxy=${proxy}`,
      "-e",
      `https_proxy=${proxy}`,
      "-e",
      `AGENT_BROWSER_PROXY=${proxy}`,
    );
  }
  dockerArgs.push("--entrypoint", "bash", image, "-lc", "sleep infinity");

  const started = await runProcess(docker.command, [...docker.prefixArgv, ...dockerArgs], 120_000);
  if (started.unavailable || started.exitCode !== 0) {
    throw new Error(
      `Failed to start browser sandbox container: ${started.error || started.stderr || started.stdout || `exit ${started.exitCode}`}`,
    );
  }

  const record: SessionRecord = {
    containerName: name,
    image,
    taskId,
    preferredOrigin: preferredTargetOrigin(runtime),
    started: true,
    proxyUrl: runtime.trafficProxyUrl,
  };
  sessions.set(taskId, record);
  return record;
}

export async function execInBrowserSandbox(
  runtime: ToolRuntime,
  argv: string[],
  timeoutMs = 120_000,
): Promise<BrowserExecResult> {
  const session = await ensureBrowserSandbox(runtime);
  const docker = dockerCommandConfig();
  const shellCmd = argv.map(shellQuote).join(" ");
  return runProcess(
    docker.command,
    [...docker.prefixArgv, "exec", session.containerName, "bash", "-lc", shellCmd],
    timeoutMs,
  );
}

export async function agentBrowser(
  runtime: ToolRuntime,
  args: string[],
  timeoutMs = 120_000,
): Promise<BrowserExecResult & { text: string }> {
  const result = await execInBrowserSandbox(runtime, ["agent-browser", ...args], timeoutMs);
  const text = `${result.stdout || ""}${result.stderr ? `\n${result.stderr}` : ""}`.trim();
  return { ...result, text };
}

export async function stopBrowserSandbox(taskId: string): Promise<void> {
  const session = sessions.get(taskId);
  if (!session) return;
  const docker = dockerCommandConfig();
  // Best-effort browser close then container remove.
  await runProcess(
    docker.command,
    [...docker.prefixArgv, "exec", session.containerName, "bash", "-lc", "agent-browser close --all >/dev/null 2>&1 || true"],
    30_000,
  );
  await runProcess(docker.command, [...docker.prefixArgv, "rm", "-f", session.containerName], 30_000);
  sessions.delete(taskId);
}

export function browserSandboxInfo(taskId: string): SessionRecord | undefined {
  return sessions.get(taskId);
}

export function parseAgentBrowserJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  // Prefer last JSON object in output (CLI may print status lines first).
  const lines = trimmed.split("\n").map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!;
    if (!(line.startsWith("{") || line.startsWith("["))) continue;
    try {
      return JSON.parse(line);
    } catch {
      // try full text next
    }
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}
