/**
 * Discovery enhancement smoke: new verifier classes + risk-family finish gate.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { finishCompletedEligibility, missingRiskFamiliesFromCoverage } from "./runtime/detection-conversion.js";
import { ActorStore } from "./stores/actors.js";
import { CoverageStore } from "./stores/coverage.js";
import { EvidenceStore } from "./stores/evidence.js";
import { PlanStore } from "./stores/plan.js";
import { TrafficStore } from "./stores/traffic.js";
import { createVerifierTool } from "./tools/verifier.js";
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

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function send(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(body);
}

const users: Record<string, { email: string; role: string }> = {
  "1": { email: "owner@example.com", role: "user" },
  "2": { email: "victim@example.com", role: "user" },
};

const server = createServer(async (req, res) => {
  const body = await readBody(req);
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const auth = String(req.headers.authorization || "");

  if (url.pathname.startsWith("/api/Users/")) {
    const id = url.pathname.split("/").pop() || "";
    const user = users[id];
    if (!user) return send(res, 404, JSON.stringify({ error: "missing" }));
    return send(res, 200, JSON.stringify({ id, ...user, passwordHash: "hash-" + id }));
  }

  if (url.pathname === "/api/Users" && req.method === "POST") {
    const parsed = JSON.parse(body || "{}");
    const id = String(Object.keys(users).length + 1);
    users[id] = { email: parsed.email || `u${id}@ex.com`, role: parsed.role || "user" };
    return send(res, 201, JSON.stringify({ id, ...users[id] }));
  }

  if (url.pathname === "/rest/user/whoami") {
    if (/Bearer\s+\S+\./i.test(auth) && auth.includes("eyJhbGciOiJub25lI")) {
      return send(res, 200, JSON.stringify({ user: { email: "forged@example.com", role: "admin" } }));
    }
    if (!auth) return send(res, 401, JSON.stringify({ error: "unauthorized" }));
    return send(res, 200, JSON.stringify({ user: { email: "real@example.com", role: "user" } }));
  }

  if (url.pathname === "/redirect") {
    const to = url.searchParams.get("to") || "/";
    res.writeHead(302, { location: to, "content-type": "text/plain" });
    res.end(`redirect:${to}`);
    return;
  }

  if (url.pathname === "/files") {
    const page = url.searchParams.get("page") || "index";
    if (page.includes("..") || page.includes("etc/passwd")) {
      return send(res, 200, "root:x:0:0:root:/root:/bin/bash");
    }
    return send(res, 200, "ok-index");
  }

  send(res, 404, JSON.stringify({ error: "not found" }));
});

await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const address = server.address();
if (!address || typeof address === "string") throw new Error("bind failed");
const target = `http://127.0.0.1:${address.port}`;

async function execJson(tool: any, id: string, params: any): Promise<any> {
  const result = await tool.execute(id, params);
  const text = (result?.content || []).filter((item: any) => item.type === "text").map((item: any) => item.text).join("\n");
  return JSON.parse(text);
}

try {
  const workspaceDir = resolve("tmp", "node2-discovery-enhancement-smoke");
  const taskId = `disc-${randomUUID()}`;
  const taskDir = resolve(workspaceDir, taskId);
  await mkdir(taskDir, { recursive: true });
  const sink = new MemorySink();
  const runtime: ToolRuntime = {
    task: {
      taskId,
      conversationId: taskId,
      instruction: "discovery enhancement",
      target: { type: "url", value: target },
      scope: { allow: [target] },
      snapshot: {},
    },
    workspaceDir,
    platform: sink,
    plan: new PlanStore(),
    coverage: new CoverageStore(),
    evidence: new EvidenceStore(resolve(taskDir, "evidence")),
    traffic: new TrafficStore(),
    actors: new ActorStore(),
    pocCatalogPath: "",
    workflowRuns: [],
    lifecycle: {},
  };
  runtime.plan.start();
  runtime.actors!.upsert({ id: "user_a", label: "A", authorization: "Bearer real-token" });
  runtime.actors!.upsert({ id: "user_b", label: "B", authorization: "Bearer other-token" });
  const verifier = createVerifierTool(runtime);

  // Seed coverage shapes that imply multiple families.
  await runtime.coverage.mark({ endpoint: "/api/Users/1", param: "id", vulnClass: "idor", status: "observed" });
  await runtime.coverage.mark({ endpoint: "/rest/user/whoami", param: "authorization", vulnClass: "jwt-alg-none", status: "observed" });
  await runtime.coverage.mark({ endpoint: "/redirect", param: "to", vulnClass: "open-redirect", status: "observed" });
  await runtime.coverage.mark({ endpoint: "/files", param: "page", vulnClass: "path-traversal", status: "observed" });
  await runtime.coverage.mark({ endpoint: "/api/Users", param: "role", vulnClass: "mass-assignment", status: "observed" });

  const gaps = missingRiskFamiliesFromCoverage(await runtime.coverage.list());
  assert(gaps.some((g) => g.family === "access_control"), `access_control gap missing: ${JSON.stringify(gaps)}`);
  assert(!finishCompletedEligibility(await runtime.coverage.list(), { status: "completed" }).allowed, "finish should block on observed/family gaps");

  const idor = await execJson(verifier, "idor", {
    vuln_class: "idor",
    url: `${target}/api/Users/1`,
    object_id: "1",
    actor: "user_a",
    alt_actor: "user_b",
  });
  assert(idor.confirmed === true, `idor should confirm: ${JSON.stringify(idor)}`);

  // Valid-looking JWT payload; verifier forges alg=none.
  const payload = Buffer.from(JSON.stringify({ sub: "u1", email: "real@example.com" }), "utf8").toString("base64url");
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" }), "utf8").toString("base64url");
  const jwt = `${header}.${payload}.sig`;
  const jwtResult = await execJson(verifier, "jwt", {
    vuln_class: "jwt-alg-none",
    url: `${target}/rest/user/whoami`,
    jwt,
  });
  assert(jwtResult.confirmed === true, `jwt-alg-none should confirm: ${JSON.stringify(jwtResult)}`);

  const redirect = await execJson(verifier, "redir", {
    vuln_class: "open-redirect",
    url: `${target}/redirect`,
    param: "to",
  });
  assert(redirect.confirmed === true, `open-redirect should confirm: ${JSON.stringify(redirect)}`);

  const pathTrav = await execJson(verifier, "path", {
    vuln_class: "path-traversal",
    url: `${target}/files`,
    param: "page",
    payload: "../etc/passwd",
    baseline_payload: "index",
  });
  assert(pathTrav.confirmed === true, `path-traversal should confirm: ${JSON.stringify(pathTrav)}`);

  const mass = await execJson(verifier, "mass", {
    vuln_class: "mass-assignment",
    url: `${target}/api/Users`,
    method: "POST",
    fields: { email: `n${Date.now()}@ex.com`, password: "Node2Pass!23" },
    privileged_fields: { role: "admin" },
  });
  assert(mass.confirmed === true, `mass-assignment should confirm: ${JSON.stringify(mass)}`);

  // Mark families attempted/resolved enough for finish eligibility helper.
  for (const row of await runtime.coverage.list()) {
    if (String(row.status) === "observed") {
      await runtime.coverage.mark({
        endpoint: String(row.endpoint),
        param: String(row.param),
        vulnClass: String(row.vulnClass),
        status: "failed",
        notes: "smoke verified",
      });
    }
  }
  for (const family of missingRiskFamiliesFromCoverage(await runtime.coverage.list())) {
    await runtime.coverage.mark({
      endpoint: `/family/${family.family}`,
      param: "family",
      vulnClass: family.family,
      status: "skipped",
      notes: `risk-family skip ${family.reason}`,
    });
  }
  const allowed = finishCompletedEligibility(await runtime.coverage.list(), {
    status: "completed",
    actorCount: runtime.actors!.count(),
  });
  assert(allowed.allowed, `finish should be allowed after family closure: ${allowed.reason}`);

  console.log(JSON.stringify({
    ok: true,
    confirmed: {
      idor: idor.confirmed,
      jwt: jwtResult.confirmed,
      redirect: redirect.confirmed,
      path: pathTrav.confirmed,
      mass: mass.confirmed,
    },
    evidence_ids: [idor.evidence_id, jwtResult.evidence_id, redirect.evidence_id, pathTrav.evidence_id, mass.evidence_id],
  }, null, 2));
} finally {
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
}
