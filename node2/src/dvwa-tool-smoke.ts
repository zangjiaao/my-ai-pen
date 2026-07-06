import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { loadConfig } from "./config.js";
import { loadDotEnv } from "./env.js";
import { PlanStore } from "./stores/plan.js";
import { CoverageStore } from "./stores/coverage.js";
import { EvidenceStore } from "./stores/evidence.js";
import { TrafficStore } from "./stores/traffic.js";
import { createFindingTool } from "./tools/finding.js";
import { createHttpTool } from "./tools/http.js";
import { createPocTool } from "./tools/poc.js";
import { createVerifierTool } from "./tools/verifier.js";
import type { PlatformMessage, PlatformSink, ToolRuntime } from "./types.js";

loadDotEnv();
loadDotEnv("node2/.env");

class FileSink implements PlatformSink {
  readonly events: PlatformMessage[] = [];
  constructor(private readonly dir: string) {}

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  async send(message: PlatformMessage): Promise<void> {
    this.events.push({ ts: new Date().toISOString(), ...message });
    await writeFile(resolve(this.dir, "events.json"), JSON.stringify(this.events, null, 2), "utf8");
  }
}

const args = parseArgs(process.argv.slice(2));
const config = loadConfig();
const taskId = args["task-id"] || `node2-dvwa-tool-smoke-${Date.now()}`;
const target = args.target || "http://localhost:8080";
const workspaceDir = resolve(args.output || config.workspaceDir);
const taskDir = resolve(workspaceDir, taskId);
const sink = new FileSink(taskDir);
await sink.init();

