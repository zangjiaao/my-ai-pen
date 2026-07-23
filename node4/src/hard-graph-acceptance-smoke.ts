/**
 * Hard Graph first-cut acceptance smoke (dual-segment).
 *
 * Contract: https://github.com/zangjiaao/my-ai-pen/issues/25
 * Map: https://github.com/zangjiaao/my-ai-pen/issues/24
 *
 * Usage (from node4/, with model env loaded):
 *   npm run smoke:hard-graph-acceptance
 *
 * Env (existing node4 model config):
 *   PI_MODEL_PROVIDER, PI_MODEL, and provider API key
 *   (DEEPSEEK_API_KEY | OPENAI_API_KEY | ANTHROPIC_API_KEY | LLM_API_KEY)
 *
 * Exit codes (X1):
 *   0 — Segment A + B both pass
 *   2 — missing API key / model not configured
 *   3 — Segment A (live init) failed after retries
 *   4 — Segment B (fail-closed) did not block as expected
 *   1 — other error
 *
 * Not in default CI. Manual / key-bearing acceptance for Spec #15.
 */
import { access, mkdir, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadConfig } from "./config.js";
import { loadDotEnv } from "./env.js";
import { loadPackFromDirSync } from "./experts/load-pack.js";
import { catalogPackDir } from "./experts/paths.js";
import {
  loadHardGraphFile,
  type HardGraphDefinition,
} from "./runtime/hard-graph-definition.js";
import {
  runHardGraph,
  type HardGraphStageEvent,
  type StageExecutor,
} from "./runtime/hard-graph-runner.js";
import { createPiHardGraphStageExecutor } from "./runtime/hard-graph-stage-executor.js";
import { EvidenceStore } from "./stores/evidence.js";
import { GoalStore } from "./stores/goal.js";
import { TodoStore } from "./stores/todo.js";
import type { PlatformMessage, PlatformSink, TaskEnvelope, ToolRuntime } from "./types.js";
import { toolNamesForPack } from "./tools/index.js";

loadDotEnv();
loadDotEnv("node4/.env");

const EXIT = {
  ok: 0,
  other: 1,
  noKey: 2,
  segmentA: 3,
  segmentB: 4,
} as const;

function log(line: string): void {
  console.log(`[hard-graph-acceptance] ${line}`);
}

function hasProviderApiKey(provider: string): boolean {
  const p = String(provider || "").trim().toLowerCase();
  if (p === "deepseek") {
    return Boolean(process.env.DEEPSEEK_API_KEY || process.env.LLM_API_KEY);
  }
  if (p === "openai") {
    return Boolean(process.env.OPENAI_API_KEY || process.env.LLM_API_KEY);
  }
  if (p === "anthropic") {
    return Boolean(process.env.ANTHROPIC_API_KEY || process.env.LLM_API_KEY);
  }
  return Boolean(
    process.env.LLM_API_KEY ||
      process.env.OPENAI_API_KEY ||
      process.env.DEEPSEEK_API_KEY ||
      process.env.ANTHROPIC_API_KEY,
  );
}

function makeLoggingPlatform(messages: PlatformMessage[]): PlatformSink {
  return {
    async send(message: PlatformMessage): Promise<void> {
      messages.push(message);
      if (message.type === "status_update" || message.type === "work_status") {
        const hg = (message as { hard_graph?: unknown }).hard_graph;
        const wm = (message as { work_mode?: unknown }).work_mode;
        const msg = (message as { message?: unknown }).message;
        log(
          `${message.type} work_mode=${wm ?? ""} ${msg ? `msg=${String(msg).slice(0, 160)}` : ""}` +
            (hg ? ` hard_graph=${JSON.stringify(hg).slice(0, 240)}` : ""),
        );
      }
    },
  };
}

function initOnlyGraph(full: HardGraphDefinition): HardGraphDefinition {
  const init = full.stages.find((s) => s.id === "init");
  if (!init) {
    throw new Error("app_assessment_thin missing init stage");
  }
  return {
    ...full,
    id: full.id,
    label: `${full.label} (acceptance: init only)`,
    stages: [init],
  };
}

