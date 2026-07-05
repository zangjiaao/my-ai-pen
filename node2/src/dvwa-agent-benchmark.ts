import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { loadConfig } from "./config.js";
import { loadDotEnv } from "./env.js";
import { runPentestTask } from "./runtime/session-runner.js";
import type { PlatformMessage, PlatformSink, ScanMode, TaskEnvelope } from "./types.js";

loadDotEnv();
loadDotEnv("node2/.env");

const DVWA_LEVELS = ["low", "medium", "high"] as const;
type DvwaLevel = (typeof DVWA_LEVELS)[number];

class FilePlatformSink implements PlatformSink {
  private readonly taskDir: string;
  private readonly eventsPath: string;
  private lastCheckpoint: unknown;

  constructor(workspaceDir: string, taskId: string) {
    this.taskDir = resolve(workspaceDir, taskId);
    this.eventsPath = resolve(this.taskDir, "events.jsonl");
  }

  async init(): Promise<void> {
    await mkdir(this.taskDir, { recursive: true });
    await writeFile(this.eventsPath, "", "utf8");
  }

  async send(message: PlatformMessage): Promise<void> {
    const enriched = { ts: new Date().toISOString(), ...message };
    if (message.type === "checkpoint_update") {
      this.lastCheckpoint = message.checkpoint;
      await writeFile(resolve(this.taskDir, "latest-checkpoint.json"), JSON.stringify(message.checkpoint, null, 2), "utf8");
    }
    if (message.type === "task_complete" || message.type === "task_incomplete" || message.type === "task_error") {
      await writeFile(resolve(this.taskDir, "last-terminal-message.json"), JSON.stringify(enriched, null, 2), "utf8");
    }
    await appendFile(this.eventsPath, `${JSON.stringify(enriched)}\n`, "utf8");
  }

  async writeSummary(status: string): Promise<void> {
    await writeFile(
      resolve(this.taskDir, "standalone-summary.json"),
      JSON.stringify({ status, taskDir: this.taskDir, eventsPath: this.eventsPath, checkpoint: this.lastCheckpoint || null }, null, 2),
      "utf8",
    );
  }
}

const args = parseArgs(process.argv.slice(2));
const config = loadConfig();

async function main(): Promise<void> {
  const target = args.target || "http://localhost:8080";
  const outputDir = resolve(args.output || config.workspaceDir);
  const scanMode = normalizeScanMode(args["scan-mode"]);
  const levels = parseLevels(args.levels || "low,medium,high");
  const runId = args["run-id"] || `dvwa-agent-benchmark-${Date.now()}`;
  const resetDb = args["reset-db"] !== "false";
  const summaryPath = resolve(outputDir, `${runId}-summary.json`);
  const results: DvwaBenchmarkResult[] = [];

  for (const level of levels) {
    const taskId = `${runId}-${level}-${randomUUID().slice(0, 8)}`;
    const taskDir = resolve(outputDir, taskId);
    const sink = new FilePlatformSink(outputDir, taskId);
    await sink.init();

    const preflight = await prepareDvwa(target, level, resetDb).catch((error) => ({
      ok: false,
      level,
      resetDb,
      message: error instanceof Error ? error.message : String(error),
    }));

    const task: TaskEnvelope = {
      taskId,
      conversationId: taskId,
      scanMode,
      instruction: [
        `Run an authorized DVWA web penetration test at security level ${level}.`,
        "Use credentials admin/password when login is required.",
        "Use pentest-web workflow first, then scan/map real pages, forms, traffic, parameters, and session state before selecting vulnerability classes.",
        "Use Pi native skills as methodology, the PoC catalog as the vulnerability dictionary, and Node2 tools for deterministic testing.",
        scanModeInstruction(scanMode),
        resetDb
          ? "The benchmark harness reset the DVWA database before this run; do not reset it again unless login is blocked."
          : "Do not reset the DVWA database unless login is blocked and setup is required.",
        "Confirm findings only with evidence_ids and finish with finish_scan.",
      ].join(" "),
      target: { type: "url", value: target, app: "DVWA", security: level, preflight },
      scope: { allow: [target] },
      snapshot: { dvwa_security: level, preflight },
    };

    const startedAt = new Date();
    let runError = "";
    try {
      await runPentestTask(config, sink, task);
      await sink.writeSummary("completed");
    } catch (error) {
      runError = error instanceof Error ? error.message : String(error);
      await sink.send({
        type: "task_error",
        conversation_id: task.conversationId,
        task_id: task.taskId,
        message: runError,
      });
      await sink.writeSummary("error");
    }
    const endedAt = new Date();
    results.push(await summarizeRun(taskDir, taskId, level, scanMode, startedAt, endedAt, preflight, runError));
    await writeFile(summaryPath, JSON.stringify({ runId, target, scanMode, results }, null, 2), "utf8");
  }

  console.log(`[node2-dvwa-agent-benchmark] ${summaryPath}`);
  for (const result of results) {
    console.log(
      `${result.level}: status=${result.terminalStatus} finish=${result.finishStatus || "none"} seconds=${result.seconds} findings=${result.findings.length}`,
    );
  }
}

