import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execPath } from "node:process";
import { randomUUID } from "node:crypto";
import { CoverageStore } from "./stores/coverage.js";
import { EvidenceStore } from "./stores/evidence.js";
import { PlanStore } from "./stores/plan.js";
import { TrafficStore } from "./stores/traffic.js";
import { createScanTool } from "./tools/scan.js";
import type { PlatformMessage, PlatformSink, ToolRuntime } from "./types.js";

class MemorySink implements PlatformSink {
  readonly events: PlatformMessage[] = [];
  async send(message: PlatformMessage): Promise<void> {
    this.events.push(message);
  }
}

const workspaceDir = resolve("tmp", "node2-scan-output-ingest-smoke");
const taskId = `scan-output-${randomUUID()}`;
const taskDir = resolve(workspaceDir, taskId);
const binDir = resolve(taskDir, "bin");
await mkdir(binDir, { recursive: true });
const fakeDocker = resolve(binDir, "fake-docker.mjs");
await writeFile(
  fakeDocker,
  [
    "const args = process.argv.slice(2).join(' ');",
    "if (args.includes('httpx')) {",
    "  console.log(JSON.stringify({ url: 'http://host.docker.internal:8080/login.php?next=/admin', status_code: 200, title: 'Login', content_type: 'text/html' }));",
    "  console.log(JSON.stringify({ url: 'http://host.docker.internal:8080/api/users?id=1', status_code: 200, title: 'Users', content_type: 'application/json' }));",
    "} else if (args.includes('nuclei')) {",
    "  console.log(JSON.stringify({ 'template-id': 'generic-sqli', info: { name: 'SQL Injection', severity: 'high' }, 'matched-at': 'http://host.docker.internal:8080/api/users?id=1' }));",
    "} else {",
    "  console.log('http://host.docker.internal:8080/fallback.php?q=1');",
    "}",
    "",
  ].join("\n"),
  "utf8",
);

const oldDockerBin = process.env.NODE2_DOCKER_BIN;
const oldDockerArgs = process.env.NODE2_DOCKER_BIN_ARGS;
process.env.NODE2_DOCKER_BIN = execPath;
process.env.NODE2_DOCKER_BIN_ARGS = JSON.stringify([fakeDocker]);

try {
  const sink = new MemorySink();
  const runtime: ToolRuntime = {
    task: {
      taskId,
      conversationId: taskId,
      instruction: "scan output ingest smoke",
      target: { type: "url", value: "http://localhost:8080" },
      scope: { allow: ["http://localhost:8080", "http://host.docker.internal:8080"] },
      snapshot: {},
    },
    workspaceDir,
    platform: sink,
    plan: new PlanStore(),
    coverage: new CoverageStore(),
    evidence: new EvidenceStore(resolve(taskDir, "evidence")),
    traffic: new TrafficStore(),
    pocCatalogPath: "",
    workflowRuns: [],
    lifecycle: {},
    scannerSandbox: {
      enabled: true,
      image: "strix-sandbox:smoke",
    },
  };
  runtime.plan.start();
  const scan = createScanTool(runtime);
  const httpx = await execJson(scan, "scan-httpx", { scanner: "httpx", target: "http://localhost:8080" });
  if (httpx.ingested?.parsed_urls !== 2 || httpx.ingested?.traffic_ids?.length !== 2) {
    throw new Error(`expected httpx output ingestion: ${JSON.stringify(httpx.ingested)}`);
  }
  const candidates = runtime.traffic.candidates(10);
  if (!candidates.some((row) => row.url.includes("/api/users?id=1") && row.tags?.includes("parameterized"))) {
    throw new Error(`expected parameterized traffic candidate: ${JSON.stringify(candidates)}`);
  }
  const nuclei = await execJson(scan, "scan-nuclei", { scanner: "nuclei", target: "http://localhost:8080" });
  if (nuclei.ingested?.candidate_findings !== 1 || !nuclei.ingested?.findings_evidence_id || nuclei.ingested?.backlog_items?.length !== 1) {
    throw new Error(`expected nuclei candidate finding evidence: ${JSON.stringify(nuclei.ingested)}`);
  }
  const plan = runtime.plan.snapshot();
  const scannerBacklog = plan.find((node) => node.node_id === nuclei.ingested.backlog_items[0]);
  if (!scannerBacklog || scannerBacklog.status !== "pending" || scannerBacklog.vuln_type !== "sql-injection" || scannerBacklog.result !== "inconclusive") {
    throw new Error(`expected scanner candidate backlog item: ${JSON.stringify(scannerBacklog)}`);
  }
  if (plan.some((node) => node.kind === "finding" && node.result === "confirmed")) {
    throw new Error(`scanner candidate must not create confirmed finding: ${JSON.stringify(plan)}`);
  }
  console.log(JSON.stringify({
    ok: true,
    httpxIngested: httpx.ingested,
    nucleiIngested: nuclei.ingested,
    trafficTotal: runtime.traffic.list({ limit: 20 }).length,
    candidateCount: candidates.length,
    backlogItem: scannerBacklog,
    evidenceEvents: sink.events.filter((event) => event.type === "evidence_created").length,
  }, null, 2));
} finally {
  restoreEnv("NODE2_DOCKER_BIN", oldDockerBin);
  restoreEnv("NODE2_DOCKER_BIN_ARGS", oldDockerArgs);
}

async function execJson(tool: any, callId: string, params: Record<string, unknown>): Promise<any> {
  const result = await tool.execute(callId, params);
  const text = result.content.find((item: { type: string; text?: string }) => item.type === "text")?.text || "{}";
  return JSON.parse(text);
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
