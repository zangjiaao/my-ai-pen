/**
 * In-process worker runner: nested Pi session sharing the parent ToolRuntime.
 * This is Node2's subagent layer for live pentest tools (http/browser/verifier/…).
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  type AuthStorage,
  type ModelRegistry,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Node2Config } from "../config.js";
import type { ToolRuntime } from "../types.js";
import { LlmUsageLedger, type LlmUsageSnapshot } from "./llm-usage.js";
import { createPentestExtension } from "./pentest-extension.js";
import { resolveWorkerRole, workerToolAllowlist, type WorkerRoleId } from "./worker-roles.js";

export type WorkerLaunchContext = {
  config: Node2Config;
  model: unknown;
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
  settingsManager: SettingsManager;
  taskDir: string;
  mergeWorkerUsage?: (usage: LlmUsageSnapshot) => void | Promise<void>;
  noteWorker?: (type: string, details: Record<string, unknown>) => void | Promise<void>;
};

export type WorkerOutcome = "completed" | "timeout" | "failed" | "aborted";

export type WorkerRunResult = {
  ok: boolean;
  /** Stable terminal classification for plan/panel (not just ok boolean). */
  outcome: WorkerOutcome;
  workerId: string;
  role: WorkerRoleId;
  summary: string;
  toolCallCount: number;
  error?: string;
  durationMs: number;
  usage?: LlmUsageSnapshot;
};

/** Map error text to a display outcome. */
export function classifyWorkerOutcome(ok: boolean, error?: string): WorkerOutcome {
  if (ok) return "completed";
  const msg = String(error || "").toLowerCase();
  if (/timed out|timeout/.test(msg)) return "timeout";
  if (/abort/.test(msg)) return "aborted";
  return "failed";
}

/** Plan-node status for a worker outcome. */
export function planStatusForWorkerOutcome(outcome: WorkerOutcome): "done" | "blocked" | "failed" {
  if (outcome === "completed") return "done";
  // Timeout is incomplete work, not a hard crash — surface as blocked for TODO clarity.
  if (outcome === "timeout") return "blocked";
  return "failed";
}

