import { spawn } from "node:child_process";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ToolRuntime } from "../types.js";
import { observeAttackSurface } from "../runtime/coverage-auditor.js";
import { emitToolEvidence, isInScope, jsonResult } from "./common.js";

const SCANNERS: Record<string, { command: string; build: (p: Record<string, unknown>) => string[]; timeoutMs: number }> = {
  nmap: { command: "nmap", timeoutMs: 10 * 60_000, build: (p) => compact(["-sV", String(p.target || ""), ...(asArray(p.args))]) },
  httpx: { command: "httpx", timeoutMs: 5 * 60_000, build: (p) => compact(["-silent", "-json", "-u", String(p.target || ""), ...(asArray(p.args))]) },
  katana: { command: "katana", timeoutMs: 8 * 60_000, build: (p) => compact(["-silent", "-jsonl", "-u", String(p.target || ""), ...(asArray(p.args))]) },
  ffuf: { command: "ffuf", timeoutMs: 10 * 60_000, build: (p) => compact(["-u", String(p.url || p.target || ""), "-w", String(p.wordlist || ""), "-json", ...(asArray(p.args))]) },
  nuclei: { command: "nuclei", timeoutMs: 12 * 60_000, build: (p) => compact(["-jsonl", "-u", String(p.target || ""), ...(asArray(p.args))]) },
  sqlmap: { command: "sqlmap", timeoutMs: 15 * 60_000, build: (p) => compact(["-u", String(p.url || p.target || ""), "--batch", ...(asArray(p.args))]) },
  dalfox: { command: "dalfox", timeoutMs: 10 * 60_000, build: (p) => compact(["url", String(p.url || p.target || ""), "--output", "stdout", ...(asArray(p.args))]) },
  arjun: { command: "arjun", timeoutMs: 8 * 60_000, build: (p) => compact(["-u", String(p.url || p.target || ""), "-oJ", "-", ...(asArray(p.args))]) },
  wafw00f: { command: "wafw00f", timeoutMs: 3 * 60_000, build: (p) => compact([String(p.target || ""), ...(asArray(p.args))]) },
  nikto: { command: "nikto", timeoutMs: 12 * 60_000, build: (p) => compact(["-h", String(p.target || ""), ...(asArray(p.args))]) },
};

export function createScanTool(runtime: ToolRuntime): ToolDefinition<any> {
  return {
    name: "scan",
    label: "Scan",
    description: "Run an allowed professional scanner with structured arguments. Supported scanners: nmap, httpx, katana, ffuf, nuclei, sqlmap, dalfox, arjun, wafw00f, nikto.",
    promptSnippet: "Run allowed professional security scanners",
    promptGuidelines: [
      "Use scan for broad or specialized probing instead of inventing request loops manually.",
      "Scan always runs inside the configured Strix-style scanner sandbox; host scanner binaries are not used.",
      "Use scanner output as candidates until verified with http/browser/poc and evidence.",
    ],
    parameters: Type.Object({
      scanner: Type.String(),
      target: Type.Optional(Type.String()),
      url: Type.Optional(Type.String()),
      wordlist: Type.Optional(Type.String()),
      args: Type.Optional(Type.Array(Type.String())),
      timeout_seconds: Type.Optional(Type.Number()),
    }),
    async execute(_toolCallId: string, params: any) {
      const spec = SCANNERS[params.scanner];
      if (!spec) throw new Error(`unsupported scanner: ${params.scanner}`);
      const target = String(params.url || params.target || "");
      if (!target) throw new Error("target or url is required");
      if (!isInScope(runtime, target)) throw new Error(`out of scope: ${target}`);
      const argv = spec.build(params);
      const timeoutMs = Math.min((params.timeout_seconds || spec.timeoutMs / 1000) * 1000, spec.timeoutMs);
      const execution = await runScanner(runtime, spec.command, argv, timeoutMs);
      const result = execution.result;
      if (result.unavailable) {
        throw new Error(
          `scanner sandbox unavailable for ${params.scanner}: ${result.error || result.errorCode || "docker runner failed to start"}`,
        );
      }
      const evidenceId = await emitToolEvidence(runtime, "scan", `${params.scanner} ${target}`, {
        scanner: params.scanner,
        argv: execution.argv,
        execution,
        ...result,
      });
      const ingested = await ingestScannerOutput(runtime, params.scanner, target, result, evidenceId);
      await observeAttackSurface(runtime, { method: "GET", url: target, responseBody: `${result.stdout}\n${result.stderr}`, evidenceIds: [evidenceId], source: "scan" });
      return jsonResult({ evidence_id: evidenceId, scanner: params.scanner, argv: execution.argv, execution, ingested, ...result }, { evidenceId });
    },
  };
}

type ProcessResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  unavailable?: boolean;
  errorCode?: string;
  error?: string;
};

type ScannerExecution = {
  runner: "docker";
  command: string;
  argv: string[];
  result: ProcessResult;
  image?: string;
  targetRewrite?: Record<string, string>;
};

type ScannerUrlObservation = {
  url: string;
  method: string;
  status?: number;
  title?: string;
  contentType?: string;
  source: string;
};

type ScannerFindingObservation = {
  url?: string;
  templateId?: string;
  name?: string;
  severity?: string;
  matchedAt?: string;
  type: string;
  raw: unknown;
};

function runProcess(command: string, argv: string[], timeoutMs: number): Promise<ProcessResult> {
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
        stdout: Buffer.concat(stdout).toString("utf8").slice(0, 128 * 1024),
        stderr: Buffer.concat(stderr).toString("utf8").slice(0, 32 * 1024),
      });
    });
  });
}

async function runScanner(runtime: ToolRuntime, command: string, argv: string[], timeoutMs: number): Promise<ScannerExecution> {
  if (!runtime.scannerSandbox?.enabled) {
    throw new Error("Node2 scan is sandbox-only; enable NODE2_SCANNER_SANDBOX_AUTO and configure the scanner sandbox image.");
  }
  return runDockerScanner(runtime, command, argv, timeoutMs);
}

