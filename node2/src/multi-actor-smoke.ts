/**
 * Multi-actor + dual-actor IDOR + business-logic smoke (generic mock app).
 * Proves harness can register two identities and confirm horizontal access / field tamper.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { finishCompletedEligibility, multiActorTestingGaps } from "./runtime/detection-conversion.js";
import { ActorStore } from "./stores/actors.js";
import { CoverageStore } from "./stores/coverage.js";
import { EvidenceStore } from "./stores/evidence.js";
import { PlanStore } from "./stores/plan.js";
import { TrafficStore } from "./stores/traffic.js";
import { createActorTool } from "./tools/actor.js";
import { createVerifierTool } from "./tools/verifier.js";
import type { PlatformMessage, PlatformSink, ToolRuntime } from "./types.js";

class MemorySink implements PlatformSink {
  readonly events: PlatformMessage[] = [];
  async send(message: PlatformMessage): Promise<void> {
    this.events.push(message);
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
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

function parseAuth(req: IncomingMessage): string {
  const auth = String(req.headers.authorization || "");
  const m = /Bearer\s+(\S+)/i.exec(auth);
  return m?.[1] || "";
}

// token -> { email, role, basketId }
const sessions = new Map<string, { email: string; role: string; basketId: string }>();
const baskets: Record<string, { owner: string; items: string[]; secret: string }> = {
  "100": { owner: "alice@ex.com", items: ["apple"], secret: "alice-secret-note" },
  "200": { owner: "bob@ex.com", items: ["banana"], secret: "bob-secret-note" },
};

const server = createServer(async (req, res) => {
  const body = await readBody(req);
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const token = parseAuth(req);

  if (url.pathname === "/login" && req.method === "POST") {
    const parsed = JSON.parse(body || "{}");
    const email = String(parsed.email || "");
    const role = email.includes("admin") ? "admin" : "customer";
    const basketId = email.includes("bob") ? "200" : "100";
    const tok = `tok-${email.split("@")[0] || "u"}`;
    sessions.set(tok, { email, role, basketId });
    if (email.includes("bob")) baskets["200"]!.owner = email;
    else baskets["100"]!.owner = email;
    return send(res, 200, JSON.stringify({ token: tok, email, role, basketId }));
  }

  if (url.pathname.startsWith("/basket/")) {
    const id = url.pathname.split("/").pop() || "";
    const basket = baskets[id];
    if (!basket) return send(res, 404, JSON.stringify({ error: "missing" }));
    // Intentionally broken ACL: any authenticated user can read any basket.
    if (!token || !sessions.has(token)) return send(res, 401, JSON.stringify({ error: "auth" }));
    return send(res, 200, JSON.stringify({ id, ...basket }));
  }

  if (url.pathname === "/orders" && req.method === "POST") {
    if (!token || !sessions.has(token)) return send(res, 401, JSON.stringify({ error: "auth" }));
    const parsed = JSON.parse(body || "{}");
    // Broken business logic: accepts price=0 and role elevation.
    return send(
      res,
      201,
      JSON.stringify({
        ok: true,
        price: parsed.price ?? 10,
        quantity: parsed.quantity ?? 1,
        role: parsed.role || "customer",
      }),
    );
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
  if (text.startsWith("error:")) throw new Error(text);
  return JSON.parse(text);
}

try {
  const workspaceDir = resolve("tmp", "node2-multi-actor-smoke");
  const taskDir = resolve(workspaceDir, "run");
  await mkdir(resolve(taskDir, "evidence"), { recursive: true });
  const actors = new ActorStore();
  const runtime: ToolRuntime = {
    task: {
      taskId: "multi-actor-smoke",
      conversationId: "multi-actor-smoke",
      instruction: "multi actor smoke",
      target: { type: "url", value: target },
      scope: { allow: [target] },
      snapshot: {},
    },
    workspaceDir,
    platform: new MemorySink(),
    plan: new PlanStore(),
    coverage: new CoverageStore(),
    evidence: new EvidenceStore(resolve(taskDir, "evidence")),
    traffic: new TrafficStore(),
    actors,
    pocCatalogPath: "",
    workflowRuns: [],
    lifecycle: {},
  };
  runtime.plan.start();

  // Seed surface so finish gate expects multi-actor.
  await runtime.coverage.mark({ endpoint: "/basket/100", param: "id", vulnClass: "idor", status: "observed" });
  await runtime.coverage.mark({ endpoint: "/orders", param: "price", vulnClass: "business-logic", status: "observed" });

  const gapsBefore = multiActorTestingGaps(await runtime.coverage.list(), actors.count());
  assert(gapsBefore.some((g) => g.family === "multi_actor"), `expected multi_actor gap: ${JSON.stringify(gapsBefore)}`);

  const actorTool = createActorTool(runtime);
  // Simulate two logins by capturing tokens into actors.
  actors.upsert({ id: "user_a", label: "Alice", authorization: "Bearer tok-alice", meta: { email: "alice@ex.com", basketId: "100" } });
  actors.upsert({ id: "user_b", label: "Bob", authorization: "Bearer tok-bob", meta: { email: "bob@ex.com", basketId: "200" } });
  // Register real sessions on mock server via store tokens matching login map.
  sessions.set("tok-alice", { email: "alice@ex.com", role: "customer", basketId: "100" });
  sessions.set("tok-bob", { email: "bob@ex.com", role: "customer", basketId: "200" });

  const listed = await execJson(actorTool, "list", { action: "list" });
  assert(listed.count === 2, `expected 2 actors: ${JSON.stringify(listed)}`);

  const verifier = createVerifierTool(runtime);
  const idor = await execJson(verifier, "idor", {
    vuln_class: "idor",
    url: `${target}/basket/100`,
    object_id: "100",
    actor: "user_a",
    alt_actor: "user_b",
  });
  assert(idor.confirmed === true, `dual-actor IDOR should confirm: ${JSON.stringify(idor).slice(0, 800)}`);
  assert(String(idor.details?.mode || "").includes("dual"), "expected dual-actor mode");

  const logic = await execJson(verifier, "logic", {
    vuln_class: "business-logic",
    url: `${target}/orders`,
    method: "POST",
    actor: "user_a",
    headers: { "content-type": "application/json" },
    fields: { price: "10", quantity: "1" },
    privileged_fields: { price: "0", role: "admin" },
  });
  assert(logic.confirmed === true, `business-logic should confirm: ${JSON.stringify(logic).slice(0, 800)}`);

  // Mark remaining observed as resolved for other finish rules.
  for (const row of await runtime.coverage.list()) {
    if (row.status === "observed") {
      const klass = String(row.vulnClass || "").toLowerCase();
      const isAccess =
        ["idor", "access-control", "horizontal-access", "vertical-access", "business-logic", "auth-bypass"].includes(klass);
      await runtime.coverage.mark({
        endpoint: String(row.endpoint),
        param: String(row.param),
        vulnClass: String(row.vulnClass),
        status: isAccess ? "skipped" : "passed",
        notes: isAccess
          ? "same authz pattern already verified via dual-actor idor/business-logic on basket and orders"
          : "smoke resolved with deterministic negative evidence",
      });
    }
  }
  // Satisfy generic family breadth gates unrelated to this smoke's focus.
  for (const family of ["injection", "auth_session", "xss", "file_path", "redirect", "csrf"]) {
    await runtime.coverage.mark({
      endpoint: `/family/${family}`,
      param: "family",
      vulnClass: family,
      status: "skipped",
      notes: `risk-family skip: ${family} not in scope for multi-actor smoke focus; no additional surface observed`,
    });
  }

  const elig = finishCompletedEligibility(await runtime.coverage.list(), {
    status: "completed",
    actorCount: actors.count(),
    actorAuthCount: 2,
  });
  assert(elig.allowed, `finish should allow after dual-actor probe: ${elig.reason}`);

  console.log(
    JSON.stringify(
      {
        ok: true,
        idor: idor.confirmed,
        business_logic: logic.confirmed,
        actors: actors.summary(),
        finish_allowed: elig.allowed,
      },
      null,
      2,
    ),
  );
} finally {
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
}
