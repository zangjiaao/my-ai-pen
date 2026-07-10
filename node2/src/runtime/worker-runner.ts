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
import { createPentestExtension } from "./pentest-extension.js";
import { resolveWorkerRole, workerToolAllowlist, type WorkerRoleId } from "./worker-roles.js";

export type WorkerLaunchContext = {
  config: Node2Config;
  model: unknown;
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
  settingsManager: SettingsManager;
  taskDir: string;
};

export type WorkerRunResult = {
  ok: boolean;
  role: WorkerRoleId;
  summary: string;
  toolCallCount: number;
  error?: string;
  durationMs: number;
};

export async function runWorkerSession(input: {
  runtime: ToolRuntime;
  launch: WorkerLaunchContext;
  role: string;
  task: string;
  maxTurns?: number;
  signal?: AbortSignal;
}): Promise<WorkerRunResult> {
  const started = Date.now();
  const role = resolveWorkerRole(input.role);
  const tools = workerToolAllowlist(role);
  const taskText = String(input.task || "").trim();
  if (!taskText) {
    return {
      ok: false,
      role: role.id,
      summary: "",
      toolCallCount: 0,
      error: "worker task is required",
      durationMs: 0,
    };
  }

  const maxTurns = clampInt(input.maxTurns ?? Number(process.env.NODE2_WORKER_MAX_TURNS || 12), 1, 40);
  const workerDir = join(input.launch.taskDir, "workers", `${role.id}-${Date.now().toString(36)}`);
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
    if (event?.type === "tool_execution_start") toolCallCount += 1;
    if (event?.type === "message_end" && event?.message?.role === "assistant") {
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

    // Soft turn budget: prompt once; session stop is controlled by max agent turns via env if supported.
    // Also hard-timeout the whole worker.
    const timeoutMs = clampInt(Number(process.env.NODE2_WORKER_MAX_MS || 180_000), 10_000, 900_000);
    await Promise.race([
      session.prompt(
        [
          `Worker role: ${role.id} (${role.label})`,
          `Max effort: about ${maxTurns} tool-using turns; then stop with a summary.`,
          "Assigned package:",
          taskText,
        ].join("\n\n"),
        { source: "interactive" },
      ),
      sleepReject(timeoutMs, `worker timed out after ${timeoutMs}ms`),
    ]);

    return {
      ok: true,
      role: role.id,
      summary: lastAssistant || `Worker ${role.id} completed with ${toolCallCount} tool call(s).`,
      toolCallCount,
      durationMs: Date.now() - started,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      role: role.id,
      summary: lastAssistant,
      toolCallCount,
      error: message,
      durationMs: Date.now() - started,
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
