import type { ToolRuntime } from "../types.js";

type ObservedRequest = {
  method?: string;
  url?: string;
  requestBody?: string;
  responseBody?: string;
  evidenceIds?: string[];
  source?: string;
};

type TestCandidate = {
  endpoint: string;
  method: string;
  param: string;
  vulnClass: string;
  title: string;
  notes: string;
  priority: number;
};

export async function observeAttackSurface(runtime: ToolRuntime, input: ObservedRequest): Promise<void> {
  const observations = observedUrls(input);
  for (const observed of observations) {
    upsertSurface(runtime, observed.method, observed.url, input.evidenceIds || [], input.source);
    const candidates = inferCandidates(observed.method, observed.url, input.requestBody || "", input.responseBody || "");
    for (const candidate of candidates) {
      runtime.plan.upsert({
        node_id: testNodeId(candidate.endpoint, candidate.param, candidate.vulnClass),
        title: candidate.title,
        status: "pending",
        kind: "test",
        level: "work_item",
        parent_id: "plan-objective-analysis-test-plan",
        method: candidate.method,
        endpoint: candidate.endpoint,
        parameter: candidate.param,
        parameters: splitParams(candidate.param),
        vuln_type: candidate.vulnClass,
        result: "inconclusive",
        notes: candidate.notes,
        evidence_ids: input.evidenceIds || [],
        priority: candidate.priority,
        source: "auditor",
      });
      await runtime.coverage.mark({
        endpoint: candidate.endpoint,
        param: candidate.param,
        vulnClass: candidate.vulnClass,
        status: "observed",
        notes: candidate.notes,
      });
    }
  }
}

