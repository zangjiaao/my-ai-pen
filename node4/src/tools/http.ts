import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolRuntime } from "../types.js";
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
      try {
        const res = await fetch(url, {
          method,
          headers: params.headers || undefined,
          body: params.body != null ? String(params.body) : undefined,
          signal: controller.signal,
          redirect: "manual",
        });
        const text = await res.text();
        const bodyPreview = text.slice(0, 8000);
        const requestBody = params.body != null ? String(params.body) : undefined;
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
        return textResult(`error: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
