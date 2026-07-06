import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ToolRuntime } from "../types.js";
import { observeAttackSurface } from "../runtime/coverage-auditor.js";
import { emitToolEvidence, jsonResult, textResult } from "./common.js";

export function createPocTool(runtime: ToolRuntime): ToolDefinition<any> {
  return {
    name: "poc",
    label: "PoC",
    description: "Use the Node2 vulnerability PoC catalog, or create/read/run a bounded PoC script under the task workspace. Run is sandbox-only and supports JavaScript and Python scripts.",
    promptSnippet: "Look up PoC catalog entries or run bounded PoC scripts",
    promptGuidelines: [
      "Use poc(action='catalog') or poc(action='get') before custom verification when you need payload families, evidence gates, or reproduction guidance for a vulnerability class.",
      "Use poc when existing tools cannot express the test, especially for batch replay, race checks, or custom protocol validation.",
      "PoC scripts run only inside the configured Strix-style sandbox; host Python/Node binaries are not used.",
      "Keep PoC scripts deterministic and scoped; report evidence_id from poc run before confirming findings.",
    ],
    parameters: Type.Object({
      action: Type.String(),
      filename: Type.Optional(Type.String()),
      content: Type.Optional(Type.String()),
      args: Type.Optional(Type.Array(Type.String())),
      timeout_seconds: Type.Optional(Type.Number()),
      id: Type.Optional(Type.String()),
      vuln_class: Type.Optional(Type.String()),
      query: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Number()),
    }),
    async execute(_toolCallId: string, params: any) {
      if (params.action === "catalog" || params.action === "list") {
        return jsonResult(filterCatalog(await loadCatalog(runtime.pocCatalogPath), params));
      }
      if (params.action === "get") {
        const id = stringValue(params.id || params.vuln_class || params.query);
        if (!id) return textResult("error: get requires id, vuln_class, or query");
        const catalog = await loadCatalog(runtime.pocCatalogPath);
        const entry = catalog.entries.find((item) => sameId(item, id));
        return entry ? jsonResult(entry) : textResult(`error: no PoC catalog entry matched ${id}`);
      }
      if (!params.filename) return textResult("error: filename is required for write, read, and run");
      const dir = join(runtime.workspaceDir, runtime.task.taskId, "poc");
      await mkdir(dir, { recursive: true });
      const file = safePath(dir, params.filename);
      if (params.action === "write") {
        if (!params.content) return textResult("error: content is required");
        await writeFile(file, params.content, "utf8");
        return jsonResult({ ok: true, path: file });
      }
      if (params.action === "read") {
        return textResult(await readFile(file, "utf8"));
      }
      if (params.action === "run") {
        const ext = file.endsWith(".py") ? "python" : file.endsWith(".js") || file.endsWith(".mjs") ? "node" : "";
        if (!ext) throw new Error("only .py, .js, and .mjs PoC files can run");
        const execution = await runSandboxedPoc(runtime, dir, file, ext, params.args || [], Math.min((params.timeout_seconds || 60) * 1000, 180_000));
        const result = execution.result;
        if (result.unavailable) {
          throw new Error(`PoC sandbox unavailable: ${result.error || result.errorCode || "docker runner failed to start"}`);
        }
        const evidenceId = await emitToolEvidence(runtime, "poc", `PoC ${params.filename}`, { file, execution, ...result });
        await observeAttackSurface(runtime, { responseBody: `${result.stdout}\n${result.stderr}`, evidenceIds: [evidenceId], source: "poc" });
        return jsonResult({ evidence_id: evidenceId, execution, ...result }, { evidenceId });
      }
      return textResult("error: action must be write, read, or run");
    },
  };
}

type PocCatalog = {
  schema?: string;
  entries: PocCatalogEntry[];
};

type PocCatalogEntry = {
  id: string;
  vulnClass: string;
  title: string;
  aliases?: string[];
  severityHint?: string;
  applicability?: string[];
  payloadFamilies?: string[];
  evidenceGates?: string[];
  safeVerification?: string[];
  remediation?: string[];
  toolHints?: string[];
};

async function loadCatalog(path: string): Promise<PocCatalog> {
  const raw = JSON.parse(await readFile(path, "utf8")) as PocCatalog;
  return { schema: raw.schema, entries: Array.isArray(raw.entries) ? raw.entries : [] };
}

function filterCatalog(catalog: PocCatalog, params: any): PocCatalog {
  const query = stringValue(params.query || params.vuln_class || params.id);
  const limit = Math.max(1, Math.min(Number(params.limit || 20), 100));
  const entries = query
    ? catalog.entries.filter((entry) => sameId(entry, query) || haystack(entry).includes(query.toLowerCase()))
    : catalog.entries;
  return { schema: catalog.schema, entries: entries.slice(0, limit) };
}