function observedUrls(input: ObservedRequest): Array<{ method: string; url: string }> {
  const out: Array<{ method: string; url: string }> = [];
  if (input.url && validUrl(input.url)) out.push({ method: (input.method || "GET").toUpperCase(), url: input.url });
  const text = `${input.responseBody || ""}\n${input.requestBody || ""}`;
  const base = input.url ? baseUrl(input.url) : "";
  for (const match of text.matchAll(/(?:https?:\/\/[^\s"'<>]+|vulnerabilities\/[a-z0-9_/-]+\/?(?:\?[^\s"'<>]*)?)/gi)) {
    const raw = match[0].replace(/&amp;/g, "&");
    try {
      out.push({ method: "GET", url: raw.startsWith("http") ? raw : new URL(raw, base || "http://localhost/").toString() });
    } catch {
      // Ignore malformed snippets from HTML or scanner text.
    }
  }
  return unique(out);
}

function validUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function inferCandidates(method: string, rawUrl: string, requestBody: string, responseBody: string): TestCandidate[] {
  const url = new URL(rawUrl);
  const endpoint = url.pathname;
  const candidates: TestCandidate[] = [];
  for (const test of routeHintTests(endpoint, responseBody)) candidates.push({ ...test, endpoint, method });
  for (const param of requestParams(url, requestBody, responseBody)) {
    const vulnClass = genericVulnClass(param, endpoint, responseBody);
    if (!vulnClass) continue;
    candidates.push({
      endpoint,
      method,
      param,
      vulnClass,
      title: `Verify ${vulnClass} on ${param}`,
      notes: "Inferred from observed request/form parameter. Verify with a controlled payload and concrete response evidence.",
      priority: 260,
    });
  }
  return dedupeCandidates(candidates);
}

function routeHintTests(endpoint: string, html: string): Omit<TestCandidate, "endpoint" | "method">[] {
  const route = endpoint.toLowerCase();
  const tests: Omit<TestCandidate, "endpoint" | "method">[] = [];
  const add = (param: string, vulnClass: string, title: string, notes: string, priority = 240) => {
    tests.push({ param, vulnClass, title, notes, priority });
  };
  if (hasAny(route, ["brute", "login"]) && hasAllText(html, ["username", "password"])) {
    add("username,password", "brute-force", "Verify brute-force/default credential behavior", "Try controlled valid/invalid credential pairs and record success/failure response differences.", 222);
  }
  if (hasAny(route, ["exec", "command", "ping"]) || /\bname=["']ip["']/i.test(html)) {
    add("ip", "command-injection", "Verify command injection in command-like parameter", "Submit a harmless command separator payload and prove command output or side-channel behavior.", 220);
  }
  if (route.includes("csrf") || (hasAny(route, ["password", "account"]) && hasAllText(html, ["password", "confirm"]))) {
    add("password_new,password_conf", "csrf", "Verify CSRF on state-changing form", "Perform a state-changing request without a CSRF token and verify the state changed, then restore state.", 224);
  }
  if (hasAny(route, ["include", "file", "path", "page"]) && !/type=["']file["']/i.test(html)) {
    add("page", "file-inclusion", "Verify file inclusion/path traversal", "Compare baseline include page with a controlled local file read.", 221);
  }
  if (route.includes("upload") || /type=["']file["']/i.test(html)) {
    add("uploaded", "file-upload", "Verify arbitrary file upload and reachable landing path", "Use multipart upload, capture the reported server path, then request the uploaded file and prove read or execution.", 223);
  }
  if (route.includes("captcha") || html.toLowerCase().includes("captcha")) {
    add("captcha,step", "insecure-captcha", "Verify CAPTCHA server-side workflow enforcement", "Replay or mutate CAPTCHA workflow parameters and prove whether server-side validation can be bypassed.", 229);
  }
  if (hasAny(route, ["sqli", "sql", "query"]) && route.includes("blind")) {
    add("id", "blind-sql-injection", "Verify blind SQL injection with controlled boolean pair", "Use true/false predicates such as AND 1=1 and AND 1=2, not only malformed input.", 225);
  } else if (hasAny(route, ["sqli", "sql", "query"])) {
    add("id", "sql-injection", "Verify SQL injection in data lookup parameter", "Use error, boolean, or UNION evidence and record request/response differences.", 220);
  }
  if (hasAny(route, ["weak", "session", "token"])) {
    add("session", "weak-session-id", "Verify weak session/token predictability", "Generate multiple IDs or tokens, store samples, and analyze sequence or entropy.", 226);
  }
  if (hasAny(route, ["xss", "dom"])) {
    const stored = hasAny(route, ["stored", "guest", "_s", "-s"]) || hasAny(html.toLowerCase(), ["guestbook", "textarea"]);
    const dom = hasAny(route, ["dom", "_d", "-d"]);
    const reflected = hasAny(route, ["reflected", "_r", "-r"]) || !stored;
    if (stored) add("txtName,mtxMessage", "xss-stored", "Verify stored XSS with second retrieval", "Submit a short payload that fits field limits, retrieve the page again, and prove persistence/execution.", 225);
    if (dom) add("default", "xss-dom", "Verify DOM XSS execution", "Use browser navigation with query/hash payload and capture a DOM/dialog effect.", 227);
    if (reflected) add("name", "xss-reflected", "Verify reflected XSS execution context", "Prove executable JavaScript context, preferably with browser-observed dialog or DOM marker.", 224);
  }
  if (route.includes("csp") || html.toLowerCase().includes("content-security-policy")) {
    add("policy,payload", "csp-bypass", "Verify CSP bypass", "Record CSP policy, identify allowed sources, and prove a bypass payload executes.", 228);
  }
  if (route.includes("javascript") || route.includes("client")) {
    add("token,phrase", "javascript-logic", "Verify client-side JavaScript logic bypass", "Analyze client-side validation logic and prove server accepts the derived or bypassed value.", 228);
  }
  return tests;
}

function upsertSurface(runtime: ToolRuntime, method: string, rawUrl: string, evidenceIds: string[], source?: string): void {
  const url = new URL(rawUrl);
  runtime.plan.upsert({
    node_id: `plan-surface-${slug(`${method}-${url.pathname}`)}`,
    title: `${method.toUpperCase()} ${url.pathname}`,
    status: "done",
    kind: "surface",
    level: "work_item",
    parent_id: "plan-objective-recon-attack-surface",
    method: method.toUpperCase(),
    endpoint: url.pathname,
    parameters: [...url.searchParams.keys()],
    evidence_ids: evidenceIds,
    priority: 180,
    source: source || "auditor",
  });
}

function requestParams(url: URL, body: string, html: string): string[] {
  const params = new Set<string>();
  for (const key of url.searchParams.keys()) params.add(key);
  for (const key of new URLSearchParams(body).keys()) params.add(key);
  for (const match of html.matchAll(/\bname=["']?([a-zA-Z0-9_-]+)["']?/g)) params.add(match[1]);
  return [...params].filter((param) => !["Submit", "Login", "btnSign", "btnClear", "user_token"].includes(param));
}

function genericVulnClass(param: string, endpoint: string, html: string): string | undefined {
  const lowered = `${param} ${endpoint}`.toLowerCase();
  if (lowered.includes("file") || param === "uploaded" || /type=["']file["']/i.test(html)) return "file-upload";
  if (["id", "user", "uid"].includes(param.toLowerCase())) return "injection";
  if (["name", "message", "txtname", "mtxmessage"].includes(param.toLowerCase())) return "xss";
  if (lowered.includes("url") || lowered.includes("redirect")) return "open-redirect";
  if (lowered.includes("password")) return "csrf";
  return undefined;
}

function dedupeCandidates(candidates: TestCandidate[]): TestCandidate[] {
  const seen = new Set<string>();
  const out: TestCandidate[] = [];
  for (const candidate of candidates) {
    const key = `${candidate.endpoint}\0${candidate.param}\0${candidate.vulnClass}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
  }
  return out;
}

function unique(values: Array<{ method: string; url: string }>): Array<{ method: string; url: string }> {
  const seen = new Set<string>();
  const out: Array<{ method: string; url: string }> = [];
  for (const value of values) {
    const key = `${value.method} ${value.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function testNodeId(endpoint: string, param: string, vulnClass: string): string {
  return `plan-test-${slug(`${endpoint}-${param}-${vulnClass}`)}`;
}

function splitParams(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function hasAny(value: string, needles: string[]): boolean {
  return needles.some((needle) => value.includes(needle));
}

function hasAllText(value: string, needles: string[]): boolean {
  const lowered = value.toLowerCase();
  return needles.every((needle) => lowered.includes(needle));
}

function baseUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  return `${url.protocol}//${url.host}/`;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 100) || "item";
}
