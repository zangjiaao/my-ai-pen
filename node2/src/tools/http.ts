import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ToolRuntime } from "../types.js";
import { emitToolEvidence, isInScope, jsonResult, resolveTargetUrl } from "./common.js";

const MAX_BODY_CHARS = 256 * 1024;

export function createHttpTool(runtime: ToolRuntime): ToolDefinition<any> {
  return {
    name: "http",
    label: "HTTP",
    description: "Send one scoped HTTP/HTTPS request without following redirects. Use for authenticated replay, injection checks, IDOR checks, and precise vulnerability verification.",
    promptSnippet: "Send one scoped HTTP/HTTPS request",
    promptGuidelines: [
      "Use http for exact request/response verification after collecting real endpoints from traffic.",
      "Do not treat an HTTP 200 or scanner success as a vulnerability; verify the response body proves the issue.",
    ],
    parameters: Type.Object({
      method: Type.Optional(Type.String()),
      url: Type.String(),
      headers: Type.Optional(Type.Record(Type.String(), Type.String())),
      body: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId: string, params: any) {
      const method = (params.method || "GET").toUpperCase();
      const url = resolveTargetUrl(runtime, params.url);
      if (!isInScope(runtime, url)) throw new Error(`out of scope: ${url}`);
      const result = await sendHttp({ method, url, headers: params.headers || {}, body: params.body });
      const trafficId = runtime.traffic.add({
        method,
        url,
        status: result.status,
        requestHeaders: params.headers || {},
        requestBody: params.body,
        responseHeaders: result.headers,
        responseBody: result.body,
      });
      const evidenceId = await emitToolEvidence(runtime, "http", `${method} ${url} -> ${result.status}`, { trafficId, ...result });
      return jsonResult({ traffic_id: trafficId, evidence_id: evidenceId, ...result }, { evidenceId, trafficId });
    },
  };
}

function sendHttp(input: {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}): Promise<{ status: number; statusText: string; headers: Record<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(input.url);
    const transport = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = transport(
      url,
      {
        method: input.method,
        headers: { "user-agent": "my-ai-pen-node2/0.1", ...input.headers },
        rejectUnauthorized: false,
        timeout: 60_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (chunk: Buffer) => {
          if (total >= MAX_BODY_CHARS) return;
          const remaining = MAX_BODY_CHARS - total;
          chunks.push(chunk.subarray(0, remaining));
          total += Math.min(chunk.length, remaining);
        });
        res.on("end", () => {
          const headers: Record<string, string> = {};
          for (const [key, value] of Object.entries(res.headers)) {
            headers[key] = Array.isArray(value) ? value.join(", ") : String(value || "");
          }
          resolve({
            status: res.statusCode || 0,
            statusText: res.statusMessage || "",
            headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("request timed out")));
    req.on("error", reject);
    if (input.body) req.write(input.body);
    req.end();
  });
}
