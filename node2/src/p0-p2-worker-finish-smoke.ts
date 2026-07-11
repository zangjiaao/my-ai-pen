/**
 * P0–P2 smoke: authoritative finish findings, worker usage merge, package gate, events.
 * No live LLM required.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  aggregateConfirmedFindings,
  alignSummaryFindingCount,
  findingDedupeKey,
  loadAggregatedConfirmedFindings,
} from "./runtime/findings-aggregate.js";
import {
  LlmUsageLedger,
  mergeLlmUsageSnapshots,
} from "./runtime/llm-usage.js";
import { TaskDiagnostics } from "./runtime/agent-observability.js";
import {
  assessWorkerDispatchGate,
  assessWorkerTaskNarrowness,
  parseWorkPackagesFromControl,
  planWorkerAutoDispatch,
  loadWorkPackagesFromTaskDir,
} from "./runtime/work-packages.js";
import {
  assessOpenWorkerPackageGate,
  recordOpenWorkerPackage,
  resolveOpenWorkerPackagesForSuccess,
  unresolvedWorkerPackages,
} from "./runtime/worker-packages.js";
import { createFinishScanTool } from "./tools/finish.js";
import { createWorkerTool } from "./tools/worker.js";
import { ActorStore } from "./stores/actors.js";
import { CoverageStore } from "./stores/coverage.js";
import { EvidenceStore } from "./stores/evidence.js";
import { PlanStore } from "./stores/plan.js";
import { TrafficStore } from "./stores/traffic.js";
import type { PlatformMessage, PlatformSink, ToolRuntime } from "./types.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function parseJsonResult(result: any): any {
  const content = Array.isArray(result?.content) ? result.content : [];
  const text = content.map((c: any) => String(c?.text || "")).join("\n");
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text };
  }
}

// --- P0: pure aggregate + strong class/endpoint dedupe ---
const raw = aggregateConfirmedFindings([
  {
    action: "confirm",
    title: "SQL Injection in /rest/products/search",
    severity: "high",
    location: "http://host.docker.internal:3000/rest/products/search?q=",
    evidence_ids: ["ev-1"],
  },
  {
    action: "confirm",
    title: "SQLi on product search",
    severity: "medium",
    location: "/rest/products/search?q=",
    evidence_ids: ["ev-1", "ev-2"],
  },
  {
    action: "confirm",
    title: "SQL Injection - Full Users Table Extraction via UNION SELECT",
    severity: "critical",
    location: "GET /rest/products/search, parameter q",
    evidence_ids: ["ev-9"],
  },
  {
    action: "confirm",
    title: "SQL Injection in POST /rest/user/login email parameter",
    severity: "critical",
    location: "POST /rest/user/login",
    evidence_ids: ["ev-login-1"],
  },
  {
    action: "confirm",
    title: "SQL Injection in POST /rest/user/login (email parameter) - Authentication Bypass",
    severity: "critical",
    location: "http://host.docker.internal:3000/rest/user/login",
    evidence_ids: ["ev-login-2"],
  },
  {
    action: "candidate",
    title: "Maybe XSS",
    severity: "low",
    location: "/contact",
  },
  {
    action: "confirm",
    title: "IDOR on basket",
    severity: "high",
    location: "/api/BasketItems/1",
    evidence_ids: ["ev-3"],
  },
]);
assert(raw.rawCount === 6, `rawCount=${raw.rawCount}`);
// search SQLi x3 + login SQLi x2 + idor x1 → 3 independent
assert(raw.dedupedCount === 3, `dedupedCount=${raw.dedupedCount} titles=${raw.titles.join("|")}`);
const keys = new Set(
  [
    findingDedupeKey({
      action: "confirm",
      title: "SQL Injection in /rest/products/search",
      location: "http://host.docker.internal:3000/rest/products/search?q=",
    }),
    findingDedupeKey({
      action: "confirm",
      title: "SQL Injection in POST /rest/user/login email parameter",
      location: "POST /rest/user/login",
    }),
    findingDedupeKey({
      action: "confirm",
      title: "IDOR on basket",
      location: "/api/BasketItems/1",
    }),
  ],
);
assert(keys.size === 3, `expected 3 families, got ${[...keys].join(" | ")}`);
// Keys are kind|class|family (vuln/flag/auth are independent objects).
assert([...keys].some((k) => k === "vuln|sqli|search"), `search key missing: ${[...keys]}`);
assert([...keys].some((k) => k === "vuln|sqli|login"), `login key missing: ${[...keys]}`);
assert([...keys].some((k) => k.startsWith("vuln|idor|")), `idor key missing: ${[...keys]}`);
assert(raw.evidenceIds.includes("ev-9") || raw.evidenceIds.includes("ev-2"), "evidence merged for search");
assert(
  findingDedupeKey({
    title: "SQL Injection",
    location: "/rest/products/search",
    severity: "high",
  }).startsWith("vuln|sqli|"),
  "dedupe class hint",
);
assert(
  findingDedupeKey({
    title: "Captured flag",
    finding_kind: "flag",
    location: "/rest/products/search",
    description: "flag{example}",
  }).startsWith("flag|"),
  "flag object must not share vuln dedupe key",
);

const aligned = alignSummaryFindingCount("**12 confirmed vulnerabilities** across the app. 12 findings confirmed.", 3);
assert(/\*\*3 confirmed vulnerabilities\*\*/.test(aligned), `aligned summary: ${aligned}`);
assert(/3 findings confirmed/.test(aligned), `aligned findings confirmed: ${aligned}`);