type DvwaBenchmarkResult = {
  taskId: string;
  taskDir: string;
  level: DvwaLevel;
  scanMode: ScanMode;
  seconds: number;
  terminalStatus: string;
  finishStatus?: string;
  findings: Array<{ title: string; severity?: string; location?: string }>;
  workflows: unknown[];
  coverage?: unknown;
  preflight: unknown;
  error?: string;
};

async function summarizeRun(
  taskDir: string,
  taskId: string,
  level: DvwaLevel,
  scanMode: ScanMode,
  startedAt: Date,
  endedAt: Date,
  preflight: unknown,
  error: string,
): Promise<DvwaBenchmarkResult> {
  const checkpoint = await readJson(resolve(taskDir, "latest-checkpoint.json"));
  const terminal = await readJson(resolve(taskDir, "last-terminal-message.json"));
  const events = await readEvents(resolve(taskDir, "events.jsonl"));
  const findings = events
    .filter((event) => event.type === "vuln_found")
    .map((event) => ({
      title: String(event.title || ""),
      severity: typeof event.severity === "string" ? event.severity : undefined,
      location: typeof event.location === "string" ? event.location : typeof event.url === "string" ? event.url : undefined,
    }))
    .filter((finding, index, all) => finding.title && all.findIndex((item) => item.title === finding.title) === index);

  const lifecycle = isRecord(checkpoint?.lifecycle) ? checkpoint.lifecycle : {};
  const finishScan = isRecord(lifecycle.finishScan) ? lifecycle.finishScan : undefined;
  return {
    taskId,
    taskDir,
    level,
    scanMode,
    seconds: Math.round(((endedAt.getTime() - startedAt.getTime()) / 1000) * 10) / 10,
    terminalStatus: String(terminal?.status || (error ? "error" : "unknown")),
    finishStatus: typeof finishScan?.status === "string" ? finishScan.status : undefined,
    findings,
    workflows: Array.isArray(checkpoint?.workflows) ? checkpoint.workflows : [],
    coverage: checkpoint?.coverage,
    preflight,
    error: error || undefined,
  };
}

async function prepareDvwa(target: string, level: DvwaLevel, resetDb: boolean): Promise<Record<string, unknown>> {
  const reset = resetDb ? await resetDvwaDatabase(target) : { ok: true, skipped: true };
  const security = await setDvwaSecurity(target, level);
  return {
    ok: Boolean(reset.ok && security.ok),
    level,
    resetDb,
    reset,
    ...security,
  };
}

async function resetDvwaDatabase(target: string): Promise<Record<string, unknown>> {
  let cookie = "";
  const setupGet = await request(target, "/setup.php", { method: "GET" }, cookie);
  cookie = mergeCookies(cookie, setupGet.cookie);
  const token = userToken(setupGet.body);
  const body = new URLSearchParams({
    create_db: "Create / Reset Database",
    ...(token ? { user_token: token } : {}),
  }).toString();
  const setupPost = await request(
    target,
    "/setup.php",
    { method: "POST", headers: formHeaders(), body, redirect: "manual" },
    cookie,
  );
  return {
    ok: setupPost.status >= 200 && setupPost.status < 400,
    setupGetStatus: setupGet.status,
    setupPostStatus: setupPost.status,
  };
}

