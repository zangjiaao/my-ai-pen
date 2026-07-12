import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import { loadDotEnv } from "./env.js";
import { runNode4Task } from "./runtime/session-runner.js";
import type { PlatformMessage, PlatformSink, TaskEnvelope } from "./types.js";

loadDotEnv();
loadDotEnv("node2/.env");
loadDotEnv("node4/.env");

const args = parseArgs(process.argv.slice(2));
const config = loadConfig();

class LogSink implements PlatformSink {
  async send(message: PlatformMessage): Promise<void> {
    if (["task_complete", "task_error", "vuln_found", "todo_updated"].includes(message.type)) {
      console.log(`[node4] ${message.type}`, JSON.stringify(message).slice(0, 400));
    }
  }
}

async function main(): Promise<void> {
  const taskId = args["task-id"] || `node4-${randomUUID().slice(0, 8)}`;
  const target = args.target || "http://127.0.0.1:8080";
  const goalMode =
    args["goal-mode"] === "true" || args["goal-mode"] === "1" || Boolean(args["goal-objective"]?.trim());
  const goalObjective = args["goal-objective"]?.trim()
    ? args["goal-objective"].trim()
    : goalMode
      ? "Within authorized scope, maximize verified findings, flags, and challenge unlocks with evidence-backed booking. Complete only after auditing that remaining surface cannot be productively advanced."
      : undefined;
  const task: TaskEnvelope = {
    taskId,
    conversationId: args["conversation-id"] || taskId,
    instruction:
      args.instruction ||
      `Authorized security test of ${target}. Use todo → shell/http/script → finding(confirm)+evidence. Use subagent for separable packages. No finish tool; harness ends the session.`,
    target: { type: "url", value: target },
    scope: { allow: (args.scope || target).split(",").map((s) => s.trim()).filter(Boolean) },
    engagement: args.engagement || args.role || "pentest",
    role: args.role,
    goalObjective,
  };
  if (args.output) config.workspaceDir = resolve(args.output);

  const result = await runNode4Task(config, new LogSink(), task);
  console.log(`[node4-standalone] terminal=${result.terminalStatus} taskDir=${result.taskDir}`);
  if (result.terminalStatus === "failed") process.exit(1);
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i]!;
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i += 1;
    } else out[key] = "true";
  }
  return out;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