// --- P1: usage merge pure ---
const merged = mergeLlmUsageSnapshots(
  [
    {
      requests: 2,
      input_tokens: 1000,
      output_tokens: 200,
      cached_tokens: 50,
      cache_write_tokens: 0,
      reasoning_tokens: 10,
      total_tokens: 1260,
      cost: 0.01,
      agent_count: 1,
      tool_calls: 5,
    },
    {
      requests: 1,
      input_tokens: 500,
      output_tokens: 100,
      cached_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      total_tokens: 600,
      cost: 0.005,
      agent_count: 1,
      tool_calls: 3,
    },
  ],
  { agent_count: 2 },
);
assert(merged.requests === 3, `merged requests=${merged.requests}`);
assert(merged.total_tokens === 1860, `merged total=${merged.total_tokens}`);
assert(merged.agent_count === 2, `merged agents=${merged.agent_count}`);
assert(Math.abs(merged.cost - 0.015) < 1e-9, `merged cost=${merged.cost}`);

const ledger = new LlmUsageLedger();
ledger.recordAssistantMessage({
  role: "assistant",
  model: "m",
  usage: { input: 100, output: 50, totalTokens: 150, cost: { total: 0.001 } },
});
ledger.mergeSnapshot({
  requests: 2,
  input_tokens: 300,
  output_tokens: 100,
  cached_tokens: 0,
  cache_write_tokens: 0,
  reasoning_tokens: 0,
  total_tokens: 400,
  cost: 0.002,
  agent_count: 1,
});
const snap = ledger.snapshot({ agent_count: 2 });
assert(snap.requests === 3, `ledger requests=${snap.requests}`);
assert(snap.total_tokens === 550, `ledger total=${snap.total_tokens}`);

