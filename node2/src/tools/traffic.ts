import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ToolRuntime } from "../types.js";
import { observeAttackSurface } from "../runtime/coverage-auditor.js";
import { emitToolEvidence, isInScope, jsonResult, resolveTargetUrl, textResult } from "./common.js";
import { sendHttp } from "./http.js";

export function createTrafficTool(runtime: ToolRuntime): ToolDefinition<any> {
  return {
    name: "traffic",
    label: "Traffic",
    description: "Inspect, sync, replay, and mutate captured traffic. Actions: list, get, endpoints, candidates, analyze, repeat, mutate, source_status, source_list, source_get, sync, snapshot, add_snapshot, add. Use this before testing so authenticated requests and real parameters are not missed.",
    promptSnippet: "Inspect/replay captured traffic and session snapshots",
    promptGuidelines: [
      "Use traffic(endpoints) to build the attack-surface list before choosing scan or http probes.",
      "Use traffic(candidates) or traffic(analyze) to select high-value replayable requests after browser or scanner discovery.",
      "When an external proxy/source is configured, use traffic(source_status) and traffic(sync) after browsing so proxy-captured requests become Node2 replay candidates.",
      "Use traffic(repeat) for a baseline request and traffic(mutate) for bounded parameter/header/body changes before verifier/finding.",
      "Use traffic(snapshot) to recover cookies/session state before authenticated http replay.",
    ],
    parameters: Type.Object({
      action: Type.String(),
      id: Type.Optional(Type.String()),
      url_contains: Type.Optional(Type.String()),
      method: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Number()),
      snapshot: Type.Optional(Type.Record(Type.String(), Type.Any())),
      headers: Type.Optional(Type.Record(Type.String(), Type.String())),
      body: Type.Optional(Type.String()),
      url: Type.Optional(Type.String()),
      status: Type.Optional(Type.Number()),
      request_headers: Type.Optional(Type.Record(Type.String(), Type.String())),
      request_body: Type.Optional(Type.String()),
      response_headers: Type.Optional(Type.Record(Type.String(), Type.String())),
      response_body: Type.Optional(Type.String()),
      source: Type.Optional(Type.String()),
      param: Type.Optional(Type.String()),
      value: Type.Optional(Type.String()),
      mutations: Type.Optional(Type.Record(Type.String(), Type.String())),
    }),
    async execute(_toolCallId: string, params: any) {
      if (params.action === "list") {
        return jsonResult(runtime.traffic.list({ urlContains: params.url_contains, method: params.method, limit: params.limit }));
      }
      if (params.action === "get") {
        if (!params.id) return textResult("error: id is required");
        return jsonResult(runtime.traffic.get(params.id) || { error: `not found: ${params.id}` });
      }
      if (params.action === "endpoints") return jsonResult(runtime.traffic.endpoints());
      if (params.action === "candidates") return jsonResult(runtime.traffic.candidates(params.limit));
      if (params.action === "analyze") return jsonResult(analyzeTraffic(runtime, params.limit));
      if (params.action === "repeat") return repeatTraffic(runtime, params);
      if (params.action === "mutate") return mutateTraffic(runtime, params);
      if (params.action === "source_status") return sourceStatus(runtime);
      if (params.action === "source_list") return sourceList(runtime, params);
      if (params.action === "source_get") return sourceGet(runtime, params);
      if (params.action === "sync") return syncExternalTraffic(runtime, params);
      if (params.action === "snapshot") return jsonResult(runtime.traffic.snapshot() || {});
      if (params.action === "add_snapshot") {
        if (!params.snapshot) return textResult("error: snapshot is required");
        runtime.traffic.setSnapshot(params.snapshot);
        return textResult("snapshot stored");
      }
      if (params.action === "add") {
        const url = params.url ? resolveTargetUrl(runtime, params.url) : "";
        if (!url) return textResult("error: url is required");
        if (!isInScope(runtime, url)) throw new Error(`out of scope: ${url}`);
        const trafficId = runtime.traffic.add({
          source: params.source || "external",
          method: (params.method || "GET").toUpperCase(),
          url,
          status: params.status,
          requestHeaders: params.request_headers || params.headers || {},
          requestBody: params.request_body || params.body,
          responseHeaders: params.response_headers || {},
          responseBody: params.response_body,
        });
        await observeAttackSurface(runtime, {
          method: params.method || "GET",
          url,
          requestBody: params.request_body || params.body,
          responseBody: params.response_body,
          source: params.source || "traffic.add",
        });
        return jsonResult({ traffic_id: trafficId });
      }
      return textResult("error: action must be list, get, endpoints, candidates, analyze, repeat, mutate, source_status, source_list, source_get, sync, snapshot, add_snapshot, or add");
    },
  };
}

async function sourceStatus(runtime: ToolRuntime) {
  if (!runtime.externalTrafficSource) return jsonResult({ configured: false });
  return jsonResult(await runtime.externalTrafficSource.status());
}

