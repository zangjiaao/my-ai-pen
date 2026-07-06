import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { ToolRuntime } from "../types.js";

export type SandboxHttpInput = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs?: number;
};

export type SandboxHttpResponse = {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  execution: {
    runner: "docker";
    tool: "curl";
    image?: string;
    argv: string[];
    targetRewrite?: Record<string, string>;
  };
};

type ProcessResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  unavailable?: boolean;
  errorCode?: string;
  error?: string;
};

const MAX_BODY_CHARS = 256 * 1024;

export async function sendSandboxHttp(runtime: ToolRuntime, input: SandboxHttpInput): Promise<SandboxHttpResponse> {
  if (!runtime.scannerSandbox?.enabled) {
    throw new Error("Node2 HTTP execution is sandbox-only; enable NODE2_SCANNER_SANDBOX_AUTO and configure the sandbox image.");
  }
  const invocation = dockerInvocation(runtime, input);
  const docker = dockerCommandConfig();
  const result = await runProcess(
    docker.command,
    [...docker.prefixArgv, ...invocation.argv],
    input.body || "",
    Math.max(input.timeoutMs || 60_000, 120_000),
  );
  if (result.unavailable) {
    throw new Error(`HTTP sandbox unavailable: ${result.error || result.errorCode || "docker runner failed to start"}`);
  }
  if (result.exitCode !== 0) {
    throw new Error(`HTTP sandbox curl failed: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`);
  }
  const parsed = parseCurlResponse(result.stdout, invocation.marker);
  return {
    ...parsed,
    body: parsed.body.slice(0, MAX_BODY_CHARS),
    execution: {
      runner: "docker",
      tool: "curl",
      image: runtime.scannerSandbox.image,
      argv: invocation.commandArgv,
      targetRewrite: invocation.targetRewrite,
    },
  };
}

function dockerInvocation(
  runtime: ToolRuntime,
  input: SandboxHttpInput,
): { argv: string[]; commandArgv: string[]; marker: string; targetRewrite?: Record<string, string> } {
  const rewrittenUrl = rewriteLocalhostUrl(input.url);
  const marker = `__NODE2_CURL_META_${randomUUID().replace(/-/g, "")}__`;
  const timeoutSeconds = String(Math.max(1, Math.ceil((input.timeoutMs || 60_000) / 1000)));
  const commandArgv = [
    "-i",
    "-sS",
    "-k",
    "--max-time",
    timeoutSeconds,
    "--connect-timeout",
    "20",
    "-X",
    input.method.toUpperCase(),
    "--write-out",
    `\n${marker}%{http_code}`,
  ];
  const headers = { "user-agent": "my-ai-pen-node2/0.1", ...(input.headers || {}) };
  for (const [key, value] of Object.entries(headers)) {
    commandArgv.push("-H", `${key}: ${value}`);
  }
  if (input.body !== undefined) commandArgv.push("--data-binary", "@-");
  commandArgv.push(rewrittenUrl);

  const dockerArgs = [
    "run",
    "--rm",
    "--add-host",
    "host.docker.internal:host-gateway",
    "--cap-add",
    "NET_ADMIN",
    "--cap-add",
    "NET_RAW",
    "-i",
    "-e",
    "NO_PROXY=localhost,127.0.0.1",
    "-e",
    "no_proxy=localhost,127.0.0.1",
  ];
  if (runtime.trafficProxyUrl) {
    const proxy = rewriteLocalhostUrl(runtime.trafficProxyUrl);
    dockerArgs.push("-e", `HTTP_PROXY=${proxy}`);
    dockerArgs.push("-e", `HTTPS_PROXY=${proxy}`);
    dockerArgs.push("-e", `http_proxy=${proxy}`);
    dockerArgs.push("-e", `https_proxy=${proxy}`);
  }
  dockerArgs.push("--entrypoint", "curl");
  dockerArgs.push(runtime.scannerSandbox?.image || "ghcr.io/usestrix/strix-sandbox:1.0.0", ...commandArgv);
  return {
    argv: dockerArgs,
    commandArgv: ["curl", ...commandArgv],
    marker,
    targetRewrite: rewrittenUrl === input.url ? undefined : { [input.url]: rewrittenUrl },
  };
}

function parseCurlResponse(stdout: string, marker: string): Omit<SandboxHttpResponse, "execution"> {
  const markerIndex = stdout.lastIndexOf(marker);
  if (markerIndex < 0) throw new Error(`curl response missing marker ${marker}`);
  const raw = stdout.slice(0, markerIndex).replace(/\r?\n$/, "");
  const status = Number(stdout.slice(markerIndex + marker.length).trim()) || 0;
  const blocks = splitHeaderBlocks(raw);
  const final = blocks[blocks.length - 1] || { statusText: "", headers: {}, body: raw };
  return {
    status,
    statusText: final.statusText,
    headers: final.headers,
    body: final.body,
  };
}

function splitHeaderBlocks(raw: string): Array<{ statusText: string; headers: Record<string, string>; body: string }> {
  const normalized = raw.replace(/\r\n/g, "\n");
  const parts = normalized.split(/\n\n/);
  const blocks: Array<{ statusText: string; headers: Record<string, string>; body: string }> = [];
  let index = 0;
  while (index < parts.length) {
    const head = parts[index];
    if (!/^HTTP\/\d(?:\.\d)?\s+\d+/i.test(head || "")) {
      index += 1;
      continue;
    }
    const lines = head.split("\n");
    const statusText = lines[0]?.replace(/^HTTP\/\d(?:\.\d)?\s+\d+\s*/i, "") || "";
    const headers: Record<string, string> = {};
    for (const line of lines.slice(1)) {
      const colon = line.indexOf(":");
      if (colon <= 0) continue;
      const key = line.slice(0, colon).trim().toLowerCase();
      const value = line.slice(colon + 1).trim();
      headers[key] = headers[key] ? `${headers[key]}, ${value}` : value;
    }
    const bodyParts = parts.slice(index + 1);
    blocks.push({ statusText, headers, body: bodyParts.join("\n\n") });
    index += 1;
  }
  return blocks;
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
    // Fall through to no prefix args.
  }
  return { command, prefixArgv: [] };
}

function rewriteLocalhostUrl(value: string): string {
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

function runProcess(command: string, argv: string[], stdin: string, timeoutMs: number): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argv, { shell: false, windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    let settled = false;
    const finish = (result: ProcessResult) => {
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
          errorCode: error.code,
          error: error.message,
        });
        return;
      }
      reject(error);
    });
    child.on("close", (exitCode) => {
      finish({
        exitCode,
        stdout: Buffer.concat(stdout).toString("utf8").slice(0, 512 * 1024),
        stderr: Buffer.concat(stderr).toString("utf8").slice(0, 64 * 1024),
      });
    });
    child.stdin.on("error", () => {
      // The process may fail before reading stdin; stderr/exit code carries the failure.
    });
    child.stdin.end(stdin);
  });
}