// --- P2: package gate pure ---
const packages = parseWorkPackagesFromControl({
  workPackages: [
    { id: "wp-recon", role: "recon", task: "Map API surface", priority: 2 },
    { id: "wp-idor", role: "access-control", task: "Dual-actor basket IDOR", priority: 1 },
  ],
});
assert(packages.length === 2, `packages=${packages.length}`);
const plan = planWorkerAutoDispatch(packages);
assert(plan[0].packageId === "wp-recon", "priority sort");
assert(
  !assessWorkerDispatchGate({ packages, workerRunCount: 0, status: "completed", engagement: "assess" }).allowed,
  "zero workers must block completed assess",
);
assert(
  assessWorkerDispatchGate({ packages, workerRunCount: 1, status: "completed", engagement: "assess" }).allowed,
  "one worker allows",
);
assert(
  assessWorkerDispatchGate({ packages, workerRunCount: 0, status: "incomplete", engagement: "assess" }).allowed,
  "incomplete always allowed",
);
assert(
  assessWorkerDispatchGate({ packages, workerRunCount: 0, status: "completed", engagement: "verify" }).allowed,
  "verify skips package gate",
);
assert(
  assessWorkerDispatchGate({ packages: [], workerRunCount: 0, status: "completed", engagement: "assess" }).allowed,
  "no packages means no gate",
);

// Narrow package heuristic (no target-specific lists)
assert(
  assessWorkerTaskNarrowness("Dual-actor IDOR on /api/BasketItems only").ok,
  "single-endpoint package should pass",
);
assert(
  assessWorkerTaskNarrowness(
    "【L8 越权 · 4个挑战 + L5-2 存储型XSS】/level8/login.php /level8/profile.php /level8/admin_delete.php /level5/stored.php",
  ).ok === false,
  "multi-surface mega-package should be rejected",
);
assert(
  assessWorkerTaskNarrowness("Verify captcha on /login_captcha.php and /captcha_response.php only").ok,
  "two endpoints should still pass",
);

// Open worker package gate (timeout backlog)
const life: { openWorkerPackages?: any[] } = {};
recordOpenWorkerPackage(life as any, {
  workerId: "worker-general-1",
  role: "general",
  task: "Test remaining levels L3-L9 /level8/login.php",
  outcome: "timeout",
  maxTimeoutRetries: 2,
});
assert(unresolvedWorkerPackages(life as any).length === 1, "one open package");
assert(unresolvedWorkerPackages(life as any)[0]?.outcome === "timeout", "first timeout stays timeout");
assert(
  !assessOpenWorkerPackageGate({
    engagement: "assess",
    status: "completed",
    openPackages: unresolvedWorkerPackages(life as any),
  }).allowed,
  "open timeout package must block completed",
);
assert(
  assessOpenWorkerPackageGate({
    engagement: "assess",
    status: "incomplete",
    openPackages: unresolvedWorkerPackages(life as any),
  }).allowed,
  "incomplete allows open packages",
);
// Cross-role path overlap resolve (general re-dispatch clears access debt).
const life2: { openWorkerPackages?: any[] } = {};
recordOpenWorkerPackage(life2 as any, {
  workerId: "worker-access-1",
  role: "access-control",
  task: "L8 /level8/admin_delete.php vertical priv",
  outcome: "timeout",
  maxTimeoutRetries: 2,
});
const cross = resolveOpenWorkerPackagesForSuccess(life2 as any, {
  role: "general",
  task: "retry /level8/admin_delete.php only",
  note: "cross-role ok",
});
assert(cross.count === 1, "path-overlap resolves across roles");
assert(unresolvedWorkerPackages(life2 as any).length === 0, "resolved after cross-role success");

// Timeout retry exhaustion → failed + advice
const life3: { openWorkerPackages?: any[] } = {};
let last = recordOpenWorkerPackage(life3 as any, {
  workerId: "w1",
  role: "xss",
  task: "/level5/stored.php stored xss",
  outcome: "timeout",
  maxTimeoutRetries: 1,
});
assert(last.pkg.outcome === "timeout" && !last.escalatedToFailed, "1st timeout not exhausted");
last = recordOpenWorkerPackage(life3 as any, {
  workerId: "w2",
  role: "xss",
  task: "/level5/stored.php stored xss narrower",
  outcome: "timeout",
  maxTimeoutRetries: 1,
});
// attempts 2, limit = 1+1 = 2 → escalate
assert(last.escalatedToFailed || last.pkg.outcome === "failed", "2nd timeout with maxRetries=1 escalates");
assert(String(last.pkg.advice || last.advice || "").includes("Adjustment"), "advice present");

