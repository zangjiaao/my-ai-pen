import type { ToolRuntime } from "../types.js";
import { targetBase } from "../tools/common.js";
import { isNoiseEndpoint, isObjectLikeResourcePath } from "./detection-conversion.js";

type ObservedRequest = {
  method?: string;
  url?: string;
  requestBody?: string;
  responseBody?: string;
  evidenceIds?: string[];
  source?: string;
};

type ObservedUrl = {
  method: string;
  url: string;
  primary: boolean;
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
  const observations = observedUrls(input)
    .filter((observed) => observedInScope(runtime, observed.url, input.url))
    .filter((observed) => {
      try {
        return !isNoiseEndpoint(new URL(observed.url).pathname);
      } catch {
        return false;
      }
    });
  for (const observed of observations) {
    upsertSurface(runtime, observed.method, observed.url, input.evidenceIds || [], input.source);
    const candidates = inferCandidates(
      observed.method,
      observed.url,
      observed.primary ? input.requestBody || "" : "",
      observed.primary ? input.responseBody || "" : "",
    );
    for (const candidate of candidates) {
      if (isNoiseEndpoint(candidate.endpoint)) continue;
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

function observedUrls(input: ObservedRequest): ObservedUrl[] {
  const out: ObservedUrl[] = [];
  if (input.url && validUrl(input.url)) out.push({ method: (input.method || "GET").toUpperCase(), url: input.url, primary: true });
  const text = `${input.responseBody || ""}\n${input.requestBody || ""}`;
  const base = input.url ? baseUrl(input.url) : "";
  for (const match of text.matchAll(/(?:https?:\/\/[^\s"'<>]+|vulnerabilities\/[a-z0-9_/-]+\/?(?:\?[^\s"'<>]*)?)/gi)) {
    const raw = match[0].replace(/&amp;/g, "&");
    try {
      const url = raw.startsWith("http") ? raw : new URL(raw, base || "http://localhost/").toString();
      out.push({ method: "GET", url, primary: sameUrl(url, input.url || "") });
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

function observedInScope(runtime: ToolRuntime, rawUrl: string, observedFrom?: string): boolean {
  if (!validUrl(rawUrl)) return false;
  const allow = Array.isArray(runtime.task.scope?.allow) ? runtime.task.scope.allow : [];
  if (allow.length > 0) return allow.some((entry) => typeof entry === "string" && strictScopeMatch(rawUrl, entry));
  const base = targetBase(runtime) || observedFrom;
  if (!base) return true;
  return strictScopeMatch(rawUrl, base);
}

function strictScopeMatch(rawUrl: string, rawScope: string): boolean {
  try {
    const target = new URL(rawUrl);
    const scoped = new URL(/^https?:\/\//i.test(rawScope) ? rawScope : `http://${rawScope}`);
    if (target.hostname !== scoped.hostname) return false;
    if (target.port && scoped.port && target.port !== scoped.port) return false;
    const scopedPath = scoped.pathname.replace(/\/+$/, "");
    return !scopedPath || scopedPath === "/" || target.pathname === scopedPath || target.pathname.startsWith(`${scopedPath}/`);
  } catch {
    return false;
  }
}

function inferCandidates(method: string, rawUrl: string, requestBody: string, responseBody: string): TestCandidate[] {
  const url = new URL(rawUrl);
  const endpoint = url.pathname;
  if (isNoiseEndpoint(endpoint)) return [];
  const observedParams = requestParams(url, requestBody, responseBody);
  const candidates: TestCandidate[] = [];
  for (const test of routeHintTests(endpoint, responseBody, observedParams, method)) {
    candidates.push({ ...test, endpoint, method });
  }
  for (const param of observedParams) {
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

function routeHintTests(
  endpoint: string,
  html: string,
  observedParams: string[],
  method: string,
): Omit<TestCandidate, "endpoint" | "method">[] {
  const route = endpoint.toLowerCase();
  const tests: Omit<TestCandidate, "endpoint" | "method">[] = [];
  const paramSet = new Set(observedParams.map((p) => p.toLowerCase()));
  const add = (param: string, vulnClass: string, title: string, notes: string, priority = 240) => {
    tests.push({ param, vulnClass, title, notes, priority });
  };
  if (hasAny(route, ["brute", "login"]) && hasAllText(html, ["username", "password"])) {
    add("username,password", "brute-force", "Verify brute-force/default credential behavior", "Try controlled valid/invalid credential pairs and record success/failure response differences.", 222);
  }
  if (hasAny(route, ["login", "auth", "whoami", "token", "session", "jwt"])) {
    add("authorization", "jwt-alg-none", "Verify JWT/session algorithm or unsigned token handling", "If a bearer/JWT is observed, probe unsigned or alg-none style token acceptance against a protected endpoint.", 250);
    add("session", "weak-session-id", "Verify weak session/token predictability", "Generate multiple IDs or tokens, store samples, and analyze sequence or entropy.", 226);
  }
  if (hasAny(route, ["exec", "command", "ping"]) || /\bname=["']ip["']/i.test(html)) {
    add("ip", "command-injection", "Verify command injection in command-like parameter", "Submit a harmless command separator payload and prove command output or side-channel behavior.", 220);
  }
  if (route.includes("csrf") || (hasAny(route, ["password", "account"]) && hasAllText(html, ["password", "confirm"]))) {
    add("password_new,password_conf", "csrf", "Verify CSRF on state-changing form", "Perform a state-changing request without a CSRF token and verify the state changed, then restore state.", 224);
  }
  if (hasAny(route, ["include", "file", "path", "page", "ftp", "download", "document"]) && !/type=["']file["']/i.test(html)) {
    add("page", "path-traversal", "Verify path traversal / arbitrary file read", "Compare baseline path with traversal payloads and look for file content markers.", 245);
    add("page", "file-inclusion", "Verify file inclusion/path traversal", "Compare baseline include page with a controlled local file read.", 221);
  }
  if (route.includes("upload") || /type=["']file["']/i.test(html)) {
    add("uploaded", "file-upload", "Verify arbitrary file upload and reachable landing path", "Use multipart upload, capture the reported server path, then request the uploaded file and prove read or execution.", 223);
  }
  if (route.includes("captcha") || html.toLowerCase().includes("captcha")) {
    add("captcha,step", "insecure-captcha", "Verify CAPTCHA server-side workflow enforcement", "Replay or mutate CAPTCHA workflow parameters and prove whether server-side validation can be bypassed.", 229);
  }
  // Injection: only invent params that match the surface (do not put q= on login).
  if (hasAny(route, ["sqli", "sql", "query", "search"]) && route.includes("blind")) {
    add(pickParam(paramSet, ["id", "q", "query"], "id"), "blind-sql-injection", "Verify blind SQL injection with controlled boolean pair", "Use true/false predicates such as AND 1=1 and AND 1=2, not only malformed input.", 225);
  } else if (hasAny(route, ["sqli", "sql", "query", "search", "filter"])) {
    add(pickParam(paramSet, ["q", "query", "search", "filter", "id"], "q"), "sql-injection", "Verify SQL injection in lookup/search parameter", "Use error, boolean, or UNION evidence and record request/response differences.", 240);
  } else if (hasAny(route, ["login", "signin", "authenticate"])) {
    add(pickParam(paramSet, ["email", "username", "user", "login", "password"], "email,password"), "sql-injection", "Verify SQL injection in authentication fields", "Probe email/username/password with controlled boolean or error-based payloads; compare to valid/invalid baselines.", 245);
  }
  // IDOR: real object collections only — never bare /api or /rest roots (filtered as noise).
  if (isObjectLikeResourcePath(endpoint) && !hasAny(route, ["search", "login", "register", "signup", "whoami"])) {
    const idParam = pickParam(paramSet, ["id", "user_id", "userid", "order_id", "basket_id", "item_id"], "id");
    add(idParam, "idor", "Verify direct object reference / authorization isolation", "Replay object identifiers across auth states or adjacent IDs and prove unauthorized data access.", 255);
  }
  if (hasAny(route, ["register", "signup", "users"]) && (methodLooksWritable(html) || methodLooksWritableMethod(method) || route.includes("api"))) {
    add(pickParam(paramSet, ["role", "isadmin", "admin", "privilege"], "role"), "mass-assignment", "Verify mass assignment / privileged field injection", "Submit extra privileged fields (role/admin/isAdmin) during create/update and prove privilege change.", 252);
  }
  if (hasAny(route, ["redirect", "return", "next", "url", "link", "to"]) && !hasAny(route, ["login"])) {
    // Only when route itself suggests redirect, or observed redirect-ish params.
    if (hasAny(route, ["redirect", "return", "next"]) || [...paramSet].some((p) => /url|redirect|next|return|to/.test(p))) {
      add(pickParam(paramSet, ["url", "redirect", "next", "return", "to", "link"], "url"), "open-redirect", "Verify open redirect allowlist bypass", "Inject an external absolute URL into redirect parameters and prove off-site Location/navigation.", 248);
    }
  }
  if (hasAny(route, ["xss", "dom", "search", "track"]) || [...paramSet].some((p) => ["q", "query", "search", "name", "message", "comment"].includes(p))) {
    const stored = hasAny(route, ["stored", "guest", "_s", "-s"]) || hasAny(html.toLowerCase(), ["guestbook", "textarea"]);
    const dom = hasAny(route, ["dom", "_d", "-d"]);
    const reflected = hasAny(route, ["reflected", "_r", "-r", "search", "q"]) || !stored;
    if (stored) add("txtName,mtxMessage", "xss-stored", "Verify stored XSS with second retrieval", "Submit a short payload that fits field limits, retrieve the page again, and prove persistence/execution.", 225);
    if (dom) add("default", "xss-dom", "Verify DOM XSS execution", "Use browser navigation with query/hash payload and capture a DOM/dialog effect.", 227);
    if (reflected) add(pickParam(paramSet, ["q", "query", "search", "name", "message", "comment"], "q"), "xss-reflected", "Verify reflected XSS execution context", "Prove executable JavaScript context, preferably with browser-observed dialog or DOM marker.", 244);
  }
  if (route.includes("csp") || html.toLowerCase().includes("content-security-policy")) {
    add("policy,payload", "csp-bypass", "Verify CSP bypass", "Record CSP policy, identify allowed sources, and prove a bypass payload executes.", 228);
  }
  if (route.includes("javascript") || route.includes("client")) {
    add("token,phrase", "javascript-logic", "Verify client-side JavaScript logic bypass", "Analyze client-side validation logic and prove server accepts the derived or bypassed value.", 228);
  }
  return tests;
}

function pickParam(paramSet: Set<string>, preferred: string[], fallback: string): string {
  for (const name of preferred) {
    if (paramSet.has(name.toLowerCase())) return name;
  }
  return fallback;
}

function methodLooksWritableMethod(method: string): boolean {
  return ["POST", "PUT", "PATCH", "DELETE"].includes(String(method || "").toUpperCase());
}

function methodLooksWritable(html: string): boolean {
  return /method=["']post["']|application\/json|"role"|password/i.test(html);
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
  for (const key of requestBodyParams(body)) params.add(key);
  for (const match of html.matchAll(/\bname=["']?([a-zA-Z0-9_-]+)["']?/g)) params.add(match[1]);
  return [...params].filter((param) => !["Submit", "Login", "btnSign", "btnClear", "user_token"].includes(param));
}

function requestBodyParams(body: string): string[] {
  const params = new Set<string>();
  if (!body) return [];
  if (/Content-Disposition:\s*form-data/i.test(body)) {
    for (const match of body.matchAll(/Content-Disposition:\s*form-data;[^\n\r]*\bname=["']([^"'\r\n]+)["']/gi)) {
      params.add(match[1]);
    }
    return [...params];
  }
  if (!body.includes("=") || /WebKitFormBoundary|Content-Disposition/i.test(body)) return [];
  try {
    for (const key of new URLSearchParams(body).keys()) {
      if (key && /^[a-zA-Z0-9_-]+$/.test(key)) params.add(key);
    }
  } catch {
    return [];
  }
  return [...params];
}

function genericVulnClass(param: string, endpoint: string, html: string): string | undefined {
  const name = param.toLowerCase();
  const lowered = `${param} ${endpoint}`.toLowerCase();
  if (lowered.includes("file") || name === "uploaded" || /type=["']file["']/i.test(html)) return "file-upload";
  if (["page", "path", "file", "doc", "document"].includes(name) || /ftp|download|static/.test(lowered)) return "path-traversal";
  if (["q", "query", "search", "filter", "email", "id"].includes(name) || /search|login|query/.test(lowered)) return "sql-injection";
  if (["userid", "user_id", "orderid", "order_id", "basketid", "basket_id"].includes(name) || /\/\d+(\/|$)/.test(endpoint)) return "idor";
  if (["role", "isadmin", "admin", "privilege", "type"].includes(name) || /register|signup|users/.test(lowered)) return "mass-assignment";
  if (["name", "message", "txtname", "mtxmessage", "comment"].includes(name)) return "xss-reflected";
  if (name.includes("url") || name.includes("redirect") || name.includes("next") || name.includes("return")) return "open-redirect";
  if (name.includes("token") || name.includes("jwt") || name.includes("authorization")) return "jwt-alg-none";
  if (lowered.includes("password") && !/login/.test(lowered)) return "csrf";
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

function unique(values: ObservedUrl[]): ObservedUrl[] {
  const seen = new Set<string>();
  const out: ObservedUrl[] = [];
  for (const value of values) {
    const key = `${value.method} ${value.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
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

function sameUrl(left: string, right: string): boolean {
  if (!left || !right) return false;
  try {
    const leftUrl = new URL(left);
    const rightUrl = new URL(right);
    leftUrl.hash = "";
    rightUrl.hash = "";
    return leftUrl.toString() === rightUrl.toString();
  } catch {
    return false;
  }
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 100) || "item";
}
