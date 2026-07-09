import { cp, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Node2Config } from "../config.js";
import { CoverageStore } from "../stores/coverage.js";
import { EvidenceStore } from "../stores/evidence.js";
import { PlanStore } from "../stores/plan.js";
import { TrafficStore } from "../stores/traffic.js";
import { createExternalTrafficSource } from "../traffic/external-source.js";
import type { PlatformMessage, PlatformSink, TaskEnvelope, ToolRuntime } from "../types.js";
import { PENTEST_TOOL_NAMES } from "../tools/index.js";
import { startCaidoBridge } from "./caido-bridge.js";
import {
  conversionMetrics,
  finishCompletedEligibility,
  formatCandidate,
  materialUntestedHighPriority,
  nextVerifyGuidance,
} from "./detection-conversion.js";
import { createPentestExtension } from "./pentest-extension.js";
import { buildSystemPrompt } from "./prompt.js";

const TEXT_STREAM_FLUSH_MS = 250;
const DEFAULT_COMPLETION_GATE_ROUNDS = 1;

export async function runPentestTask(
  config: Node2Config,
  platform: PlatformSink,
  task: TaskEnvelope,
  signal?: AbortSignal,
): Promise<void> {
  task = normalizeSidecarTaskTarget(config, task);
  const taskDir = join(config.workspaceDir, task.taskId);
  await mkdir(taskDir, { recursive: true });
  const caidoBridge = await startCaidoBridge(config, platform, task);

  const runtime: ToolRuntime = {
    task,
    workspaceDir: config.workspaceDir,
    platform,
    plan: new PlanStore(),
    coverage: new CoverageStore(),
    evidence: new EvidenceStore(join(taskDir, "evidence")),
    traffic: new TrafficStore(),
    pocCatalogPath: config.pocCatalogPath,
    workflowRuns: [],
    lifecycle: {},
    trafficProxyUrl: caidoBridge?.caidoUrl || config.trafficProxyUrl,
    externalTrafficSource: caidoBridge?.source || createExternalTrafficSource({
      url: config.externalTrafficSourceUrl,
      token: config.externalTrafficSourceToken,
    }),
    scannerSandbox: {
      enabled: config.scannerSandboxAutoStart,
      image: config.scannerSandboxImage,
    },
  };
  await syncWorkflowBundles(config, taskDir);

  const authStorage = AuthStorage.create(join(config.piAgentDir, "auth.json"));
  setRuntimeApiKey(authStorage, config.modelProvider);
  const modelRegistry = ModelRegistry.inMemory(authStorage);
  if (config.modelProvider === "custom") {
    registerCustomModel(modelRegistry, config);
  } else if (config.llmBaseUrl) {
    modelRegistry.registerProvider(config.modelProvider, { baseUrl: config.llmBaseUrl });
  }
  const model = modelRegistry.find(config.modelProvider, config.modelId);
  if (!model) throw new Error(`model not found: ${config.modelProvider}/${config.modelId}`);

  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: true },
    retry: { enabled: true, maxRetries: 2 },
  });
  process.env.PI_WORKFLOW_SUBAGENT_BACKEND ??= "inline";

  const resourceLoader = new DefaultResourceLoader({
    cwd: taskDir,
    agentDir: config.piAgentDir,
    settingsManager,
    additionalExtensionPaths: [config.piWorkflowPackageDir],
    additionalSkillPaths: [config.pentestSkillsDir],
    extensionFactories: [createPentestExtension(runtime)],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noContextFiles: true,
    systemPrompt: buildSystemPrompt(task),
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd: taskDir,
    agentDir: config.piAgentDir,
    model,
    thinkingLevel: "medium",
    authStorage,
    modelRegistry,
    resourceLoader,
    tools: [...PENTEST_TOOL_NAMES],
    sessionManager: SessionManager.inMemory(taskDir),
    settingsManager,
  });

  const textStream = new PlatformTextStream(platform, task);
  try {
    const abortHandler = () => {
      void session.abort();
    };
    signal?.addEventListener("abort", abortHandler, { once: true });
    session.subscribe(async (event) => {
      await textStream.handle(event);
      await handleSessionEvent(platform, runtime, event);
    });
    runtime.plan.start();
    await platform.send({
      type: "status_update",
      conversation_id: task.conversationId,
      task_id: task.taskId,
      workflow_stage: runtime.plan.kanban().current_stage,
      active_tool: "pi",
      status: "running",
      message: "Pi pentest runtime started",
      progress: runtime.plan.progress(),
      kanban: runtime.plan.kanban(),
    });
    await platform.send({
      type: "plan_tree_updated",
      conversation_id: task.conversationId,
      task_id: task.taskId,
      reason: "runtime.start",
      workflow_stage: runtime.plan.kanban().current_stage,
      progress: runtime.plan.progress(),
      kanban: runtime.plan.kanban(),
      plan_tree: runtime.plan.snapshot(),
    });
    if (signal?.aborted) throw new Error("Task interrupted by user.");
    await session.prompt(buildWorkflowFirstInstruction(task), { source: "interactive" });
    await textStream.flush();
    throwIfLastAssistantError(session.messages);
    if (signal?.aborted) throw new Error("Task interrupted by user.");
    const gateRounds = completionGateRounds();
    let gate = completionGate(runtime);
    for (let round = 0; !gate.canComplete && round < gateRounds; round += 1) {
      const gapPrompt = completionGapPrompt(runtime, gate);
      await platform.send({
        type: "completion_blocked",
        conversation_id: task.conversationId,
        task_id: task.taskId,
        round: round + 1,
        audit: gate.audit,
        message: "Runtime completion gate found unresolved runtime safety checks.",
      });
      await session.prompt(gapPrompt, { source: "interactive" });
      await textStream.flush();
      throwIfLastAssistantError(session.messages);
      if (signal?.aborted) throw new Error("Task interrupted by user.");
      gate = completionGate(runtime);
    }
    if (!gate.canComplete) {
      runtime.plan.setPhase("report");
      await platform.send({
        type: "plan_tree_updated",
        conversation_id: task.conversationId,
        task_id: task.taskId,
        reason: "runtime.incomplete_summary",
        workflow_stage: runtime.plan.kanban().current_stage,
        progress: runtime.plan.progress(),
        kanban: runtime.plan.kanban(),
        plan_tree: runtime.plan.snapshot(),
      });
      await platform.send({
        type: "checkpoint_update",
        conversation_id: task.conversationId,
        task_id: task.taskId,
        checkpoint: {
          ...runtime.plan.checkpoint(),
          runtime: "node2-pi",
          tool_names: PENTEST_TOOL_NAMES,
          workflows: runtime.workflowRuns,
          lifecycle: runtime.lifecycle,
          coverage: await runtime.coverage.summary(),
          evidence: await runtime.evidence.list(),
        },
      });
      await platform.send({
        type: "task_incomplete",
        conversation_id: task.conversationId,
        task_id: task.taskId,
        status: "incomplete",
        audit: gate.audit,
        summary: runtime.lifecycle.finishScan?.summary || extractLastAssistantText(session.messages).slice(0, 4000) || gate.summary,
      });
      await platform.send({
        type: "task_complete",
        conversation_id: task.conversationId,
        task_id: task.taskId,
        status: "incomplete",
        summary: runtime.lifecycle.finishScan?.summary || gate.summary,
      });
      return;
    }
    runtime.plan.complete();
    await platform.send({
      type: "checkpoint_update",
      conversation_id: task.conversationId,
      task_id: task.taskId,
      checkpoint: {
        ...runtime.plan.checkpoint(),
        runtime: "node2-pi",
        tool_names: PENTEST_TOOL_NAMES,
        workflows: runtime.workflowRuns,
        lifecycle: runtime.lifecycle,
        coverage: await runtime.coverage.summary(),
        evidence: await runtime.evidence.list(),
      },
    });
    await platform.send({
      type: "plan_tree_updated",
      conversation_id: task.conversationId,
      task_id: task.taskId,
      reason: "runtime.complete",
      workflow_stage: runtime.plan.kanban().current_stage,
      progress: runtime.plan.progress(),
      kanban: runtime.plan.kanban(),
      plan_tree: runtime.plan.snapshot(),
    });
    await platform.send({
      type: "task_complete",
      conversation_id: task.conversationId,
      task_id: task.taskId,
      status: "completed",
      summary: runtime.lifecycle.finishScan?.summary || extractLastAssistantText(session.messages).slice(0, 4000) || "Task completed.",
    });
  } finally {
    await textStream.dispose();
    session.dispose();
    await caidoBridge?.stop();
  }
}