resolveOpenWorkerPackagesForSuccess(life as any, { role: "general", note: "re-dispatched ok" });
assert(unresolvedWorkerPackages(life as any).length === 0, "resolved after success");
assert(
  assessOpenWorkerPackageGate({
    engagement: "assess",
    status: "completed",
    openPackages: unresolvedWorkerPackages(life as any),
  }).allowed,
  "cleared packages allow completed",
);

// --- Integration: finish loads disk findings; package gate ---
const workspaceDir = resolve("tmp", "node2-p0-p2-smoke");
const taskId = `p0p2-${randomUUID()}`;
const taskDir = resolve(workspaceDir, taskId);
const findingsDir = resolve(taskDir, "findings");
const evidenceDir = resolve(taskDir, "evidence");
await mkdir(findingsDir, { recursive: true });
await mkdir(evidenceDir, { recursive: true });
await mkdir(resolve(taskDir, ".pi", "workflows", "stage-1"), { recursive: true });

const events: PlatformMessage[] = [];
const sink: PlatformSink = {
  async send(message) {
    events.push(message);
  },
};

const evidence = new EvidenceStore(evidenceDir);
const ev1 = await evidence.create({
  type: "tool_output",
  sourceTool: "http",
  summary: "sqli proof",
  data: { ok: true },
});
const ev2 = await evidence.create({
  type: "tool_output",
  sourceTool: "verifier",
  summary: "idor proof",
  data: { ok: true },
});

await writeFile(
  resolve(findingsDir, "sqli-1.json"),
  JSON.stringify({
    action: "confirm",
    title: "SQL Injection in search",
    severity: "high",
    location: "/rest/products/search",
    evidence_ids: [ev1.id],
    created_at: new Date().toISOString(),
  }),
  "utf8",
);
await writeFile(
  resolve(findingsDir, "sqli-2.json"),
  JSON.stringify({
    action: "confirm",
    title: "SQLi product search",
    severity: "medium",
    location: "/rest/products/search",
    evidence_ids: [ev1.id],
    created_at: new Date().toISOString(),
  }),
  "utf8",
);
await writeFile(
  resolve(findingsDir, "idor-1.json"),
  JSON.stringify({
    action: "confirm",
    title: "IDOR basket items",
    severity: "high",
    location: "/api/BasketItems/1",
    evidence_ids: [ev2.id],
    created_at: new Date().toISOString(),
  }),
  "utf8",
);

const diskAgg = await loadAggregatedConfirmedFindings(findingsDir);
assert(diskAgg.rawCount === 3, `disk raw=${diskAgg.rawCount}`);
assert(diskAgg.dedupedCount === 2, `disk deduped=${diskAgg.dedupedCount}`);

await writeFile(
  resolve(taskDir, ".pi", "workflows", "stage-1", "control.json"),
  JSON.stringify({
    workPackages: [{ id: "wp-1", role: "injection", task: "Probe login and search for injection" }],
  }),
  "utf8",
);
const loadedPkgs = await loadWorkPackagesFromTaskDir(taskDir);
assert(loadedPkgs.length === 1, `loaded packages=${loadedPkgs.length}`);

// Empty coverage: assess conversion gates pass (nothing untested); package gate is under test.
const runtime: ToolRuntime = {
  task: {
    taskId,
    conversationId: taskId,
    instruction: "assess target",
    engagement: "assess",
    target: { type: "url", value: "http://127.0.0.1:9" },
    scope: { allow: ["http://127.0.0.1:9"] },
    snapshot: {},
  },
  workspaceDir,
  platform: sink,
  plan: new PlanStore(),
  coverage: new CoverageStore(),
  evidence,
  traffic: new TrafficStore(),
  actors: new ActorStore(),
  pocCatalogPath: "",
  workflowRuns: [{ runId: "wf-1", status: "completed", specPath: "pentest-web" }],
  lifecycle: {},
};

const finish = createFinishScanTool(runtime);
const execFinish = (id: string, params: any) => finish.execute(id, params, undefined, undefined, {} as any);

