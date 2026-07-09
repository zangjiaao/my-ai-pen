import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { loadConfig } from "./config.js";
import { loadDotEnv } from "./env.js";
import { runPentestTask } from "./runtime/session-runner.js";
import type { PlatformMessage, PlatformSink, ScanMode, TaskEnvelope } from "./types.js";

loadDotEnv();
loadDotEnv("node2/.env");

const args = parseArgs(process.argv.slice(2));
const config = loadConfig();

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
    console.log(`[node2-standalone] ${status}: ${this.taskDir}`);
  }
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
  if (!out["task-id"]) out["task-id"] = randomUUID();
  return out;
}

function parseList(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

async function main(): Promise<void> {
  const taskId = args["task-id"] || `node2-standalone-${Date.now()}`;
  const target = args.target || "http://localhost:8080";
  const scanMode = normalizeScanMode(args["scan-mode"]);
  const dvwaSecurity = args["dvwa-security"];
  const outputDir = resolve(args.output || config.workspaceDir);
  const instruction = args.instruction || buildStandaloneInstruction({
    scanMode,
    target,
    dvwaSecurity,
  });

  const task: TaskEnvelope = {
    taskId,
    conversationId: args["conversation-id"] || taskId,
    instruction,
    scanMode,
    target: { type: "url", value: target },
    scope: { allow: parseList(args.scope || target) },
    snapshot: {},
  };

  const sink = new FilePlatformSink(outputDir, task.taskId);
  await sink.init();

  try {
    await runPentestTask(config, sink, task);
    await sink.writeSummary("completed");
  } catch (error) {
    await sink.send({
      type: "task_error",
      conversation_id: task.conversationId,
      task_id: task.taskId,
      message: error instanceof Error ? error.message : String(error),
    });
    await sink.writeSummary("error");
    throw error;
  }
}

function normalizeScanMode(value: string | undefined): ScanMode {
  const normalized = String(value || "standard").trim().toLowerCase();
  if (normalized === "quick" || normalized === "standard" || normalized === "deep") return normalized;
  throw new Error(`Unsupported --scan-mode "${value}". Use quick, standard, or deep.`);
}

function buildStandaloneInstruction(input: {
  scanMode: ScanMode;
  target: string;
  dvwaSecurity?: string;
}): string {
  const parts = [
    `Run an authorized web penetration test against ${input.target}.`,
    "Use the available workflow, Pi native skills, PoC catalog, and Node2 tools.",
    `Scan mode: ${input.scanMode}.`,
    "Identify the application from observed responses; do not assume DVWA, Juice Shop, or any other lab app unless the target actually presents as one.",
    "Use credentials only when the task provides them or when the application itself documents demo credentials.",
    "Report confirmed findings with evidence, meaningful negatives, coverage gaps, and blockers.",
  ];
  // Optional DVWA-only hint — only when the operator explicitly sets --dvwa-security.
  if (input.dvwaSecurity) {
    parts.push(
      `If and only if the target is DVWA, use credentials admin/password when login is required and set security level to ${input.dvwaSecurity} when that option is exposed.`,
    );
  }
  return parts.join(" ");
}

try {
  await main();
  process.exit(0);
} catch (error) {
  console.error(error);
  process.exit(1);
}