export async function runWorkerSession(input: {
  runtime: ToolRuntime;
  launch: WorkerLaunchContext;
  role: string;
  task: string;
  workerId?: string;
  maxTurns?: number;
  signal?: AbortSignal;
}): Promise<WorkerRunResult> {
  const started = Date.now();
  const role = resolveWorkerRole(input.role);
  const tools = workerToolAllowlist(role);
  const workerId =
    String(input.workerId || "").trim() ||
    `worker-${role.id}-${Date.now().toString(36)}`;
  const taskText = String(input.task || "").trim();
  if (!taskText) {
    return {
      ok: false,
      outcome: "failed",
      workerId,
      role: role.id,
      summary: "",
      toolCallCount: 0,
      error: "worker task is required",
      durationMs: 0,
    };
  }

  // Fail fast when launch context is incomplete (smokes / misconfigured runtimes).
  // Start/end platform events are still emitted by the worker tool around this call.
  if (
    !input.launch?.config ||
    input.launch.model == null ||
    !input.launch.authStorage ||
    !input.launch.modelRegistry ||
    !input.launch.settingsManager ||
    !input.launch.taskDir
  ) {
    const error = "invalid worker launch context: missing model, config, or taskDir";
    return {
      ok: false,
      outcome: "failed",
      workerId,
      role: role.id,
      summary: "",
      toolCallCount: 0,
      error,
      durationMs: Date.now() - started,
      usage: {
        requests: 0,
        input_tokens: 0,
        output_tokens: 0,
        cached_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        total_tokens: 0,
        cost: 0,
        agent_count: 1,
        tool_calls: 0,
      },
    };
  }

  const limitsFromTask = input.runtime?.task?.workerLimits;
  const maxTurns = clampInt(
    input.maxTurns ?? limitsFromTask?.maxTurns ?? Number(process.env.NODE2_WORKER_MAX_TURNS || 12),
    1,
    40,
  );
  const workerDir = join(input.launch.taskDir, "workers", workerId);
  await mkdir(workerDir, { recursive: true });
  const piSessionDir = join(workerDir, "pi-sessions");
  await mkdir(piSessionDir, { recursive: true });

  // Workers share runtime state but get a filtered tool list and role system prompt.
  const resourceLoader = new DefaultResourceLoader({
    cwd: input.launch.taskDir,
    agentDir: input.launch.config.piAgentDir,
    settingsManager: input.launch.settingsManager,
    additionalSkillPaths: [input.launch.config.pentestSkillsDir],
    extensionFactories: [createPentestExtension(input.runtime)],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noContextFiles: true,
    systemPrompt: [
      role.systemPrompt,
      "",
      `Parent task target: ${JSON.stringify(input.runtime.task.target)}`,
      `Parent task scope: ${JSON.stringify(input.runtime.task.scope)}`,
      `Allowed tools: ${tools.join(", ")}`,
    ].join("\n"),
  });
  await resourceLoader.reload();

  let toolCallCount = 0;
  let lastAssistant = "";
  let maxTurnsReached = false;
  const usageLedger = new LlmUsageLedger();
  const { session } = await createAgentSession({
    cwd: input.launch.taskDir,
    agentDir: input.launch.config.piAgentDir,
    model: input.launch.model as any,
    thinkingLevel: "low",
    authStorage: input.launch.authStorage,
    modelRegistry: input.launch.modelRegistry,
    resourceLoader,
    tools,
    sessionManager: SessionManager.create(workerDir, piSessionDir),
    settingsManager: input.launch.settingsManager,
  });

  const unsubscribe = session.subscribe((event: any) => {
    if (event?.type === "tool_execution_start") {
      toolCallCount += 1;
      // Hard turn budget: stop gracefully after max tool starts (forces summary path).
      if (toolCallCount >= maxTurns && !maxTurnsReached) {
        maxTurnsReached = true;
        void session.abort?.();
      }
    }
    if (event?.type === "message_end" && event?.message?.role === "assistant") {
      usageLedger.recordAssistantMessage(event.message);
      const content = event.message.content;
      if (Array.isArray(content)) {
        lastAssistant = content
          .filter((part: any) => part?.type === "text")
          .map((part: any) => String(part.text || ""))
          .join("\n")
          .trim();
      } else if (typeof content === "string") {
        lastAssistant = content.trim();
      }
    }
  });

  try {
    if (input.signal?.aborted) throw new Error("worker aborted before start");
    const abortHandler = () => {
      void session.abort();
    };
    input.signal?.addEventListener("abort", abortHandler, { once: true });

    // Wall-clock budget: task_assign worker_limits (节点管理) > env > default 5 min.
    const limits = input.runtime?.task?.workerLimits;
    const timeoutMs = clampInt(
      Number(limits?.maxMs ?? process.env.NODE2_WORKER_MAX_MS ?? 300_000),
      10_000,
      900_000,
    );
    await Promise.race([
      session.prompt(
        [
          `Worker role: ${role.id} (${role.label})`,
          `Worker id: ${workerId}`,
          `Max effort: at most ${maxTurns} tool-using turns (hard stop), then write a concise summary of what was confirmed vs still open.`,
          "Keep the package narrow: prefer 1–2 endpoints; do not expand into unrelated levels.",
          "Assigned package:",
          taskText,
        ].join("\n\n"),
        { source: "interactive" },
      ),
      sleepReject(timeoutMs, `worker timed out after ${timeoutMs}ms`),
    ]);

    const usage = usageLedger.snapshot({ agent_count: 1, tool_calls: toolCallCount });
    const summary =
      lastAssistant ||
      (maxTurnsReached
        ? `Worker ${role.id} stopped after max ${maxTurns} tool turns (${toolCallCount} tool call(s)).`
        : `Worker ${role.id} completed with ${toolCallCount} tool call(s).`);
    return {
      ok: true,
      outcome: "completed",
      workerId,
      role: role.id,
      summary,
      toolCallCount,
      durationMs: Date.now() - started,
      usage,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const usage = usageLedger.snapshot({ agent_count: 1, tool_calls: toolCallCount });
    // Graceful max-turns stop is not a failure/timeout.
    if (maxTurnsReached && !/timed out|timeout/i.test(message)) {
      return {
        ok: true,
        outcome: "completed",
        workerId,
        role: role.id,
        summary:
          lastAssistant ||
          `Worker ${role.id} stopped after max ${maxTurns} tool turns (${toolCallCount} tool call(s)).`,
        toolCallCount,
        durationMs: Date.now() - started,
        usage,
      };
    }
    const outcome = classifyWorkerOutcome(false, message);
    return {
      ok: false,
      outcome,
      workerId,
      role: role.id,
      summary: lastAssistant || (outcome === "timeout" ? `Worker ${role.id} timed out after wall-clock budget.` : ""),
      toolCallCount,
      error: message,
      durationMs: Date.now() - started,
      usage,
    };
  } finally {
    unsubscribe?.();
    try {
      await session.dispose?.();
    } catch {
      // ignore dispose errors
    }
  }
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function sleepReject(ms: number, message: string): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(message)), ms);
  });
}