const runtime: ToolRuntime = {
  task: {
    taskId,
    conversationId: taskId,
    instruction: "Node2 deterministic DVWA tool smoke",
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
  pocCatalogPath: config.pocCatalogPath,
  workflowRuns: [],
  lifecycle: {},
  trafficProxyUrl: config.trafficProxyUrl,
};

runtime.plan.start();
const http = createHttpTool(runtime);
const poc = createPocTool(runtime);
const verifier = createVerifierTool(runtime);
const finding = createFindingTool(runtime);

const loginGet = await execJson(http, "smoke-http-login-get", {
  method: "GET",
  url: "/login.php",
});
const cookie = sessionCookie(loginGet.headers?.["set-cookie"]);
const token = userToken(String(loginGet.body || ""));
const loginBody = new URLSearchParams({
  username: "admin",
  password: "password",
  Login: "Login",
  ...(token ? { user_token: token } : {}),
}).toString();
const loginPost = await execJson(http, "smoke-http-login-post", {
  method: "POST",
  url: "/login.php",
  headers: {
    cookie: cookie ? `${cookie}; security=low` : "security=low",
    "content-type": "application/x-www-form-urlencoded",
  },
  body: loginBody,
});
const postCookie = sessionCookie(loginPost.headers?.["set-cookie"]) || cookie;
const authCookie = postCookie ? `${postCookie}; security=low` : "security=low";

const smokeTests: SmokeTest[] = [
  {
    id: "command-injection",
    vulnClass: "command-injection",
    title: "DVWA command injection in ip parameter",
    severity: "critical",
    verifierParams: {
      vuln_class: "command-injection",
      url: "/vulnerabilities/exec/",
      method: "POST",
      param: "ip",
      baseline_payload: "127.0.0.1",
      payload: "127.0.0.1;id",
      headers: { cookie: authCookie },
    },
    finding: {
      url: `${target.replace(/\/+$/, "")}/vulnerabilities/exec/`,
      description: "The ip parameter is passed to an operating system command and allows command separator injection.",
      impact: "An attacker can execute arbitrary operating system commands in the web server context.",
      reproduction: "Login to DVWA with a test account, set security=low, then POST ip=127.0.0.1;id&Submit=Submit to /vulnerabilities/exec/ and observe uid/gid output.",
      remediation: "Avoid shell execution for user input; use safe APIs and strict allowlists for host/IP validation.",
    },
  },
  {
    id: "file-inclusion",
    vulnClass: "file-inclusion",
    title: "DVWA local file inclusion via page parameter",
    severity: "high",
    verifierParams: {
      vuln_class: "file-inclusion",
      url: "/vulnerabilities/fi/",
      method: "GET",
      param: "page",
      baseline_payload: "include.php",
      payload: "/etc/passwd",
      headers: { cookie: authCookie },
    },
    finding: {
      url: `${target.replace(/\/+$/, "")}/vulnerabilities/fi/`,
      description: "The page parameter allows reading a server-local file path.",
      impact: "An attacker can read local files available to the web server process.",
      reproduction: "Login to DVWA with security=low and request /vulnerabilities/fi/?page=/etc/passwd.",
      remediation: "Map allowed include pages to server-side identifiers and reject absolute paths or traversal.",
    },
  },
  {
    id: "sql-injection",
    vulnClass: "sql-injection",
    title: "DVWA SQL injection in id parameter",
    severity: "high",
    verifierParams: {
      vuln_class: "sql-injection",
      url: "/vulnerabilities/sqli/",
      method: "GET",
      param: "id",
      baseline_payload: "1",
      payload: "1' OR '1'='1",
      headers: { cookie: authCookie },
    },
    finding: {
      url: `${target.replace(/\/+$/, "")}/vulnerabilities/sqli/`,
      description: "The id parameter changes query semantics when SQL control characters are supplied.",
      impact: "An attacker can alter database queries and enumerate application data.",
      reproduction: "Login to DVWA with security=low and compare id=1 with id=1' OR '1'='1 on /vulnerabilities/sqli/.",
      remediation: "Use parameterized queries and strict server-side type validation.",
    },
  },
  {
    id: "blind-sql-injection",
    vulnClass: "blind-sql-injection",
    title: "DVWA blind SQL injection in id parameter",
    severity: "high",
    verifierParams: {
      vuln_class: "blind-sql-injection",
      url: "/vulnerabilities/sqli_blind/",
      method: "GET",
      param: "id",
      true_payload: "1' AND '1'='1",
      false_payload: "1' AND '1'='2",
      headers: { cookie: authCookie },
    },
    finding: {
      url: `${target.replace(/\/+$/, "")}/vulnerabilities/sqli_blind/`,
      description: "The id parameter produces a repeatable boolean differential under SQL predicates.",
      impact: "An attacker can infer database content through boolean response differences.",
      reproduction: "Login to DVWA with security=low and compare true and false predicates on /vulnerabilities/sqli_blind/.",
      remediation: "Use parameterized queries and avoid returning distinguishable boolean query feedback.",
    },
  },
  {
    id: "xss-reflected",
    vulnClass: "xss-reflected",
    title: "DVWA reflected XSS in name parameter",
    severity: "medium",
    verifierParams: {
      vuln_class: "xss-reflected",
      url: "/vulnerabilities/xss_r/",
      method: "GET",
      param: "name",
      baseline_payload: "node2-baseline",
      payload: "<script>alert(1)</script>",
      headers: { cookie: authCookie },
    },
    finding: {
      url: `${target.replace(/\/+$/, "")}/vulnerabilities/xss_r/`,
      description: "The name parameter is reflected into an executable HTML context without output encoding.",
      impact: "An attacker can execute JavaScript in a victim browser in the DVWA origin.",
      reproduction: "Login to DVWA with security=low and request /vulnerabilities/xss_r/?name=<script>alert(1)</script>.",
      remediation: "Apply context-aware output encoding and avoid reflecting raw user input into HTML.",
    },
  },
];

const testResults: SmokeTestResult[] = [];
for (const test of smokeTests) {
  const catalog = await execJson(poc, `smoke-poc-${test.id}`, {
    action: "get",
    vuln_class: test.vulnClass,
  });
  const verify = await execJson(verifier, `smoke-verifier-${test.id}`, test.verifierParams);
  const result: SmokeTestResult = {
    id: test.id,
    vulnClass: test.vulnClass,
    catalog: { id: catalog.id, vulnClass: catalog.vulnClass, evidenceGates: catalog.evidenceGates },
    verifier: verify,
    findingConfirmed: false,
  };
  if (verify.confirmed && verify.evidence_id) {
    await execJson(finding, `smoke-finding-${test.id}`, {
      action: "confirm",
      title: test.title,
      severity: test.severity,
      url: test.finding.url,
      affected_asset: target,
      evidence_ids: [verify.evidence_id],
      confidence: "high",
      description: test.finding.description,
      impact: test.finding.impact,
      reproduction: test.finding.reproduction,
      poc: reproductionPoc(test, verify),
      remediation: test.finding.remediation,
    });
    result.findingConfirmed = true;
  }
  testResults.push(result);
}

const checkpoint = {
  runtime: "node2-tool-smoke",
  target,
  tests: testResults,
  confirmed_findings: testResults.filter((test) => test.findingConfirmed).length,
  coverage: await runtime.coverage.summary(),
  evidence: await runtime.evidence.list(),
  evidence_quality: await evidenceQuality(testResults),
  plan_tree: runtime.plan.snapshot(),
  audit: runtime.plan.audit(),
  events: sink.events.length,
};
await writeFile(resolve(taskDir, "tool-smoke-checkpoint.json"), JSON.stringify(checkpoint, null, 2), "utf8");
console.log(`[node2-dvwa-tool-smoke] confirmed=${checkpoint.confirmed_findings}/${smokeTests.length}: ${taskDir}`);

type SmokeTest = {
  id: string;
  vulnClass: string;
  title: string;
  severity: string;
  verifierParams: Record<string, unknown>;
  finding: {
    url: string;
    description: string;
    impact: string;
    reproduction: string;
    remediation: string;
  };
};

type SmokeTestResult = {
  id: string;
  vulnClass: string;
  catalog: Record<string, unknown>;
  verifier: any;
  findingConfirmed: boolean;
};

async function execJson(tool: ReturnType<typeof createHttpTool>, id: string, params: Record<string, unknown>): Promise<any> {
  runtime.plan.toolStart(id, tool.name, params);
  const result = await (tool.execute as any)(id, params, new AbortController().signal, undefined, {});
  runtime.plan.toolEnd(id, tool.name, false, result.content.map((item: any) => item.text).join("\n"));
  return JSON.parse(result.content.map((item: any) => item.text).join("\n"));
}

function sessionCookie(value: unknown): string {
  const raw = Array.isArray(value) ? value.join(", ") : String(value || "");
  const match = /PHPSESSID=([^;,]+)/i.exec(raw);
  return match ? `PHPSESSID=${match[1]}` : "";
}

function userToken(html: string): string {
  return /name=['"]user_token['"]\s+value=['"]([^'"]+)['"]/i.exec(html)?.[1] || "";
}

function reproductionPoc(test: SmokeTest, verify: any): string {
  const details = verify.details || {};
  if (details.injected_payload) return `${test.finding.reproduction} Payload: ${details.injected_payload}`;
  if (details.true_payload && details.false_payload) return `${test.finding.reproduction} True: ${details.true_payload}; false: ${details.false_payload}`;
  return test.finding.reproduction;
}

async function evidenceQuality(results: SmokeTestResult[]): Promise<Record<string, unknown>> {
  const verifierEvidence = [];
  for (const result of results) {
    const evidenceId = result.verifier?.evidence_id;
    if (!evidenceId) continue;
    const evidence = await runtime.evidence.read(evidenceId) as any;
    const data = evidence?.data || {};
    verifierEvidence.push({
      test: result.id,
      evidence_id: evidenceId,
      confirmed: Boolean(data.confirmed),
      request_count: Array.isArray(data.requests) ? data.requests.length : 0,
      has_baseline: Array.isArray(data.requests) && data.requests.some((request: any) => request.marker === "baseline"),
      has_comparator: hasComparator(result.id, data),
      has_marker: Array.isArray(data.requests) && data.requests.some((request: any) => request.marker && request.marker !== "baseline"),
      has_payload: Boolean(data.details?.injected_payload || data.details?.true_payload || data.details?.payload),
      has_excerpt: Boolean(data.details?.response_excerpt || data.details?.true_excerpt || data.details?.false_excerpt),
      reason: data.reason,
    });
  }
  const strong = verifierEvidence.filter((item) =>
    item.confirmed &&
    item.request_count >= 2 &&
    item.has_comparator &&
    item.has_marker &&
    item.has_payload &&
    item.has_excerpt
  ).length;
  return {
    verifier_evidence_total: verifierEvidence.length,
    verifier_evidence_strong: strong,
    strong_percent: verifierEvidence.length ? Math.round((strong / verifierEvidence.length) * 100) : 0,
    verifier_evidence: verifierEvidence,
  };
}

function hasComparator(testId: string, data: any): boolean {
  if (!Array.isArray(data.requests) || data.requests.length < 2) return false;
  if (data.requests.some((request: any) => request.marker === "baseline")) return true;
  if (testId === "blind-sql-injection") {
    return Boolean(data.details?.true_payload && data.details?.false_payload);
  }
  return false;
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]!;
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      index += 1;
    } else {
      out[key] = "true";
    }
  }
  if (!out["task-id"]) out["task-id"] = randomUUID();
  return out;
}
