/**
 * P0 conversion gate smoke: drives shipped finish_scan + coverage tools.
 * (a) high-priority observed-only → finish completed blocked
 * (b) candidates tried/passed/failed/blocked → finish completed allowed
 */
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  conversionMetrics,
  finishCompletedEligibility,
  materialUntestedHighPriority,
} from "./runtime/detection-conversion.js";
import { CoverageStore } from "./stores/coverage.js";
import { EvidenceStore } from "./stores/evidence.js";
import { PlanStore } from "./stores/plan.js";
import { TrafficStore } from "./stores/traffic.js";
import { createCoverageTool } from "./tools/coverage.js";
import { createFinishScanTool } from "./tools/finish.js";
import type { PlatformMessage, PlatformSink, ToolRuntime } from "./types.js";

class MemorySink implements PlatformSink {
  readonly events: PlatformMessage[] = [];
  async send(message: PlatformMessage): Promise<void> {
    this.events.push(message);
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function execJson(tool: any, id: string, params: any): Promise<any> {
  const result = await tool.execute(id, params);
  const text = (result?.content || [])
    .filter((item: any) => item.type === "text")
    .map((item: any) => item.text)
    .join("\n");
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text, details: result?.details };
  }
}

async function main(): Promise<void> {
  const workspaceDir = resolve("tmp", "node2-p0-conversion-smoke");
  const taskId = `p0-${randomUUID()}`;
  const taskDir = resolve(workspaceDir, taskId);
  await mkdir(taskDir, { recursive: true });
  const sink = new MemorySink();
  const runtime: ToolRuntime = {
    task: {
      taskId,
      conversationId: taskId,
      instruction: "p0 conversion smoke",
      target: { type: "url", value: "http://127.0.0.1:9" },
      scope: { allow: ["http://127.0.0.1:9"] },
      snapshot: {},
    },
    workspaceDir,
    platform: sink,
    plan: new PlanStore(),
    coverage: new CoverageStore(),
    evidence: new EvidenceStore(resolve(taskDir, "evidence")),
    traffic: new TrafficStore(),
    pocCatalogPath: "",
    workflowRuns: [{ runId: "wf-1", status: "completed", specPath: "workflows/pentest-web/spec.json" }],
    lifecycle: {},
  };
  runtime.plan.start();
  const coverage = createCoverageTool(runtime);
  const finish = createFinishScanTool(runtime);

  // Seed high-priority observed candidates (generic classes, no target-specific titles).
  await execJson(coverage, "mark-1", {
    action: "mark",
    endpoint: "/vulnerabilities/sqli/",
    param: "id",
    vuln_class: "sql-injection",
    status: "observed",
  });
  await execJson(coverage, "mark-2", {
    action: "mark",
    endpoint: "/vulnerabilities/exec/",
    param: "ip",
    vuln_class: "command-injection",
    status: "observed",
  });
  // Low-priority noise should not block finish.
  await execJson(coverage, "mark-3", {
    action: "mark",
    endpoint: "/static/app.js",
    param: "-",
    vuln_class: "info",
    status: "observed",
  });

  const rowsA = await runtime.coverage.list();
  const pureA = finishCompletedEligibility(rowsA, { status: "completed" });
  assert(!pureA.allowed, `pure helper should block completed: ${pureA.reason}`);
  assert(pureA.untestedHighPriority.length >= 2, "expected >=2 high-priority untested");

  const priority = await execJson(coverage, "priority", { action: "priority_candidates" });
  assert(priority.count >= 2, `priority_candidates count=${priority.count}`);

  const blocked = await execJson(finish, "finish-blocked", {
    status: "completed",
    summary: "attempt complete while untested high-priority remain",
    confirmed_findings: [],
    coverage_gaps: [],
    blockers: [],
    evidence_ids: [],
  });
  assert(blocked.blocked === true || blocked.ok === false, `finish should be blocked: ${JSON.stringify(blocked)}`);
  assert(Array.isArray(blocked.untested_high_priority) && blocked.untested_high_priority.length >= 2, "blocked payload missing untested list");
  assert(!runtime.lifecycle.finishScan, "lifecycle finishScan must not be set when completed is rejected");

  // incomplete is always allowed.
  const incomplete = await execJson(finish, "finish-incomplete", {
    status: "incomplete",
    summary: "stopping with remaining work",
    coverage_gaps: priority.candidates?.map((c: any) => `${c.vulnClass}@${c.endpoint}`) || [],
  });
  assert(incomplete.ok === true, `incomplete should succeed: ${JSON.stringify(incomplete)}`);
  runtime.lifecycle.finishScan = undefined;

  // Resolve high-priority candidates.
  await execJson(coverage, "try-1", {
    action: "mark",
    endpoint: "/vulnerabilities/sqli/",
    param: "id",
    vuln_class: "sql-injection",
    status: "failed",
    notes: "verified with baseline/attack differential",
  });
  await execJson(coverage, "try-2", {
    action: "mark",
    endpoint: "/vulnerabilities/exec/",
    param: "ip",
    vuln_class: "command-injection",
    status: "blocked",
    notes: "login required; cannot probe without credentials",
  });

  const rowsB = await runtime.coverage.list();
  const pureB = finishCompletedEligibility(rowsB, { status: "completed" });
  assert(pureB.allowed, `pure helper should allow completed after resolution: ${pureB.reason}`);
  assert(materialUntestedHighPriority(rowsB).length === 0, "no high-priority observed should remain");

  const metrics = conversionMetrics(rowsB);
  assert(metrics.highPriorityUntested === 0, `expected 0 untested, got ${metrics.highPriorityUntested}`);
  assert(metrics.confirmedCoverageCount >= 1, "expected at least one confirmed coverage (failed status)");

  const allowed = await execJson(finish, "finish-ok", {
    status: "completed",
    summary: "high-priority candidates resolved; report ready",
    confirmed_findings: ["SQL injection verified"],
    coverage_gaps: [],
    blockers: [],
    evidence_ids: [],
  });
  assert(allowed.ok === true, `completed should succeed: ${JSON.stringify(allowed)}`);
  const finishScanState = runtime.lifecycle.finishScan as { status?: string } | undefined;
  assert(finishScanState && finishScanState.status === "completed", "lifecycle should record completed finish");
  assert(allowed.conversion && typeof allowed.conversion.observedToConfirmedRate === "number", "conversion metrics missing on finish");
  const finishStatus = finishScanState.status;

  console.log(JSON.stringify({
    ok: true,
    blocked_untested: blocked.untested_high_priority,
    allowed_status: finishStatus,
    conversion: metrics,
  }, null, 2));
}

try {
  await main();
  process.exit(0);
} catch (error) {
  console.error(error);
  process.exit(1);
}
