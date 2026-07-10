/**
 * Worker subagent layer smoke (no live LLM required for role/tool contract).
 * Verifies role allowlists, forbidden tools, and worker tool registration.
 */
import { createWorkerTool } from "./tools/worker.js";
import { createPentestTools, PENTEST_TOOL_NAMES } from "./tools/index.js";
import {
  listWorkerRoles,
  resolveWorkerRole,
  workerToolAllowlist,
  WORKER_FORBIDDEN_TOOLS,
} from "./runtime/worker-roles.js";
import { ActorStore } from "./stores/actors.js";
import { CoverageStore } from "./stores/coverage.js";
import { EvidenceStore } from "./stores/evidence.js";
import { PlanStore } from "./stores/plan.js";
import { TrafficStore } from "./stores/traffic.js";
import type { PlatformSink, ToolRuntime } from "./types.js";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const roles = listWorkerRoles();
assert(roles.some((r) => r.id === "recon"), "recon role");
assert(roles.some((r) => r.id === "access-control"), "access-control role");
assert(roles.some((r) => r.id === "injection"), "injection role");
assert(roles.some((r) => r.id === "xss"), "xss role");
assert(roles.some((r) => r.id === "general"), "general role");

const reconTools = workerToolAllowlist(resolveWorkerRole("recon"));
assert(reconTools.includes("traffic"), "recon needs traffic");
assert(reconTools.includes("browser"), "recon needs browser");
assert(!reconTools.includes("finish_scan"), "recon must not finish_scan");
assert(!reconTools.includes("worker"), "recon must not nest worker");

const acTools = workerToolAllowlist(resolveWorkerRole("access-control"));
assert(acTools.includes("verifier"), "access-control needs verifier");
assert(acTools.includes("actor"), "access-control needs actor");
assert(acTools.includes("finding"), "access-control needs finding");
assert(!acTools.includes("finish_scan"), "access-control must not finish_scan");

for (const forbidden of WORKER_FORBIDDEN_TOOLS) {
  for (const role of roles) {
    assert(!workerToolAllowlist(role).includes(forbidden), `${role.id} must not include ${forbidden}`);
  }
}

assert(PENTEST_TOOL_NAMES.includes("worker"), "worker must be in PENTEST_TOOL_NAMES");

const sink: PlatformSink = { async send() {} };
const workspaceDir = resolve("tmp", "node2-worker-smoke");
const taskId = `worker-${randomUUID()}`;
await mkdir(resolve(workspaceDir, taskId, "evidence"), { recursive: true });

const runtime: ToolRuntime = {
  task: {
    taskId,
    conversationId: taskId,
    instruction: "worker smoke",
    target: { type: "url", value: "http://127.0.0.1:9" },
    scope: { allow: ["http://127.0.0.1:9"] },
    snapshot: {},
  },
  workspaceDir,
  platform: sink,
  plan: new PlanStore(),
  coverage: new CoverageStore(),
  evidence: new EvidenceStore(resolve(workspaceDir, taskId, "evidence")),
  traffic: new TrafficStore(),
  actors: new ActorStore(),
  pocCatalogPath: "",
  workflowRuns: [],
  lifecycle: {},
};

const tools = createPentestTools(runtime);
assert(tools.some((t) => t.name === "worker"), "createPentestTools must register worker");

const worker = createWorkerTool(runtime);
const exec = (id: string, params: any) =>
  worker.execute(id, params, undefined, undefined, {} as any);
const missing = await exec("w1", { role: "recon", task: "" });
const missingText = (missing.content || []).map((c: any) => c.text).join("\n");
assert(/task is required/i.test(missingText), `empty task should error: ${missingText}`);

const noLaunch = await exec("w2", { role: "injection", task: "probe login sqli" });
const noLaunchText = (noLaunch.content || []).map((c: any) => c.text).join("\n");
assert(/worker launch context is not configured/i.test(noLaunchText), `missing launch context: ${noLaunchText}`);

// Structural: workflow brief mentions workPackages / worker
import { readFile } from "node:fs/promises";
const webSpec = await readFile(resolve("workflows/pentest-web/spec.json"), "utf8");
assert(/workPackages/.test(webSpec), "pentest-web must mention workPackages");
assert(/worker/.test(webSpec), "pentest-web must mention worker");

console.log(
  JSON.stringify(
    {
      ok: true,
      roles: roles.map((r) => r.id),
      reconTools,
      accessControlTools: acTools,
      mainHasWorker: PENTEST_TOOL_NAMES.includes("worker"),
      forbidden: [...WORKER_FORBIDDEN_TOOLS],
    },
    null,
    2,
  ),
);