/** Mini hard graph for deterministic fail-closed (Segment B). */
function failClosedProbeGraph(): HardGraphDefinition {
  return {
    discipline: "hard",
    id: "acceptance_fail_closed_probe",
    label: "Acceptance fail-closed probe",
    stages: [
      {
        id: "surface_gate",
        success: "Must record at least one surface (will fail closed in smoke)",
        require: { summary: true, surfaces_min: 1 },
        // max_retries 1 → attempt1 failed_attempt, attempt2 blocked
        max_retries: 1,
        tools: { allow: ["todo", "read", "fact"] },
      },
    ],
  };
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function segmentA(options: {
  config: ReturnType<typeof loadConfig>;
  taskDir: string;
  packRoot: string;
  pack: ReturnType<typeof loadPackFromDirSync>;
}): Promise<{ ok: true; events: HardGraphStageEvent[] } | { ok: false; reason: string }> {
  const { config, taskDir, packRoot, pack } = options;
  const full = await loadHardGraphFile(packRoot, "app_assessment_thin");
  if (!full) {
    return { ok: false, reason: "could not load app_assessment_thin" };
  }
  const graph = initOnlyGraph(full);

  const task: TaskEnvelope = {
    taskId: `accept-a-${Date.now().toString(36)}`,
    conversationId: "hard-graph-acceptance",
    instruction:
      "Hard Graph acceptance Segment A: complete the init stage only. " +
      "Summarize target and RoE; write structured result with a non-empty summary. " +
      "Do not attempt recon beyond init tools.",
    target: { type: "url", value: "http://127.0.0.1:9/acceptance-placeholder" },
    scope: { allow: ["http://127.0.0.1:9/acceptance-placeholder"] },
    engagement: "pentest",
    graphId: "app_assessment_thin",
    graphDiscipline: "hard",
  };

  const messages: PlatformMessage[] = [];
  const platform = makeLoggingPlatform(messages);
  const parentRuntime = {
    task,
    workspaceDir: taskDir,
    taskDir,
    platform,
    todo: new TodoStore(),
    evidence: new EvidenceStore(join(taskDir, "evidence")),
    findingsDir: join(taskDir, "findings"),
    goals: new GoalStore(),
    rolePackId: pack.id,
    skillIds: pack.skillIds,
    lifecycle: { toolsInLastSegment: 0, subagentDepth: 0, recentObservations: [] },
  } as ToolRuntime;

  const executeStage = createPiHardGraphStageExecutor({
    config,
    parentRuntime,
    pack,
  });
  const availableTools = toolNamesForPack(pack);
  const events: HardGraphStageEvent[] = [];

  const result = await runHardGraph({
    graph,
    executeStage,
    availableTools,
    onEvent: async (e) => {
      events.push(e);
      if (e.type === "stage_start") {
        log(`A stage_start stage=${e.stageId} attempt=${e.attempt}`);
      } else if (e.type === "stage_end") {
        log(
          `A stage_end stage=${e.stageId} attempt=${e.attempt} outcome=${e.outcome}` +
            (e.errors?.length ? ` errors=${e.errors.join(",")}` : ""),
        );
      } else if (e.type === "run_end") {
        log(`A run_end terminal=${e.terminal}`);
      }
    },
  });

  await writeFile(
    join(taskDir, "hard-graph", "segment-a-run-result.json"),
    JSON.stringify({ result, events }, null, 2),
    "utf8",
  );

  const initPassed = events.some(
    (e) =>
      e.type === "stage_end" && e.stageId === "init" && e.outcome === "passed",
  );
  const initStarted = events.some(
    (e) => e.type === "stage_start" && e.stageId === "init",
  );

  const stageDir = join(taskDir, "hard-graph", graph.id, "stage-0-init");
  const stageDirOk = await pathExists(stageDir);
  let hasPiTrace = false;
  if (stageDirOk) {
    try {
      const names = await readdir(stageDir);
      hasPiTrace =
        names.length > 0 ||
        (await pathExists(join(stageDir, "pi-sessions"))) ||
        (await pathExists(join(stageDir, "result.json")));
    } catch {
      hasPiTrace = false;
    }
  }

  log(
    `A checks: initStarted=${initStarted} initPassed=${initPassed} ` +
      `terminal=${result.terminal} stageDir=${stageDirOk} piTrace=${hasPiTrace}`,
  );

  if (
    initStarted &&
    initPassed &&
    result.terminal === "completed" &&
    stageDirOk &&
    hasPiTrace
  ) {
    return { ok: true, events };
  }

  return {
    ok: false,
    reason:
      `initStarted=${initStarted} initPassed=${initPassed} terminal=${result.terminal} ` +
      `stageDir=${stageDirOk} piTrace=${hasPiTrace}`,
  };
}

async function segmentB(taskDir: string): Promise<
  { ok: true } | { ok: false; reason: string }
> {
  const graph = failClosedProbeGraph();
  const events: HardGraphStageEvent[] = [];
  const fakeBadSurfaces: StageExecutor = async () => ({
    structured: {
      ok: true,
      summary: "looked around (acceptance smoke controlled miss)",
      surfaces: [],
      candidates: [],
    },
  });

  const result = await runHardGraph({
    graph,
    executeStage: fakeBadSurfaces,
    availableTools: ["todo", "read", "fact", "shell", "http"],
    onEvent: async (e) => {
      events.push(e);
      if (e.type === "stage_end") {
        log(
          `B stage_end stage=${e.stageId} attempt=${e.attempt} outcome=${e.outcome} ` +
            `errors=${(e.errors || []).join(",")}`,
        );
      } else if (e.type === "run_end") {
        log(`B run_end terminal=${e.terminal}`);
      }
    },
  });

  await writeFile(
    join(taskDir, "hard-graph", "segment-b-run-result.json"),
    JSON.stringify({ result, events }, null, 2),
    "utf8",
  );

  const failedAttempt = events.some(
    (e) =>
      e.type === "stage_end" &&
      e.stageId === "surface_gate" &&
      e.outcome === "failed_attempt" &&
      (e.errors || []).some((err) => err.startsWith("surfaces_min")),
  );
  const blocked = events.some(
    (e) =>
      e.type === "stage_end" &&
      e.stageId === "surface_gate" &&
      e.outcome === "blocked" &&
      (e.errors || []).some((err) => err.startsWith("surfaces_min")),
  );
  const terminalBlocked = result.terminal === "blocked";

  log(
    `B checks: failed_attempt=${failedAttempt} blocked=${blocked} terminal=${result.terminal}`,
  );

  if (failedAttempt && blocked && terminalBlocked) {
    return { ok: true };
  }
  return {
    ok: false,
    reason: `failed_attempt=${failedAttempt} blocked=${blocked} terminal=${result.terminal}`,
  };
}

async function main(): Promise<void> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const config = loadConfig();
  // Isolate acceptance artifacts under workspace (or NODE4_WORKSPACE)
  const taskDir = resolve(
    config.workspaceDir,
    "hard-graph-acceptance",
    stamp,
  );
  await mkdir(join(taskDir, "hard-graph"), { recursive: true });
  await mkdir(join(taskDir, "findings"), { recursive: true });

  log(`provider=${config.modelProvider} model=${config.modelId}`);
  log(`taskDir=${taskDir}`);
  log("command=npm run smoke:hard-graph-acceptance (dedicated entry; not CI)");

  if (!hasProviderApiKey(config.modelProvider)) {
    log("FAIL: missing provider API key (exit 2)");
    process.exit(EXIT.noKey);
  }

  const packRoot = catalogPackDir("pentest");
  const pack = loadPackFromDirSync(packRoot);

  // --- Segment A: real pi + real LLM, init only (F1: one retry) ---
  log("=== Segment A: live init (max 2 attempts) ===");
  let aOk = false;
  let aReason = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    log(`Segment A attempt ${attempt}/2`);
    try {
      const a = await segmentA({ config, taskDir, packRoot, pack });
      if (a.ok) {
        aOk = true;
        break;
      }
      aReason = a.reason;
      log(`Segment A attempt ${attempt} failed: ${a.reason}`);
    } catch (err) {
      aReason = err instanceof Error ? err.message : String(err);
      log(`Segment A attempt ${attempt} threw: ${aReason}`);
    }
  }
  if (!aOk) {
    log(`FAIL Segment A: ${aReason} (exit 3)`);
    process.exit(EXIT.segmentA);
  }
  log("PASS Segment A");

  // --- Segment B: deterministic fail-closed ---
  log("=== Segment B: fail-closed surfaces_min ===");
  try {
    const b = await segmentB(taskDir);
    if (!b.ok) {
      log(`FAIL Segment B: ${b.reason} (exit 4)`);
      process.exit(EXIT.segmentB);
    }
  } catch (err) {
    log(`FAIL Segment B threw: ${err instanceof Error ? err.message : String(err)} (exit 4)`);
    process.exit(EXIT.segmentB);
  }
  log("PASS Segment B");

  const summary = {
    exit: 0,
    provider: config.modelProvider,
    model: config.modelId,
    taskDir,
    segmentA: "pass",
    segmentB: "pass",
    artifacts: {
      segmentA: join(taskDir, "hard-graph", "segment-a-run-result.json"),
      segmentB: join(taskDir, "hard-graph", "segment-b-run-result.json"),
    },
  };
  await writeFile(
    join(taskDir, "hard-graph", "acceptance-summary.json"),
    JSON.stringify(summary, null, 2),
    "utf8",
  );
  log(`PASS both segments exit=0 summary=${JSON.stringify(summary)}`);
  process.exit(EXIT.ok);
}

main().catch((err) => {
  console.error(err);
  process.exit(EXIT.other);
});