async function sourceList(runtime: ToolRuntime, params: any) {
  if (!runtime.externalTrafficSource) return textResult("error: no external traffic source configured");
  const rows = await runtime.externalTrafficSource.list({
    urlContains: params.url_contains,
    method: params.method,
    limit: params.limit,
  });
  return jsonResult(rows);
}

async function sourceGet(runtime: ToolRuntime, params: any) {
  if (!runtime.externalTrafficSource) return textResult("error: no external traffic source configured");
  if (!params.id) return textResult("error: id is required");
  return jsonResult((await runtime.externalTrafficSource.get(params.id)) || { error: `not found: ${params.id}` });
}

async function syncExternalTraffic(runtime: ToolRuntime, params: any) {
  if (!runtime.externalTrafficSource) return textResult("error: no external traffic source configured");
  const rows = await runtime.externalTrafficSource.list({
    urlContains: params.url_contains,
    method: params.method,
    limit: params.limit || 100,
  });
  const synced: Array<{ source_id?: string; traffic_id: string; method: string; url: string; status?: number; tags?: string[] }> = [];
  const skipped: Array<{ source_id?: string; url?: string; reason: string }> = [];
  for (const row of rows) {
    if (!row.url || !/^https?:\/\//i.test(row.url)) {
      skipped.push({ source_id: row.id, url: row.url, reason: "missing or unsupported url" });
      continue;
    }
    if (!isInScope(runtime, row.url)) {
      skipped.push({ source_id: row.id, url: row.url, reason: "out of scope" });
      continue;
    }
    const trafficId = runtime.traffic.add(row);
    synced.push({
      source_id: row.id,
      traffic_id: trafficId,
      method: row.method,
      url: row.url,
      status: row.status,
      tags: row.tags,
    });
    await observeAttackSurface(runtime, {
      method: row.method,
      url: row.url,
      requestBody: row.requestBody,
      responseBody: row.responseBody,
      source: `traffic.sync:${row.source || runtime.externalTrafficSource.kind}`,
    });
  }
  await runtime.platform.send({
    type: "traffic_synced",
    conversation_id: runtime.task.conversationId,
    task_id: runtime.task.taskId,
    source: runtime.externalTrafficSource.kind,
    synced: synced.length,
    skipped: skipped.length,
  });
  return jsonResult({
    source: runtime.externalTrafficSource.kind,
    synced_count: synced.length,
    skipped_count: skipped.length,
    synced,
    skipped,
    analyze: analyzeTraffic(runtime, 200),
  });
}

async function repeatTraffic(runtime: ToolRuntime, params: any) {
  if (!params.id) return textResult("error: id is required");
  const base = runtime.traffic.get(params.id);
  if (!base) return textResult(`error: traffic id not found: ${params.id}`);
  if (!isInScope(runtime, base.url)) throw new Error(`out of scope: ${base.url}`);
  const headers = { ...(base.requestHeaders || {}), ...(params.headers || {}) };
  const body = params.body !== undefined ? params.body : base.requestBody;
  const result = await sendHttp({ method: base.method, url: base.url, headers, body, proxyUrl: runtime.trafficProxyUrl });
  const trafficId = runtime.traffic.add({
    source: "traffic.repeat",
    parentTrafficId: params.id,
    method: base.method,
    url: base.url,
    status: result.status,
    requestHeaders: headers,
    requestBody: body,
    responseHeaders: result.headers,
    responseBody: result.body,
  });
  const evidenceId = await emitToolEvidence(runtime, "traffic", `repeat ${base.method} ${base.url} -> ${result.status}`, { parentTrafficId: params.id, trafficId, ...result });
  await observeAttackSurface(runtime, { method: base.method, url: base.url, requestBody: body, responseBody: result.body, evidenceIds: [evidenceId], source: "traffic.repeat" });
  return jsonResult({ traffic_id: trafficId, evidence_id: evidenceId, parent_traffic_id: params.id, ...result }, { evidenceId, trafficId });
}