function normalizeSidecarTaskTarget(config: Node2Config, task: TaskEnvelope): TaskEnvelope {
  if (!config.caidoSidecarAutoStart) return task;
  const targetValue = typeof task.target?.value === "string" ? task.target.value : "";
  const normalizedTarget = dockerHostTarget(targetValue);
  if (!normalizedTarget || normalizedTarget === targetValue) return task;
  const scopeAllow = Array.isArray(task.scope?.allow) ? task.scope.allow : [];
  return {
    ...task,
    instruction: [
      task.instruction,
      "",
      `Runtime note: Caido sidecar mode remapped local target ${targetValue} to ${normalizedTarget} so Docker-based proxy tooling can reach the host service. Use the remapped URL for browser/http/traffic/verifier requests.`,
    ].join("\n"),
    target: { ...task.target, value: normalizedTarget, requested_value: targetValue },
    scope: {
      ...task.scope,
      allow: scopeAllow.map((item) => typeof item === "string" && item === targetValue ? normalizedTarget : item),
      requested_allow: scopeAllow,
    },
    snapshot: {
      ...task.snapshot,
      requested_target: targetValue,
      sidecar_target: normalizedTarget,
    },
  };
}

function dockerHostTarget(value: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname)) return value;
    url.hostname = "host.docker.internal";
    return url.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