// Harness v2: zero workers + packages + disk findings → completed (workers optional).
// Soft note may mention worker dispatch; must not hard-block.
const softWorkers = parseJsonResult(
  await execFinish("f1", {
    status: "completed",
    summary: "done with findings",
    confirmed_findings: ["Only LLM title that should not win"],
    evidence_ids: [ev1.id, ev2.id],
  }),
);
assert(softWorkers.ok === true, `workers optional: expected completed: ${JSON.stringify(softWorkers).slice(0, 400)}`);
assert(
  Array.isArray(softWorkers.finish_scan?.coverageGaps) &&
    softWorkers.finish_scan.coverageGaps.some((g: string) => /soft_worker/i.test(String(g))),
  `expected soft_worker gap note: ${JSON.stringify(softWorkers.finish_scan?.coverageGaps)}`,
);

// Second finish after recording a worker run still succeeds (idempotent path for panel fields).
runtime.lifecycle.workerRuns = [
  {
    workerId: "worker-injection-test",
    role: "injection",
    task: "Probe login",
    ok: true,
    at: new Date().toISOString(),
    durationMs: 100,
    toolCallCount: 2,
  },
];
runtime.lifecycle.finishScan = undefined;

const done = parseJsonResult(
  await execFinish("f2", {
    status: "completed",
    summary: "assess complete with disk findings",
    confirmed_findings: ["Hallucinated only title"],
    evidence_ids: [ev1.id, ev2.id],
  }),
);
assert(done.ok === true, `finish should succeed: ${JSON.stringify(done).slice(0, 600)}`);
assert(Array.isArray(done.finish_scan?.confirmedFindings), "confirmedFindings present");
assert(
  done.finish_scan.confirmedFindings.length === diskAgg.dedupedCount,
  `authoritative count=${done.finish_scan.confirmedFindings.length} expected ${diskAgg.dedupedCount}`,
);
assert(
  !done.finish_scan.confirmedFindings.includes("Hallucinated only title"),
  "LLM-only titles must not replace disk findings",
);
assert(done.findings_aggregate?.deduped_count === diskAgg.dedupedCount, "aggregate in result");
assert(
  events.some((e) => e.type === "finish_scan_requested" && Array.isArray(e.confirmed_findings) && (e.confirmed_findings as string[]).length === diskAgg.dedupedCount),
  "platform finish uses disk titles",
);

// incomplete without workers still ok
const runtime2: ToolRuntime = {
  ...runtime,
  lifecycle: {},
  task: { ...runtime.task, taskId: `${taskId}-inc` },
};
const finish2 = createFinishScanTool(runtime2);
const incomplete = parseJsonResult(
  await finish2.execute(
    "f3",
    { status: "incomplete", summary: "stopped early", confirmed_findings: [] },
    undefined,
    undefined,
    {} as any,
  ),
);
assert(incomplete.ok === true, `incomplete allowed: ${JSON.stringify(incomplete).slice(0, 300)}`);

