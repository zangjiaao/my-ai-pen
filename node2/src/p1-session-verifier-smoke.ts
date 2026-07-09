/**
 * P1 session + multi-step verifier smoke against a local mock HTTP server.
 * Proves cookie jar reuse, injection confirmed/negative, and CSRF omit-token
 * protected vs vulnerable paths (must not re-inject valid tokens into CSRF attacks).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { CoverageStore } from "./stores/coverage.js";
import { EvidenceStore } from "./stores/evidence.js";
import { PlanStore } from "./stores/plan.js";
import { TrafficStore } from "./stores/traffic.js";
import { createHttpTool } from "./tools/http.js";
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
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...headers });
  res.end(body);
}

const vulnProfile = { value: "initial" };
const protectedProfile = { value: "initial" };
let sessionSeq = 0;

const server = createServer(async (req, res) => {
  const body = await readBody(req);
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const cookie = String(req.headers.cookie || "");
  const authed = /PHPSESSID=sess-ok/.test(cookie);

  if (url.pathname === "/login") {
    if (req.method === "GET") {
      return send(res, 200, `<form><input name="user_token" value="tok-login"/></form>`, {
        "set-cookie": "PHPSESSID=sess-ok; Path=/",
      });
    }
    return send(res, 200, "logged-in", { "set-cookie": "PHPSESSID=sess-ok; Path=/" });
  }

  if (url.pathname === "/sqli") {
    if (!authed) return send(res, 403, "login required");
    const id = url.searchParams.get("id") || "";
    if (id.includes("'") || id.toLowerCase().includes(" or ")) {
      return send(res, 200, "First name: admin Surname: root SQL syntax");
    }
    return send(res, 200, "User ID exists in the database.");
  }

  if (url.pathname === "/sqli-safe") {
    return send(res, 200, "User ID exists in the database.");
  }

  // Vulnerable CSRF: missing/stale token accepted and mutates state.
  if (url.pathname === "/profile-vuln") {
    if (req.method === "GET") {
      return send(
        res,
        200,
        `<html>name=${vulnProfile.value}<form method="post"><input name="csrf" value="valid-token"/><input name="display_name"/></form></html>`,
      );
    }
    const form = new URLSearchParams(body);
    const token = form.get("csrf");
    if (token === "valid-token") {
      // Valid token also works; CSRF is about missing protection on omit/stale.
      vulnProfile.value = form.get("display_name") || vulnProfile.value;
      return send(res, 200, `updated name=${vulnProfile.value}`);
    }
    // Missing or stale token accepted (vulnerable)
    vulnProfile.value = form.get("display_name") || vulnProfile.value;
    return send(res, 200, `updated name=${vulnProfile.value}`);
  }

  // Protected CSRF: omit/stale rejected; only valid token mutates state.
  if (url.pathname === "/profile-protected") {
    if (req.method === "GET") {
      return send(
        res,
        200,
        `<html>name=${protectedProfile.value}<form method="post"><input name="csrf" value="valid-token"/><input name="display_name"/></form></html>`,
      );
    }
    const form = new URLSearchParams(body);
    if (form.get("csrf") !== "valid-token") {
      return send(res, 403, "invalid or missing csrf token forbidden");
    }
    protectedProfile.value = form.get("display_name") || protectedProfile.value;
    return send(res, 200, `updated name=${protectedProfile.value}`);
  }

  if (url.pathname === "/session-id") {
    sessionSeq += 1;
    return send(res, 200, "ok", { "set-cookie": `DVWASESSID=${1000 + sessionSeq}; Path=/` });
  }

  return send(res, 404, "not found");
});

await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const address = server.address();
if (!address || typeof address === "string") throw new Error("mock server did not bind");
const target = `http://127.0.0.1:${address.port}`;

async function execJson(tool: any, id: string, params: any): Promise<any> {
  const result = await tool.execute(id, params);
  const text = (result?.content || [])
    .filter((item: any) => item.type === "text")
    .map((item: any) => item.text)
    .join("\n");
  return JSON.parse(text);
}

try {
  const workspaceDir = resolve("tmp", "node2-p1-session-smoke");
  const taskId = `p1-${randomUUID()}`;
  const taskDir = resolve(workspaceDir, taskId);
  await mkdir(taskDir, { recursive: true });
  const sink = new MemorySink();
  const runtime: ToolRuntime = {
    task: {
      taskId,
      conversationId: taskId,
      instruction: "p1 session verifier smoke",
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
    pocCatalogPath: "",
    workflowRuns: [],
    lifecycle: {},
  };
  runtime.plan.start();
  const http = createHttpTool(runtime);
  const verifier = createVerifierTool(runtime);

  // Establish session cookie via http tool (must be remembered).
  const login = await execJson(http, "login", { method: "GET", url: `${target}/login` });
  assert(login.status === 200, "login page failed");
  const snapshot = runtime.traffic.snapshot();
  assert(snapshot && String(snapshot.cookie || "").includes("PHPSESSID=sess-ok"), `cookie not remembered: ${JSON.stringify(snapshot)}`);

  // Authenticated SQLi positive (cookie auto-merged).
  const sqli = await execJson(verifier, "sqli-pos", {
    vuln_class: "sql-injection",
    url: `${target}/sqli`,
    method: "GET",
    param: "id",
    baseline_payload: "1",
    payload: "1' OR '1'='1",
  });
  assert(sqli.confirmed === true, `sqli should confirm: ${JSON.stringify(sqli)}`);
  assert(typeof sqli.evidence_id === "string" && sqli.evidence_id, "sqli missing evidence_id");
  assert(String(sqli.next_step || "").includes("finding"), "confirmed result must steer to finding(confirm)");

  // Negative injection fixture.
  const safe = await execJson(verifier, "sqli-neg", {
    vuln_class: "sql-injection",
    url: `${target}/sqli-safe`,
    method: "GET",
    param: "id",
    baseline_payload: "1",
    payload: "1' OR '1'='1",
  });
  assert(safe.confirmed === false, `safe endpoint should not confirm: ${JSON.stringify(safe)}`);

  // CSRF omit-token on VULNERABLE endpoint → must confirm (token must stay omitted).
  const csrfOmitVuln = await execJson(verifier, "csrf-omit-vuln", {
    vuln_class: "csrf",
    url: `${target}/profile-vuln`,
    method: "POST",
    check_url: "/profile-vuln",
    token_param: "csrf",
    fields: { display_name: "changed-via-omit", csrf: "valid-token" },
    // no stale_token → omit path
  });
  assert(csrfOmitVuln.confirmed === true, `omit-token vulnerable CSRF must confirm: ${JSON.stringify(csrfOmitVuln)}`);
  assert(
    String(csrfOmitVuln.details?.omitted_or_stale_token || "") === "omitted",
    `expected omitted token mode, got ${csrfOmitVuln.details?.omitted_or_stale_token}`,
  );
  assert(
    !String(csrfOmitVuln.details?.probes?.[1]?.requestBody || "").includes("csrf=valid-token"),
    `attack body must not re-inject valid csrf token: ${csrfOmitVuln.details?.probes?.[1]?.requestBody}`,
  );

  // CSRF omit-token on PROTECTED endpoint → must NOT confirm.
  const csrfOmitProtected = await execJson(verifier, "csrf-omit-protected", {
    vuln_class: "csrf",
    url: `${target}/profile-protected`,
    method: "POST",
    check_url: "/profile-protected",
    token_param: "csrf",
    fields: { display_name: "should-not-change", csrf: "valid-token" },
  });
  assert(csrfOmitProtected.confirmed === false, `omit-token protected CSRF must not confirm: ${JSON.stringify(csrfOmitProtected)}`);
  assert(
    !String(csrfOmitProtected.details?.probes?.[1]?.requestBody || "").includes("csrf=valid-token"),
    `protected attack must also keep token omitted: ${csrfOmitProtected.details?.probes?.[1]?.requestBody}`,
  );

  // Stale-token vulnerable path still confirms.
  const csrfStale = await execJson(verifier, "csrf-stale-vuln", {
    vuln_class: "csrf",
    url: `${target}/profile-vuln`,
    method: "POST",
    check_url: "/profile-vuln",
    token_param: "csrf",
    fields: { display_name: "changed-via-stale", csrf: "valid-token" },
    stale_token: "stale",
  });
  assert(csrfStale.confirmed === true, `stale-token vulnerable CSRF must confirm: ${JSON.stringify(csrfStale)}`);

  // Weak session sequential samples.
  const weak = await execJson(verifier, "weak-session", {
    vuln_class: "weak-session-id",
    url: `${target}/session-id`,
    samples: 5,
  });
  assert(weak.confirmed === true, `weak session should confirm: ${JSON.stringify(weak)}`);

  console.log(JSON.stringify({
    ok: true,
    cookie: snapshot?.cookie,
    sqli_evidence: sqli.evidence_id,
    safe_confirmed: safe.confirmed,
    csrf_omit_vuln_confirmed: csrfOmitVuln.confirmed,
    csrf_omit_protected_confirmed: csrfOmitProtected.confirmed,
    csrf_stale_vuln_confirmed: csrfStale.confirmed,
    weak_confirmed: weak.confirmed,
  }, null, 2));
} finally {
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
}