async function mutateTraffic(runtime: ToolRuntime, params: any) {
  if (!params.id) return textResult("error: id is required");
  const base = runtime.traffic.get(params.id);
  if (!base) return textResult(`error: traffic id not found: ${params.id}`);
  const mutations = { ...(params.mutations || {}) };
  if (params.param && params.value !== undefined) mutations[params.param] = String(params.value);
  if (!Object.keys(mutations).length) return textResult("error: mutate requires param/value or mutations");
  const mutated = mutateRequest(base.url, base.requestBody, base.requestHeaders || {}, mutations);
  if (!isInScope(runtime, mutated.url)) throw new Error(`out of scope: ${mutated.url}`);
  const result = await sendHttp({ method: base.method, url: mutated.url, headers: mutated.headers, body: mutated.body, proxyUrl: runtime.trafficProxyUrl });
  const trafficId = runtime.traffic.add({
    source: "traffic.mutate",
    parentTrafficId: params.id,
    method: base.method,
    url: mutated.url,
    status: result.status,
    requestHeaders: mutated.headers,
    requestBody: mutated.body,
    responseHeaders: result.headers,
    responseBody: result.body,
  });
  const evidenceId = await emitToolEvidence(runtime, "traffic", `mutate ${base.method} ${mutated.url} -> ${result.status}`, {
    parentTrafficId: params.id,
    trafficId,
    mutations,
    ...result,
  });
  await observeAttackSurface(runtime, { method: base.method, url: mutated.url, requestBody: mutated.body, responseBody: result.body, evidenceIds: [evidenceId], source: "traffic.mutate" });
  return jsonResult({ traffic_id: trafficId, evidence_id: evidenceId, parent_traffic_id: params.id, mutations, ...result }, { evidenceId, trafficId });
}

function mutateRequest(rawUrl: string, body: string | undefined, headers: Record<string, string>, mutations: Record<string, string>): { url: string; headers: Record<string, string>; body?: string } {
  const nextHeaders = { ...headers };
  const contentType = nextHeaders["content-type"] || nextHeaders["Content-Type"] || "";
  let nextBody = body;
  const url = new URL(rawUrl);
  let changedQuery = false;
  for (const [key, value] of Object.entries(mutations)) {
    if (url.searchParams.has(key)) {
      url.searchParams.set(key, value);
      changedQuery = true;
    }
  }
  if (!changedQuery && body !== undefined) {
    if (/application\/json/i.test(contentType)) {
      try {
        const parsed = JSON.parse(body);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          for (const [key, value] of Object.entries(mutations)) parsed[key] = value;
          nextBody = JSON.stringify(parsed);
        }
      } catch {
        nextBody = body;
      }
    } else {
      const form = new URLSearchParams(body);
      for (const [key, value] of Object.entries(mutations)) form.set(key, value);
      nextBody = form.toString();
      if (!contentType) nextHeaders["content-type"] = "application/x-www-form-urlencoded";
    }
  }
  if (!changedQuery && body === undefined) {
    for (const [key, value] of Object.entries(mutations)) url.searchParams.set(key, value);
  }
  return { url: url.toString(), headers: nextHeaders, body: nextBody };
}

function analyzeTraffic(runtime: ToolRuntime, limit?: number): Record<string, unknown> {
  const rows = runtime.traffic.list({ limit: limit || 200 });
  const endpoints = runtime.traffic.endpoints();
  const candidates = runtime.traffic.candidates(20);
  const byParam: Record<string, number> = {};
  const byTag: Record<string, number> = {};
  for (const row of rows) {
    for (const param of paramsFor(row.url, row.requestBody || "", row.requestHeaders || {})) byParam[param] = (byParam[param] || 0) + 1;
    for (const tag of row.tags || []) byTag[tag] = (byTag[tag] || 0) + 1;
  }
  return {
    total: rows.length,
    endpoints,
    by_param: byParam,
    by_tag: byTag,
    high_value_candidates: candidates.map((row) => ({
      id: row.id,
      method: row.method,
      url: row.url,
      status: row.status,
      tags: row.tags || [],
    })),
    recommendations: recommendations(candidates),
  };
}

function recommendations(candidates: ReturnType<ToolRuntime["traffic"]["candidates"]>): string[] {
  if (!candidates.length) return ["Capture traffic with browser/http first, then rerun traffic(analyze)."];
  const out = ["Run traffic(repeat) on one high-value request to establish a baseline before mutating it."];
  if (candidates.some((row) => (row.tags || []).includes("parameterized"))) out.push("Use traffic(mutate) against parameterized requests, then compare baseline and mutated responses.");
  if (candidates.some((row) => (row.tags || []).includes("authenticated-context"))) out.push("Preserve cookies/authorization headers from captured authenticated traffic during replay.");
  return out;
}

function paramsFor(rawUrl: string, body: string, headers: Record<string, string>): string[] {
  const params = new Set<string>();
  try {
    for (const key of new URL(rawUrl).searchParams.keys()) params.add(key);
  } catch {
    // Ignore malformed URLs.
  }
  const contentType = headers["content-type"] || headers["Content-Type"] || "";
  if (body && (/application\/x-www-form-urlencoded/i.test(contentType) || body.includes("="))) {
    try {
      for (const key of new URLSearchParams(body).keys()) params.add(key);
    } catch {
      // Ignore malformed form bodies.
    }
  }
  if (body && /application\/json/i.test(contentType)) {
    try {
      const parsed = JSON.parse(body);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const key of Object.keys(parsed)) params.add(key);
      }
    } catch {
      // Ignore malformed JSON.
    }
  }
  return [...params];
}