// --- P1 diagnostics mergeWorkerUsage ---
const diagDir = resolve(workspaceDir, `diag-${randomUUID()}`);
await mkdir(diagDir, { recursive: true });
const diagnostics = await TaskDiagnostics.create(
  diagDir,
  {
    taskId: "diag",
    conversationId: "diag",
    instruction: "x",
    target: { type: "url", value: "http://127.0.0.1:9" },
    scope: { allow: ["http://127.0.0.1:9"] },
    snapshot: {},
  },
  { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
);
await diagnostics.handleAgentEvent({ type: "turn_start" });
await diagnostics.handleAgentEvent({
  type: "message_end",
  message: {
    role: "assistant",
    model: "main",
    stopReason: "stop",
    content: [{ type: "text", text: "main" }],
    usage: { input: 1000, output: 200, totalTokens: 1200, cost: { total: 0.01 } },
  },
});
assert(diagnostics.llmUsage().agent_count === 1, "main only agent_count=1");
await diagnostics.mergeWorkerUsage({
  requests: 2,
  input_tokens: 400,
  output_tokens: 100,
  cached_tokens: 0,
  cache_write_tokens: 0,
  reasoning_tokens: 0,
  total_tokens: 500,
  cost: 0.02,
  agent_count: 1,
  tool_calls: 4,
});
const after = diagnostics.llmUsage();
assert(after.agent_count === 2, `agent_count after worker=${after.agent_count}`);
assert(after.total_tokens === 1700, `total after worker=${after.total_tokens}`);
assert(after.requests === 3, `requests after worker=${after.requests}`);
assert(Number(after.tool_calls) === 4, `tool_calls=${after.tool_calls}`);

// Worker tool without launch still errors before any platform events.
const workerToolNoLaunch = createWorkerTool(runtime);
const noLaunch = parseJsonResult(
  await workerToolNoLaunch.execute("w1", { role: "recon", task: "map surface" }, undefined, undefined, {} as any),
);
assert(/launch context/i.test(String(noLaunch._raw || JSON.stringify(noLaunch))), "missing launch");

// --- P1 observability: stub workerLaunch so runWorkerSession fails fast AFTER start emits ---
const workerEvents: PlatformMessage[] = [];
const workerNotes: Array<{ type: string; details: Record<string, unknown> }> = [];
const workerUsages: unknown[] = [];
const workerTaskId = `worker-events-${randomUUID()}`;
const workerTaskDir = resolve(workspaceDir, workerTaskId);
await mkdir(workerTaskDir, { recursive: true });

const workerRuntime: ToolRuntime = {
  task: {
    taskId: workerTaskId,
    conversationId: workerTaskId,
    instruction: "dispatch injection package",
    engagement: "assess",
    target: { type: "url", value: "http://127.0.0.1:9" },
    scope: { allow: ["http://127.0.0.1:9"] },
    snapshot: {},
  },
  workspaceDir,
  platform: {
    async send(message) {
      workerEvents.push(message);
    },
  },
  plan: new PlanStore(),
  coverage: new CoverageStore(),
  evidence: new EvidenceStore(resolve(workerTaskDir, "evidence")),
  traffic: new TrafficStore(),
  actors: new ActorStore(),
  pocCatalogPath: "",
  workflowRuns: [],
  lifecycle: {},
  // Incomplete launch: real worker tool path emits start/end; session fails fast without LLM.
  workerLaunch: {
    config: {},
    model: null,
    authStorage: {},
    modelRegistry: {},
    settingsManager: {},
    taskDir: workerTaskDir,
    mergeWorkerUsage: async (usage) => {
      workerUsages.push(usage);
    },
    noteWorker: async (type, details) => {
      workerNotes.push({ type, details });
    },
  },
};

const workerTool = createWorkerTool(workerRuntime);
const workerTaskText = "Probe login and search for injection families";
const workerResult = parseJsonResult(
  await workerTool.execute(
    "w-events",
    { role: "injection", task: workerTaskText },
    undefined,
    undefined,
    {} as any,
  ),
);
assert(workerResult.ok === false, "stub launch must fail the session without LLM");
assert(/invalid worker launch context/i.test(String(workerResult.error || "")), `error=${workerResult.error}`);
assert(String(workerResult.outcome || "") === "failed", `outcome=${workerResult.outcome}`);
assert(String(workerResult.status || "") === "failed", `plan status=${workerResult.status}`);
assert(String(workerResult.role) === "injection", `role=${workerResult.role}`);
assert(String(workerResult.worker_id || "").startsWith("worker-injection-"), `worker_id=${workerResult.worker_id}`);

const started = workerEvents.find((e) => e.type === "worker_started");
const finished = workerEvents.find((e) => e.type === "worker_finished");
const planStarts = workerEvents.filter((e) => e.type === "plan_tree_updated" && e.reason === "worker.start");
const planEnds = workerEvents.filter((e) => e.type === "plan_tree_updated" && e.reason === "worker.end");
assert(started, "worker_started platform event");
assert(finished, "worker_finished platform event");
assert(planStarts.length >= 1, "plan_tree_updated reason=worker.start");
assert(planEnds.length >= 1, "plan_tree_updated reason=worker.end");
assert(String(started!.role) === "injection", `started.role=${started!.role}`);
assert(String(started!.worker_id) === String(workerResult.worker_id), "started.worker_id matches");
assert(String(started!.task || "").includes("Probe login"), `started.task=${started!.task}`);
assert(String(finished!.worker_id) === String(workerResult.worker_id), "finished.worker_id matches");
assert(String(finished!.role) === "injection", `finished.role=${finished!.role}`);
assert(String(finished!.task || "").includes("Probe login"), `finished.task=${finished!.task}`);
assert(finished!.ok === false, "finished.ok false for stub fail-fast");

const planNodes = workerRuntime.plan.snapshot();
const workerNodes = planNodes.filter((n) => n.kind === "worker");
assert(workerNodes.length >= 1, `plan worker nodes=${workerNodes.length}`);
assert(workerNodes.some((n) => n.node_id === `plan-${workerResult.worker_id}`), "stable plan node id");
assert(workerNodes.some((n) => n.status === "failed" || n.status === "done"), "plan node terminal status");
assert((workerRuntime.lifecycle.workerRuns?.length ?? 0) === 1, "lifecycle.workerRuns recorded");
assert(workerNotes.some((n) => n.type === "worker_started"), "noteWorker worker_started");
assert(workerNotes.some((n) => n.type === "worker_finished"), "noteWorker worker_finished");
assert(workerUsages.length >= 1, "mergeWorkerUsage called");

// panel_agents shape used by session-runner checkpoints / right panel
const { buildPanelAgents } = await import("./runtime/session-runner.js");
const panelAgents = buildPanelAgents(workerRuntime, { phase: "running", activeTool: "worker" });
assert(panelAgents.some((a) => a.role === "main" && a.id === "node2-main"), "panel main agent");
assert(
  panelAgents.some(
    (a) =>
      a.parent_id === "node2-main" &&
      a.role === "injection" &&
      String(a.id) === String(workerResult.worker_id),
  ),
  `panel worker agent missing: ${JSON.stringify(panelAgents)}`,
);

const workerEventTypes = workerEvents.map((e) => e.type);
assert(workerEventTypes.includes("worker_started"), "event types include worker_started");
assert(workerEventTypes.includes("worker_finished"), "event types include worker_finished");
assert(workerEventTypes.includes("plan_tree_updated"), "event types include plan_tree_updated");

console.log(
  JSON.stringify(
    {
      ok: true,
      dedupedTitles: diskAgg.titles,
      finishConfirmed: done.finish_scan.confirmedFindings,
      llmUsageAfterWorker: after,
      packageGateBlocked: true,
      finishEvents: events.map((e) => e.type),
      workerLifecycle: {
        event_types: workerEventTypes,
        worker_started: {
          type: started!.type,
          worker_id: started!.worker_id,
          role: started!.role,
          task: started!.task,
          plan_node_id: started!.plan_node_id,
        },
        worker_finished: {
          type: finished!.type,
          worker_id: finished!.worker_id,
          role: finished!.role,
          task: finished!.task,
          ok: finished!.ok,
          plan_node_id: finished!.plan_node_id,
        },
        plan_tree_reasons: workerEvents
          .filter((e) => e.type === "plan_tree_updated")
          .map((e) => e.reason),
        plan_worker_nodes: workerNodes.map((n) => ({
          node_id: n.node_id,
          kind: n.kind,
          status: n.status,
          title: n.title,
        })),
        panel_agents: panelAgents,
        note_types: workerNotes.map((n) => n.type),
        usage_merges: workerUsages.length,
        lifecycle_worker_runs: workerRuntime.lifecycle.workerRuns,
      },
    },
    null,
    2,
  ),
);