async function runDockerScanner(
  runtime: ToolRuntime,
  command: string,
  argv: string[],
  timeoutMs: number,
): Promise<ScannerExecution> {
  const docker = dockerInvocation(runtime, command, argv);
  const dockerCommand = dockerCommandConfig();
  const dockerResult = await runProcess(dockerCommand.command, [...dockerCommand.prefixArgv, ...docker.argv], Math.max(timeoutMs, 120_000));
  return {
    runner: "docker",
    command,
    argv: docker.commandArgv,
    result: dockerResult,
    image: runtime.scannerSandbox?.image,
    targetRewrite: docker.targetRewrite,
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

function dockerInvocation(
  runtime: ToolRuntime,
  command: string,
  argv: string[],
): { argv: string[]; commandArgv: string[]; targetRewrite?: Record<string, string> } {
  const rewritten = rewriteLocalhostArgs(argv);
  const shellCommand = shellJoin([command, ...rewritten.argv]);
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
  ];
  if (runtime.trafficProxyUrl) {
    dockerArgs.push("-e", `HTTP_PROXY=${dockerReachableProxyUrl(runtime.trafficProxyUrl)}`);
    dockerArgs.push("-e", `HTTPS_PROXY=${dockerReachableProxyUrl(runtime.trafficProxyUrl)}`);
    dockerArgs.push("-e", `http_proxy=${dockerReachableProxyUrl(runtime.trafficProxyUrl)}`);
    dockerArgs.push("-e", `https_proxy=${dockerReachableProxyUrl(runtime.trafficProxyUrl)}`);
  }
  dockerArgs.push("--entrypoint", "bash");
  dockerArgs.push(runtime.scannerSandbox?.image || "ghcr.io/usestrix/strix-sandbox:1.0.0", "-lc", shellCommand);
  return {
    argv: dockerArgs,
    commandArgv: rewritten.argv,
    targetRewrite: rewritten.rewrite,
  };
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

async function ingestScannerOutput(
  runtime: ToolRuntime,
  scanner: string,
  target: string,
  result: ProcessResult,
  evidenceId: string,
): Promise<Record<string, unknown>> {
  const parsed = parseScannerOutput(scanner, target, result.stdout);
  const trafficIds: string[] = [];
  for (const observation of parsed.urls) {
    if (!isInScope(runtime, observation.url)) continue;
    const trafficId = runtime.traffic.add({
      source: `scan:${scanner}`,
      method: observation.method,
      url: observation.url,
      status: observation.status,
      requestHeaders: {},
      responseHeaders: observation.contentType ? { "content-type": observation.contentType } : {},
      responseBody: observation.title ? `<title>${escapeHtml(observation.title)}</title>` : undefined,
      evidenceId,
      tags: ["scanner-observed"],
    });
    trafficIds.push(trafficId);
    await observeAttackSurface(runtime, {
      method: observation.method,
      url: observation.url,
      responseBody: observation.title || "",
      evidenceIds: [evidenceId],
      source: `scan:${scanner}`,
    });
  }

  const findingsEvidenceId = parsed.findings.length
    ? await emitToolEvidence(runtime, "scan", `${scanner} candidate findings ${target}`, {
        scanner,
        source_evidence_id: evidenceId,
        findings: parsed.findings,
      })
    : undefined;
  const backlogItems = seedScannerBacklog(runtime, parsed.findings, findingsEvidenceId || evidenceId);

  return {
    parsed_urls: parsed.urls.length,
    traffic_ids: trafficIds,
    candidate_findings: parsed.findings.length,
    findings_evidence_id: findingsEvidenceId,
    backlog_items: backlogItems,
  };
}

function parseScannerOutput(
  scanner: string,
  target: string,
  stdout: string,
): { urls: ScannerUrlObservation[]; findings: ScannerFindingObservation[] } {
  const urls: ScannerUrlObservation[] = [];
  const findings: ScannerFindingObservation[] = [];
  for (const item of parseJsonishLines(stdout)) {
    const url = scannerUrlFromRecord(scanner, item, target);
    if (url) urls.push(url);
    const finding = scannerFindingFromRecord(scanner, item);
    if (finding) findings.push(finding);
  }
  for (const url of textUrls(stdout)) {
    urls.push({ url, method: "GET", source: `${scanner}:text` });
  }
  return {
    urls: uniqueUrlObservations(urls),
    findings: uniqueFindings(findings),
  };
}

function seedScannerBacklog(runtime: ToolRuntime, findings: ScannerFindingObservation[], evidenceId: string): string[] {
  const nodes: string[] = [];
  for (const finding of findings) {
    const test = scannerFindingToTest(finding);
    if (!test) continue;
    const node = runtime.plan.upsert({
      node_id: `plan-test-${slug(`${test.endpoint}-${test.param}-${test.vulnClass}`)}`,
      title: `Verify scanner candidate: ${test.vulnClass} on ${test.param}`,
      status: "pending",
      kind: "test",
      level: "work_item",
      parent_id: "plan-objective-analysis-test-plan",
      method: "SCANNER",
      endpoint: test.endpoint,
      parameter: test.param,
      vuln_type: test.vulnClass,
      result: "inconclusive",
      notes: test.notes,
      evidence_ids: [evidenceId],
      priority: test.priority,
      source: `scan:${finding.type}`,
    });
    nodes.push(node.node_id);
  }
  return nodes;
}

function scannerFindingToTest(finding: ScannerFindingObservation): { endpoint: string; param: string; vulnClass: string; notes: string; priority: number } | undefined {
  const url = finding.url || normalizeObservedUrl(finding.matchedAt, "");
  if (!url) return undefined;
  const parsed = new URL(url);
  const vulnClass = scannerVulnClass(finding);
  if (!vulnClass) return undefined;
  const param = scannerFindingParam(parsed, vulnClass);
  const label = [finding.templateId, finding.name, finding.severity].filter(Boolean).join(" / ");
  return {
    endpoint: parsed.pathname,
    param,
    vulnClass,
    notes: `Scanner candidate from ${finding.type}${label ? `: ${label}` : ""}. Verify with baseline and attack evidence before confirming.`,
    priority: scannerPriority(finding.severity),
  };
}

function scannerVulnClass(finding: ScannerFindingObservation): string | undefined {
  const text = `${finding.type} ${finding.templateId || ""} ${finding.name || ""} ${finding.severity || ""}`.toLowerCase();
  if (/blind.*sql|sql.*blind|sqli.*blind/.test(text)) return "blind-sql-injection";
  if (/sql|sqli/.test(text)) return "sql-injection";
  if (/command|rce|remote.code|os.command/.test(text)) return "command-injection";
  if (/lfi|local.file|file.inclusion|path.traversal|directory.traversal/.test(text)) return "file-inclusion";
  if (/upload/.test(text)) return "file-upload";
  if (/stored.*xss|xss.*stored/.test(text)) return "xss-stored";
  if (/dom.*xss|xss.*dom/.test(text)) return "xss-dom";
  if (/xss|cross.site.scripting/.test(text)) return "xss-reflected";
  if (/csrf|cross.site.request/.test(text)) return "csrf";
  if (/weak.*session|predictable.*session|session.*predict/.test(text)) return "weak-session-id";
  return undefined;
}

function scannerFindingParam(url: URL, vulnClass: string): string {
  const params = [...url.searchParams.keys()];
  if (params.length === 1) return params[0];
  if (params.length > 1) return params.join(",");
  if (vulnClass === "command-injection") return "ip";
  if (vulnClass === "file-inclusion") return "page";
  if (vulnClass === "file-upload") return "uploaded";
  if (vulnClass === "xss-stored") return "txtName,mtxMessage";
  if (vulnClass === "xss-reflected" || vulnClass === "xss-dom") return "name";
  if (vulnClass === "csrf") return "token";
  if (vulnClass === "weak-session-id") return "session";
  return "id";
}

function scannerPriority(severity: string | undefined): number {
  const normalized = (severity || "").toLowerCase();
  if (normalized === "critical") return 205;
  if (normalized === "high") return 210;
  if (normalized === "medium") return 220;
  if (normalized === "low") return 235;
  return 225;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 100) || "item";
}

function parseJsonishLines(stdout: string): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  const trimmed = stdout.trim();
  if (!trimmed) return records;
  try {
    const parsed = JSON.parse(trimmed);
    collectJsonRecords(parsed, records);
    if (records.length) return records;
  } catch {
    // Fall back to JSONL parsing.
  }
  for (const line of stdout.split(/\r?\n/)) {
    const value = line.trim();
    if (!value || !value.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(value);
      collectJsonRecords(parsed, records);
    } catch {
      // Ignore non-JSON scanner chatter.
    }
  }
  return records;
}

