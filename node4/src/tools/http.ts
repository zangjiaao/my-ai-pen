import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolRuntime } from "../types.js";
import {
  emitHttpComplete,
  emitHttpFail,
  emitHttpPending,
  headersToRecord,
} from "../runtime/traffic-collect.js";
import { recordActObservation, isInScope, jsonResult, resolveTargetUrl, textResult } from "./common.js";

export function createHttpTool(runtime: ToolRuntime): AgentTool<any> {
  return {
    name: "http",
    label: "HTTP",
    description:
      "Single in-scope HTTP request only. For multi-step recon/exploit (cookies, chains, parse, loops), use shell instead — do not issue many http calls for a chain.",
    parameters: Type.Object({
      method: Type.Optional(Type.String()),
      url: Type.String(),
      headers: Type.Optional(Type.Record(Type.String(), Type.String())),
      body: Type.Optional(Type.String()),
      timeout_seconds: Type.Optional(Type.Number()),
    }),
    async execute(_id: string, params: any) {
      const url = resolveTargetUrl(runtime, String(params.url || ""));
      if (!isInScope(runtime, url)) return textResult(`error: out of scope: ${url}`);
      const method = String(params.method || "GET").toUpperCase();
      const timeoutMs = Math.min(Math.max(Number(params.timeout_seconds || 30) * 1000, 1000), 120_000);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const requestBody = params.body != null ? String(params.body) : undefined;
      const requestHeaders =
        params.headers && typeof params.headers === "object"
          ? (params.headers as Record<string, string>)
          : undefined;

      // Spec #309: pending exchange before the network call (two-phase liveness).
      let pending = await emitHttpPending(runtime, {
        method,
        url,
        requestHeaders: requestHeaders || null,
        requestBody: requestBody ?? null,
      }).catch(() => null);

      try {
        const res = await fetch(url, {
          method,
          headers: params.headers || undefined,
          body: requestBody,
          signal: controller.signal,
          redirect: "manual",
        });
        const text = await res.text();
        const bodyPreview = text.slice(0, 8000);
        const responseHeaders = headersToRecord(res.headers);
        const contentType = res.headers.get("content-type");

        if (pending) {
          await emitHttpComplete(runtime, pending, {
            statusCode: res.status,
            responseHeaders,
            responseBody: text,
            contentType,
          }).catch(() => {});
        }

        recordActObservation(runtime, "http", `${method} ${url} → ${res.status}`, {
          method,
          url,
          status: res.status,
          headers: Object.fromEntries(res.headers.entries()),
          request_headers: params.headers || undefined,
          request_body: requestBody,
          body_preview: bodyPreview,
        });
        return jsonResult({
          ok: true,
          status: res.status,
          url,
          headers: Object.fromEntries(res.headers.entries()),
          body: bodyPreview,
          truncated: text.length > bodyPreview.length,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (pending) {
          await emitHttpFail(runtime, pending, message).catch(() => {});
        }
        return textResult(`error: ${message}`);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