async function syncWorkflowBundles(config: Node2Config, taskDir: string): Promise<void> {
  if (!(await exists(config.pentestWorkflowsDir))) return;
  await mkdir(join(taskDir, "workflows"), { recursive: true });
  await cp(config.pentestWorkflowsDir, join(taskDir, "workflows"), {
    recursive: true,
    force: true,
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function buildWorkflowFirstInstruction(task: TaskEnvelope): string {
  const scanMode = task.scanMode || "standard";
  return [
    "Use the pi-workflow named \"pentest-web\" as the lightweight scan-first controller for this authorized test.",
    `Scan mode: ${scanMode}. ${scanModeGuidance(scanMode)}`,
    "Call workflow_run with workflow=\"pentest-web\", thinking=\"low\", and a concrete task preserving the target, scope, and user instruction below.",
    "After the workflow returns, do not expand a full vulnerability matrix up front. Read the brief if needed, then immediately perform browser/http reachability, login/session capture, traffic discovery, and coverage seeding with Node2 tools.",
    "Use browser/http/scan output to populate the unified traffic store. If an external traffic source is configured, call traffic(action='source_status') and traffic(action='sync') after browsing/scanning.",
    "Prefer scan for established tools such as httpx, katana, nuclei, nmap, ffuf, sqlmap, dalfox, arjun, wafw00f, and nikto; Node2 runs scanners only through the configured Strix-style scanner sandbox and reports the runner used.",
    "Treat scanner-created pending tests as prioritized leads: verify them with baseline/attack traffic and deterministic verifier/http evidence before finding(confirm).",
    "After recon, call coverage(action='priority_candidates') or coverage(action='conversion') and convert high-priority observed candidates with verifier/scan/poc/traffic(mutate). Do not leave material high-priority rows as observed-only.",
    "Use verifier for supported classes when possible: upload confirmations require a retrievable marker, CSRF requires before/action/after state evidence, brute-force requires invalid/valid credential differential, and JavaScript-logic requires invalid/accepted server-side differential.",
    "As soon as verifier returns confirmed=true with evidence_id, call finding(action='confirm') immediately with that evidence_id and full reproduction details.",
    "Then call traffic(action='analyze') or traffic(action='candidates') and establish baselines with traffic(action='repeat') before mutating requests with traffic(action='mutate').",
    "Choose vulnerability classes only after recon evidence or replayable traffic exists, then use Pi native skills, the PoC catalog, verifier, evidence, coverage, and finding tools.",
    "When reporting is ready, call finish_scan(status='completed', ...) as the final lifecycle action. finish_scan(completed) is rejected while high-priority observed candidates remain untested; use incomplete/blocked if blockers remain.",
    "",
    "Original user instruction:",
    task.instruction || "Run an authorized web penetration test against the target and report confirmed findings, evidence, coverage gaps, and blockers.",
  ].join("\n");
}

function scanModeGuidance(scanMode: string): string {
  if (scanMode === "quick") {
    return "Prioritize reachability, login/session capture, high-signal endpoint discovery, and deterministic checks for the most likely high-impact issues under a tight timebox.";
  }
  if (scanMode === "deep") {
    return "After scan-first recon, broaden endpoint/parameter enumeration, try chained or bypass-oriented checks, and document meaningful negatives without creating broad upfront matrices.";
  }
  return "Run balanced scan-first recon, select plausible vulnerability classes from observed attack surface, and verify findings with deterministic evidence.";
}

function completionGateRounds(): number {
  const raw = Number(process.env.NODE2_COMPLETION_GATE_ROUNDS || DEFAULT_COMPLETION_GATE_ROUNDS);
  if (!Number.isFinite(raw)) return DEFAULT_COMPLETION_GATE_ROUNDS;
  return Math.max(0, Math.min(Math.floor(raw), 8));
}

function completionGate(runtime: ToolRuntime): { canComplete: boolean; audit: Record<string, unknown>; summary: string } {
  const planAudit = runtime.plan.audit();
  const workflowAudit = workflowCompletionAudit(runtime);
  const finishAudit = finishScanAudit(runtime);
  const coverageAudit = coverageCompletionAudit(runtime);
  const summary = [planAudit.summary, workflowAudit.summary, finishAudit.summary, coverageAudit.summary].filter(Boolean).join("; ");
  return {
    canComplete: planAudit.canComplete && workflowAudit.canComplete && finishAudit.canComplete && coverageAudit.canComplete,
    audit: {
      ...planAudit,
      workflow: workflowAudit,
      finish_scan: finishAudit,
      coverage: coverageAudit,
      summary,
    },
    summary,
  };
}

function coverageCompletionAudit(runtime: ToolRuntime): {
  canComplete: boolean;
  summary: string;
  unresolved: unknown[];
  conversion?: unknown;
} {
  const rows = runtime.coverage.listSync?.() || [];
  const untested = materialUntestedHighPriority(rows);
  const metrics = conversionMetrics(rows);
  if (!untested.length) {
    return {
      canComplete: true,
      summary: "high-priority coverage candidates resolved or absent",
      unresolved: [],
      conversion: metrics,
    };
  }
  return {
    canComplete: false,
    summary: `${untested.length} high-priority observed candidate(s) still need verifier/scan/poc or blocked/skipped notes`,
    unresolved: untested.slice(0, 20).map(formatCandidate),
    conversion: metrics,
  };
}

function finishScanAudit(runtime: ToolRuntime): { canComplete: boolean; summary: string; finishScan?: unknown } {
  const finishScan = runtime.lifecycle.finishScan;
  if (!finishScan) return { canComplete: false, summary: "finish_scan has not been called" };
  if (finishScan.status !== "completed") {
    return {
      canComplete: false,
      summary: `finish_scan requested ${finishScan.status}`,
      finishScan,
    };
  }
  const rows = runtime.coverage.listSync?.() || [];
  const eligibility = finishCompletedEligibility(rows, { status: "completed" });
  if (!eligibility.allowed) {
    return {
      canComplete: false,
      summary: eligibility.reason,
      finishScan,
    };
  }
  return {
    canComplete: true,
    summary: "finish_scan completed",
    finishScan,
  };
}

function workflowCompletionAudit(runtime: ToolRuntime): { canComplete: boolean; summary: string; runs: unknown[] } {
  const runs = runtime.workflowRuns.filter((run) => run.specPath?.includes("pentest-web") || !run.specPath);
  const completed = runs.some((run) => run.status === "completed");
  if (completed) return { canComplete: true, summary: "pentest-web workflow completed", runs };
  if (runs.length === 0) return { canComplete: false, summary: "pentest-web workflow has not run", runs };
  return {
    canComplete: false,
    summary: `pentest-web workflow did not complete; latest status=${runs[runs.length - 1]?.status || "unknown"}`,
    runs,
  };
}

function completionGapPrompt(runtime: ToolRuntime, gate: { audit: Record<string, unknown>; summary: string }): string {
  const workflow = gate.audit.workflow as { canComplete?: boolean; summary?: string } | undefined;
  const finishScan = gate.audit.finish_scan as { canComplete?: boolean; summary?: string } | undefined;
  const coverage = gate.audit.coverage as { canComplete?: boolean; summary?: string; unresolved?: any[] } | undefined;
  const parts = [runtime.plan.gapPrompt()];
  if (workflow && !workflow.canComplete) {
    parts.push(
      [
        "",
        "The mandatory pentest-web pi-workflow completion gate is still unresolved.",
        workflow.summary || "pentest-web workflow has not completed.",
        "Run workflow_run with workflow=\"pentest-web\", thinking=\"low\", and a concrete scoped task, wait for it to complete, then execute its brief with Node2 tools before summarizing.",
      ].join("\n"),
    );
  }
  if (finishScan && !finishScan.canComplete) {
    parts.push(
      [
        "",
        "The mandatory finish_scan lifecycle gate is still unresolved.",
        finishScan.summary || "finish_scan has not been called.",
        "After resolving any remaining runtime blockers, call finish_scan with status='completed' and include summary, confirmed_findings, coverage_gaps, blockers, and evidence_ids. If blockers remain, call finish_scan with status='incomplete' or status='blocked'.",
      ].join("\n"),
    );
  }
  if (coverage && !coverage.canComplete) {
    const unresolved = Array.isArray(coverage.unresolved) ? coverage.unresolved.slice(0, 12) : [];
    const rows = runtime.coverage.listSync?.() || [];
    const untested = materialUntestedHighPriority(rows);
    parts.push(
      [
        "",
        "Coverage conversion gate still has high-priority observed candidates without verification.",
        coverage.summary || "Unresolved high-priority coverage remains.",
        nextVerifyGuidance(untested),
        "For each high-value item, run verifier/scan/poc/traffic(mutate) and either finding(confirm) with evidence, or mark coverage as tried/passed/failed/blocked/skipped with a concrete reason. finish_scan(status='completed') is rejected while these remain observed-only.",
        ...unresolved.map((row) => `- ${typeof row === "string" ? row : formatCandidate(row as any)}`),
      ].join("\n"),
    );
  }
  return parts.join("\n");
}

async function handleSessionEvent(platform: PlatformSink, runtime: ToolRuntime, event: any): Promise<void> {
  if (event.type === "turn_start") {
    await platform.send({
      type: "status_update",
      conversation_id: runtime.task.conversationId,
      task_id: runtime.task.taskId,
      workflow_stage: runtime.plan.kanban().current_stage,
      active_tool: "pi",
      status: "running",
      progress: runtime.plan.progress(),
      kanban: runtime.plan.kanban(),
    } as PlatformMessage);
  }
  if (event.type === "agent_end") {
    await platform.send({
      type: "plan_tree_updated",
      conversation_id: runtime.task.conversationId,
      task_id: runtime.task.taskId,
      reason: "agent.end",
      workflow_stage: runtime.plan.kanban().current_stage,
      progress: runtime.plan.progress(),
      kanban: runtime.plan.kanban(),
      plan_tree: runtime.plan.snapshot(),
    } as PlatformMessage);
  }
  if (event.type === "message_end" && event.message?.role === "assistant" && event.message.stopReason === "error") {
    await platform.send({
      type: "model_error",
      conversation_id: runtime.task.conversationId,
      task_id: runtime.task.taskId,
      message: event.message.errorMessage || "Assistant model returned an error.",
      workflow_stage: runtime.plan.kanban().current_stage,
      progress: runtime.plan.progress(),
      kanban: runtime.plan.kanban(),
    } as PlatformMessage);
  }
}

function setRuntimeApiKey(authStorage: any, provider: string): void {
  const key = providerKey(provider);
  if (key) authStorage.setRuntimeApiKey(provider as any, key);
}

function providerKey(provider: string): string {
  const normalized = provider.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  return process.env[`${normalized}_API_KEY`] || process.env.LLM_API_KEY || "";
}

class PlatformTextStream {
  private sequence = 0;
  private streamId = "";
  private text = "";
  private lastSentText = "";
  private timer: NodeJS.Timeout | undefined;
  private sending: Promise<void> = Promise.resolve();

  constructor(
    private readonly platform: PlatformSink,
    private readonly task: TaskEnvelope,
  ) {}

  async handle(event: any): Promise<void> {
    if (event.type === "message_start" && event.message?.role === "assistant") {
      this.startStream();
      this.text = assistantText(event.message);
      await this.scheduleFlush();
      return;
    }

    if (event.type === "message_update" && event.message?.role === "assistant") {
      if (!this.streamId) this.startStream();
      if (event.assistantMessageEvent?.type === "text_delta") {
        this.text += String(event.assistantMessageEvent.delta || "");
      } else {
        this.text = assistantText(event.message) || this.text;
      }
      await this.scheduleFlush();
      return;
    }

    if (event.type === "message_end" && event.message?.role === "assistant") {
      if (!this.streamId) this.startStream();
      this.text = assistantText(event.message) || this.text;
      await this.flush();
      this.streamId = "";
      this.text = "";
      this.lastSentText = "";
    }
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (!this.streamId || !this.text || this.text === this.lastSentText) return this.sending;

    const text = this.text;
    const streamId = this.streamId;
    this.lastSentText = text;
    this.sending = this.sending.then(() =>
      this.platform.send({
        type: "text",
        conversation_id: this.task.conversationId,
        task_id: this.task.taskId,
        content: { text, stream_id: streamId },
      } as PlatformMessage),
    );
    return this.sending;
  }

  async dispose(): Promise<void> {
    await this.flush();
  }

  private startStream(): void {
    this.sequence += 1;
    this.streamId = `${this.task.taskId}:assistant:${this.sequence}`;
    this.text = "";
    this.lastSentText = "";
  }

  private async scheduleFlush(): Promise<void> {
    if (this.timer || !this.streamId || !this.text) return;
    this.timer = setTimeout(() => {
      void this.flush();
    }, TEXT_STREAM_FLUSH_MS);
  }
}

function assistantText(message: any): string {
  if (!message || !Array.isArray(message.content)) return "";
  return message.content
    .filter((item: any) => item?.type === "text")
    .map((item: any) => String(item.text || ""))
    .join("\n");
}

function registerCustomModel(modelRegistry: ModelRegistry, config: Node2Config): void {
  if (!config.llmBaseUrl) {
    throw new Error("LLM_BASE_URL is required when PI_MODEL_PROVIDER=custom");
  }

  modelRegistry.registerProvider("custom", {
    name: "Custom LLM",
    baseUrl: config.llmBaseUrl,
    api: (config.llmApi || "openai-completions") as any,
    apiKey: "$LLM_API_KEY",
    models: [
      {
        id: config.modelId,
        name: config.modelId,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: Number(process.env.LLM_CONTEXT_WINDOW || 128000),
        maxTokens: Number(process.env.LLM_MAX_TOKENS || 8192),
      },
    ],
  });
}

function extractLastAssistantText(messages: any[]): string {
  for (const message of [...messages].reverse()) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    return message.content
      .filter((item: any) => item.type === "text")
      .map((item: any) => item.text || "")
      .join("\n")
      .trim();
  }
  return "";
}

function throwIfLastAssistantError(messages: any[]): void {
  for (const message of [...messages].reverse()) {
    if (message.role !== "assistant") continue;
    if (message.stopReason === "error") {
      throw new Error(`Model error: ${message.errorMessage || "assistant stopped with error"}`);
    }
    return;
  }
}