function collectJsonRecords(value: unknown, records: Record<string, unknown>[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectJsonRecords(item, records);
    return;
  }
  if (value && typeof value === "object") {
    records.push(value as Record<string, unknown>);
  }
}

function scannerUrlFromRecord(scanner: string, record: Record<string, unknown>, target: string): ScannerUrlObservation | undefined {
  const rawUrl = firstString(record, ["url", "input", "host", "matched-at", "matched", "request", "path"]);
  const url = normalizeObservedUrl(rawUrl, target);
  if (!url) return undefined;
  const method = firstString(record, ["method"])?.toUpperCase() || "GET";
  const status = firstNumber(record, ["status_code", "status-code", "status", "response-status-code"]);
  const title = firstString(record, ["title", "page-title"]);
  const contentType = firstString(record, ["content_type", "content-type", "contentType"]);
  return { url, method, status, title, contentType, source: `${scanner}:json` };
}

function scannerFindingFromRecord(scanner: string, record: Record<string, unknown>): ScannerFindingObservation | undefined {
  if (scanner === "httpx" || scanner === "katana") return undefined;
  const templateId = firstString(record, ["template-id", "template_id", "id"]);
  const info = record.info && typeof record.info === "object" ? record.info as Record<string, unknown> : {};
  const name = firstString(record, ["name", "description"]) || firstString(info, ["name", "description"]);
  const severity = firstString(record, ["severity"]) || firstString(info, ["severity"]);
  const matchedAt = firstString(record, ["matched-at", "matched", "url"]);
  const hasFindingSignal = Boolean(templateId || name || severity || matchedAt || /vulnerable|injectable|payload|risk/i.test(JSON.stringify(record)));
  if (!hasFindingSignal) return undefined;
  return {
    type: scanner,
    url: normalizeObservedUrl(matchedAt || firstString(record, ["url"]), ""),
    templateId,
    name,
    severity,
    matchedAt,
    raw: record,
  };
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function firstNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function normalizeObservedUrl(raw: string | undefined, base: string): string | undefined {
  if (!raw) return undefined;
  const value = raw.trim();
  if (!value || /^(?:javascript|mailto|tel|data):/i.test(value)) return undefined;
  try {
    if (/^https?:\/\//i.test(value)) return stripFragment(value);
    if (!base) return undefined;
    return stripFragment(new URL(value, /^https?:\/\//i.test(base) ? base : `http://${base}`).toString());
  } catch {
    return undefined;
  }
}

function textUrls(stdout: string): string[] {
  const urls = new Set<string>();
  for (const match of stdout.matchAll(/https?:\/\/[^\s"'<>`\\]+/gi)) {
    const raw = match[0].replace(/[),.;\]]+$/, "");
    try {
      urls.add(stripFragment(raw));
    } catch {
      // Ignore malformed URLs.
    }
  }
  return [...urls];
}

function uniqueUrlObservations(values: ScannerUrlObservation[]): ScannerUrlObservation[] {
  const seen = new Set<string>();
  const out: ScannerUrlObservation[] = [];
  for (const value of values) {
    const key = `${value.method} ${value.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out.slice(0, 300);
}

function uniqueFindings(values: ScannerFindingObservation[]): ScannerFindingObservation[] {
  const seen = new Set<string>();
  const out: ScannerFindingObservation[] = [];
  for (const value of values) {
    const key = `${value.type} ${value.templateId || ""} ${value.name || ""} ${value.matchedAt || value.url || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out.slice(0, 100);
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function shellJoin(args: string[]): string {
  return args.map(shellQuote).join(" ");
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=,@%+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function stripFragment(url: string): string {
  const parsed = new URL(url);
  parsed.hash = "";
  return parsed.toString();
}

function asArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function compact(values: string[]): string[] {
  return values.filter((value) => value.length > 0);
}