async function setDvwaSecurity(target: string, level: DvwaLevel): Promise<Record<string, unknown>> {
  let cookie = "";
  const loginGet = await request(target, "/login.php", { method: "GET" }, cookie);
  cookie = mergeCookies(cookie, loginGet.cookie);
  const loginToken = userToken(loginGet.body);
  const loginBody = new URLSearchParams({
    username: "admin",
    password: "password",
    Login: "Login",
    ...(loginToken ? { user_token: loginToken } : {}),
  }).toString();
  const loginPost = await request(
    target,
    "/login.php",
    { method: "POST", headers: formHeaders(), body: loginBody, redirect: "manual" },
    cookie,
  );
  cookie = mergeCookies(cookie, loginPost.cookie);

  const securityGet = await request(target, "/security.php", { method: "GET" }, mergeCookies(cookie, `security=${level}`));
  cookie = mergeCookies(cookie, securityGet.cookie);
  const securityToken = userToken(securityGet.body);
  const securityBody = new URLSearchParams({
    security: level,
    seclev_submit: "Submit",
    ...(securityToken ? { user_token: securityToken } : {}),
  }).toString();
  const securityPost = await request(
    target,
    "/security.php",
    { method: "POST", headers: formHeaders(), body: securityBody, redirect: "manual" },
    mergeCookies(cookie, `security=${level}`),
  );
  cookie = mergeCookies(cookie, securityPost.cookie);

  return {
    ok: loginPost.status >= 200 && loginPost.status < 400 && securityPost.status >= 200 && securityPost.status < 400,
    level,
    loginStatus: loginPost.status,
    securityStatus: securityPost.status,
    cookieNames: cookie.split(";").map((item) => item.trim().split("=")[0]).filter(Boolean),
  };
}

async function request(
  target: string,
  path: string,
  init: RequestInit,
  cookie: string,
): Promise<{ status: number; body: string; cookie: string }> {
  const url = new URL(path, target).toString();
  const headers = new Headers(init.headers || {});
  if (cookie) headers.set("cookie", cookie);
  const response = await fetch(url, { ...init, headers });
  const body = await response.text();
  return {
    status: response.status,
    body,
    cookie: response.headers.get("set-cookie") || "",
  };
}

function formHeaders(): Record<string, string> {
  return { "content-type": "application/x-www-form-urlencoded" };
}

function mergeCookies(left: string, right: string): string {
  const jar = new Map<string, string>();
  for (const raw of [left, right]) {
    for (const part of raw.split(/,(?=\s*[^;,=\s]+=)|;/)) {
      const trimmed = part.trim();
      const match = /^([^=\s]+)=([^;,\s]*)/.exec(trimmed);
      if (!match) continue;
      const name = match[1].toLowerCase();
      if (["path", "expires", "max-age", "httponly", "secure", "samesite"].includes(name)) continue;
      jar.set(match[1], match[2]);
    }
  }
  return [...jar.entries()].map(([key, value]) => `${key}=${value}`).join("; ");
}

function userToken(html: string): string {
  return /name=['"]user_token['"]\s+value=['"]([^'"]+)['"]/i.exec(html)?.[1] || "";
}

async function readJson(path: string): Promise<any> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

async function readEvents(path: string): Promise<any[]> {
  try {
    const text = await readFile(path, "utf8");
    return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function parseLevels(value: string): DvwaLevel[] {
  const levels = value.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
  const invalid = levels.filter((level) => !DVWA_LEVELS.includes(level as DvwaLevel));
  if (invalid.length) throw new Error(`Unsupported DVWA level(s): ${invalid.join(", ")}. Use low, medium, high.`);
  return levels.length ? levels as DvwaLevel[] : ["low", "medium", "high"];
}

function normalizeScanMode(value: string | undefined): ScanMode {
  const normalized = String(value || "standard").trim().toLowerCase();
  if (normalized === "quick" || normalized === "standard" || normalized === "deep") return normalized;
  throw new Error(`Unsupported --scan-mode "${value}". Use quick, standard, or deep.`);
}

function scanModeInstruction(scanMode: ScanMode): string {
  if (scanMode === "quick") {
    return "Quick mode: prioritize high-signal deterministic findings first; record skipped DVWA modules as coverage gaps rather than spending time on every bypass.";
  }
  if (scanMode === "deep") {
    return "Deep mode: after scan-first mapping, attempt bypasses and chained checks across all DVWA benchmark modules: brute force, command injection, CSRF, file inclusion, file upload, SQL injection, blind SQL injection, weak session IDs, DOM/reflected/stored XSS, insecure CAPTCHA, CSP bypass, and JavaScript logic.";
  }
  return "Standard mode: cover every discovered DVWA benchmark module once with deterministic evidence where possible: brute force, command injection, CSRF, file inclusion, file upload, SQL injection, blind SQL injection, weak session IDs, DOM/reflected/stored XSS, insecure CAPTCHA, CSP bypass, and JavaScript logic. For each module, confirm a finding or record a meaningful negative/blocker before finish_scan.";
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]!;
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      index += 1;
    } else {
      out[key] = "true";
    }
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

try {
  await main();
  process.exit(0);
} catch (error) {
  console.error(error);
  process.exit(1);
}