function sameId(entry: PocCatalogEntry, query: string): boolean {
  const normalized = query.toLowerCase();
  return entry.id.toLowerCase() === normalized ||
    entry.vulnClass.toLowerCase() === normalized ||
    (entry.aliases || []).some((alias) => alias.toLowerCase() === normalized);
}

function haystack(entry: PocCatalogEntry): string {
  return [
    entry.id,
    entry.vulnClass,
    entry.title,
    ...(entry.aliases || []),
    ...(entry.applicability || []),
    ...(entry.payloadFamilies || []),
    ...(entry.evidenceGates || []),
  ].join("\n").toLowerCase();
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function safePath(base: string, filename: string): string {
  const resolved = resolve(base, filename);
  if (!resolved.startsWith(resolve(base))) throw new Error("filename escapes PoC workspace");
  return resolved;
}

type PocProcessResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  unavailable?: boolean;
  errorCode?: string;
  error?: string;
};

type PocExecution = {
  runner: "docker";
  command: string;
  argv: string[];
  result: PocProcessResult;
  image?: string;
  targetRewrite?: Record<string, string>;
};

async function runSandboxedPoc(
  runtime: ToolRuntime,
  hostDir: string,
  hostFile: string,
  interpreter: "python" | "node",
  args: string[],
  timeoutMs: number,
): Promise<PocExecution> {
  if (!runtime.scannerSandbox?.enabled) {
    throw new Error("Node2 PoC run is sandbox-only; enable NODE2_SCANNER_SANDBOX_AUTO and configure the sandbox image.");
  }
  const docker = pocDockerInvocation(runtime, hostDir, hostFile, interpreter, args);
  const dockerCommand = dockerCommandConfig();
  const result = await runProcess(dockerCommand.command, [...dockerCommand.prefixArgv, ...docker.argv], Math.max(timeoutMs, 120_000));
  return {
    runner: "docker",
    command: interpreter,
    argv: docker.commandArgv,
    result,
    image: runtime.scannerSandbox.image,
    targetRewrite: docker.targetRewrite,
  };
}

function pocDockerInvocation(
  runtime: ToolRuntime,
  hostDir: string,
  hostFile: string,
  interpreter: "python" | "node",
  args: string[],
): { argv: string[]; commandArgv: string[]; targetRewrite?: Record<string, string> } {
  const relativeFile = relative(hostDir, hostFile).replace(/\\/g, "/");
  if (relativeFile.startsWith("../") || relativeFile === "..") throw new Error("PoC file escapes workspace");
  const rewritten = rewriteLocalhostArgs(args.map(String));
  const containerFile = `/workspace/poc/${relativeFile}`;
  const command = interpreter === "python" ? "python3" : "node";
  const commandArgv = [containerFile, ...rewritten.argv];
  const dockerArgs = [
    "run",
    "--rm",
    "--add-host",
    "host.docker.internal:host-gateway",
    "--cap-add",
    "NET_ADMIN",
    "--cap-add",
    "NET_RAW",
    "-e",
    "NO_PROXY=localhost,127.0.0.1",
    "-e",
    "no_proxy=localhost,127.0.0.1",
    "-v",
    `${hostDir}:/workspace/poc:ro`,
    "-w",
    "/workspace/poc",
  ];
  if (runtime.trafficProxyUrl) {
    const proxy = dockerReachableProxyUrl(runtime.trafficProxyUrl);
    dockerArgs.push("-e", `HTTP_PROXY=${proxy}`);
    dockerArgs.push("-e", `HTTPS_PROXY=${proxy}`);
    dockerArgs.push("-e", `http_proxy=${proxy}`);
    dockerArgs.push("-e", `https_proxy=${proxy}`);
  }
  dockerArgs.push("--entrypoint", command);
  dockerArgs.push(runtime.scannerSandbox?.image || "ghcr.io/usestrix/strix-sandbox:1.0.0", ...commandArgv);
  return {
    argv: dockerArgs,
    commandArgv: [command, ...commandArgv],
    targetRewrite: rewritten.rewrite,
  };
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

function rewriteLocalhostArgs(argv: string[]): { argv: string[]; rewrite?: Record<string, string> } {
  let rewrite: Record<string, string> | undefined;
  const out = argv.map((arg) => {
    const changed = rewriteLocalhostUrl(arg);
    if (changed !== arg) {
      rewrite = { ...(rewrite || {}), [arg]: changed };
    }
    return changed;
  });
  return { argv: out, rewrite };
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

function dockerReachableProxyUrl(value: string): string {
  return rewriteLocalhostUrl(value);
}

function runProcess(command: string, argv: string[], timeoutMs: number): Promise<PocProcessResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, argv, { shell: false, windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        resolveResult({
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
      clearTimeout(timer);
      resolveResult({
        exitCode,
        stdout: Buffer.concat(stdout).toString("utf8").slice(0, 128 * 1024),
        stderr: Buffer.concat(stderr).toString("utf8").slice(0, 32 * 1024),
      });
    });
  });
}
