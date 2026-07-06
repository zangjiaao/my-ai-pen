import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { Node2Config } from "../config.js";
import { JsonTrafficSource } from "../traffic/external-source.js";
import type { ExternalTrafficSourceLike, PlatformSink, TaskEnvelope } from "../types.js";

const NODE2_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO_ROOT = resolve(NODE2_ROOT, "..");

export type CaidoBridgeHandle = {
  url: string;
  caidoUrl?: string;
  source: ExternalTrafficSourceLike;
  stop(): Promise<void>;
};

type CaidoSidecarHandle = {
  url: string;
  containerName: string;
  stop(): Promise<void>;
};

export async function startCaidoBridge(
  config: Node2Config,
  platform: PlatformSink,
  task: TaskEnvelope,
): Promise<CaidoBridgeHandle | undefined> {
  if (config.externalTrafficSourceUrl || !config.caidoBridgeAutoStart) return undefined;

  const sidecar = await startCaidoSidecar(config, platform, task);
  const port = config.caidoBridgePort || (await freePort(config.caidoBridgeHost));
  const url = `http://${config.caidoBridgeHost}:${port}`;
  const python = config.caidoBridgePython || defaultBridgePython();
  const args = [config.caidoBridgeScript, "--host", config.caidoBridgeHost, "--port", String(port)];
  const child = spawn(python, args, {
    cwd: resolve(dirname(config.caidoBridgeScript), ".."),
    env: {
      ...process.env,
      NODE2_CAIDO_BRIDGE_QUIET: "1",
      STRIX_CAIDO_URL: sidecar?.url || config.caidoUrl || process.env.STRIX_CAIDO_URL || "http://127.0.0.1:48080",
    },
  });

  let output = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });

  try {
    await waitForBridge(`${url}/status`, child, () => output);
    await platform.send({
      type: "traffic_bridge_started",
      conversation_id: task.conversationId,
      task_id: task.taskId,
      bridge: "caido",
      url,
      python,
    });
    return {
      url,
      caidoUrl: sidecar?.url,
      source: new JsonTrafficSource(url),
      stop: async () => {
        try {
          await stopBridge(child);
          await platform.send({
            type: "traffic_bridge_stopped",
            conversation_id: task.conversationId,
            task_id: task.taskId,
            bridge: "caido",
            url,
          });
        } finally {
          await sidecar?.stop();
        }
      },
    };
  } catch (error) {
    await stopBridge(child);
    await sidecar?.stop();
    throw error;
  }
}

async function startCaidoSidecar(
  config: Node2Config,
  platform: PlatformSink,
  task: TaskEnvelope,
): Promise<CaidoSidecarHandle | undefined> {
  if (!config.caidoSidecarAutoStart) return undefined;
  const port = config.caidoSidecarPort || (await freePort(config.caidoSidecarHost));
  const url = `http://${config.caidoSidecarHost}:${port}`;
  const containerName = `node2-caido-${safeName(task.taskId)}-${randomUUID().slice(0, 8)}`;
  const args = [
    "run",
    "--rm",
    "--detach",
    "--name",
    containerName,
    "--add-host",
    "host.docker.internal:host-gateway",
    "--cap-add",
    "NET_ADMIN",
    "--cap-add",
    "NET_RAW",
    "-p",
    `${config.caidoSidecarHost}:${port}:48080`,
    config.caidoSidecarImage,
    "tail",
    "-f",
    "/dev/null",
  ];
  const run = await execFile("docker", args, 120_000);
  if (run.code !== 0) {
    throw new Error(`failed to start Caido sidecar: ${run.stderr || run.stdout}`);
  }
  try {
    await waitForCaidoReady(url, containerName);
    await platform.send({
      type: "traffic_sidecar_started",
      conversation_id: task.conversationId,
      task_id: task.taskId,
      sidecar: "caido",
      url,
      image: config.caidoSidecarImage,
      container: containerName,
    });
    return {
      url,
      containerName,
      stop: async () => {
        await execFile("docker", ["rm", "-f", containerName], 30_000);
        await platform.send({
          type: "traffic_sidecar_stopped",
          conversation_id: task.conversationId,
          task_id: task.taskId,
          sidecar: "caido",
          url,
          container: containerName,
        });
      },
    };
  } catch (error) {
    await execFile("docker", ["rm", "-f", containerName], 30_000);
    throw error;
  }
}

export function defaultBridgePython(): string {
  if (process.env.PYTHON) return process.env.PYTHON;
  const windowsVenv = resolve(REPO_ROOT, "research", "strix", ".venv", "Scripts", "python.exe");
  if (existsSync(windowsVenv)) return windowsVenv;
  const posixVenv = resolve(REPO_ROOT, "research", "strix", ".venv", "bin", "python");
  if (existsSync(posixVenv)) return posixVenv;
  return "python";
}

async function waitForBridge(url: string, process: ChildProcessWithoutNullStreams, output: () => string): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 10_000) {
    if (process.exitCode !== null) throw new Error(`Caido bridge exited early: ${output()}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Retry until the bridge accepts connections.
    }
    await new Promise((resolveRetry) => setTimeout(resolveRetry, 100));
  }
  throw new Error(`Caido bridge did not start: ${output()}`);
}

async function waitForCaidoReady(url: string, containerName: string): Promise<void> {
  const started = Date.now();
  let lastError = "";
  while (Date.now() - started < 90_000) {
    const inspect = await execFile("docker", ["inspect", "-f", "{{.State.Running}}", containerName], 10_000);
    if (inspect.code !== 0 || !inspect.stdout.includes("true")) {
      const logs = await execFile("docker", ["logs", "--tail", "80", containerName], 10_000);
      throw new Error(`Caido sidecar exited before ready: ${logs.stderr || logs.stdout || inspect.stderr}`);
    }
    try {
      const response = await fetch(`${url}/health`);
      const payload = await response.json().catch(() => ({}));
      if (response.ok && (payload as any).ready === true) return;
      lastError = `status=${response.status} payload=${JSON.stringify(payload)}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolveRetry) => setTimeout(resolveRetry, 1_000));
  }
  const logs = await execFile("docker", ["logs", "--tail", "120", containerName], 10_000);
  throw new Error(`Caido sidecar did not become ready: ${lastError}\n${logs.stdout || logs.stderr}`);
}

async function stopBridge(process: ChildProcessWithoutNullStreams): Promise<void> {
  if (process.exitCode !== null) return;
  process.kill();
  await Promise.race([
    once(process, "exit"),
    new Promise((resolveTimeout) => setTimeout(resolveTimeout, 2_000)),
  ]);
}

function freePort(host: string): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    import("node:net")
      .then((net) => {
        const server = net.createServer();
        server.on("error", rejectPort);
        server.listen(0, host, () => {
          const address = server.address();
          if (!address || typeof address === "string") {
            server.close(() => rejectPort(new Error("failed to allocate a TCP port")));
            return;
          }
          const port = address.port;
          server.close(() => resolvePort(port));
        });
      })
      .catch(rejectPort);
  });
}

function safeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_.-]/g, "-").slice(0, 48) || "task";
}

function execFile(command: string, args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveExec) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      stderr += `\n${command} ${args.join(" ")} timed out after ${timeoutMs}ms`;
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveExec({ code: code ?? 0, stdout: stdout.trim(), stderr: stderr.trim() });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolveExec({ code: 1, stdout, stderr: `${stderr}\n${error.message}`.trim() });
    });
  });
}
