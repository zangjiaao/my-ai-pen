import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ToolRuntime } from "../types.js";
import { observeAttackSurface } from "../runtime/coverage-auditor.js";
import { mergeSessionHeaders, rememberResponseCookies } from "../runtime/session-headers.js";
import { emitToolEvidence, isInScope, jsonResult, resolveTargetUrl } from "./common.js";

const MAX_BODY_CHARS = 256 * 1024;

export function createHttpTool(runtime: ToolRuntime): ToolDefinition<any> {
  return {
    name: "http",
    label: "HTTP",
    description:
      "Send one scoped HTTP/HTTPS request without following redirects. Use for authenticated replay, injection checks, IDOR checks, and precise vulnerability verification. Optional actor= pins multi-identity session headers from the actor store.",
    promptSnippet: "Send one scoped HTTP/HTTPS request (optional actor identity)",
    promptGuidelines: [
      "Use http for exact request/response verification after collecting real endpoints from traffic.",
      "Pass actor=<id> to replay as a stored identity; omit to use the active actor / snapshot session.",
      "Compare the same endpoint as two actors before concluding access control is correct.",
      "Do not treat an HTTP 200 or scanner success as a vulnerability; verify the response body proves the issue.",
    ],
    parameters: Type.Object({
      method: Type.Optional(Type.String()),
      url: Type.String(),
      headers: Type.Optional(Type.Record(Type.String(), Type.String())),
      body: Type.Optional(Type.String()),
      actor: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId: string, params: any) {
      const method = (params.method || "GET").toUpperCase();
      const url = resolveTargetUrl(runtime, params.url);
      if (!isInScope(runtime, url)) throw new Error(`out of scope: ${url}`);
      const actorId = params.actor !== undefined ? String(params.actor) : undefined;
      const headers = mergeSessionHeaders(runtime, params.headers || {}, actorId);
      const result = await sendHttp({ method, url, headers, body: params.body, proxyUrl: runtime.trafficProxyUrl });
      rememberResponseCookies(runtime, result.headers, actorId);
      const trafficId = runtime.traffic.add({
        method,
        url,
        status: result.status,
        requestHeaders: headers,
        requestBody: params.body,
        responseHeaders: result.headers,
        responseBody: result.body,
        source: actorId ? `http.actor.${actorId}` : "http",
      });
      const evidenceId = await emitToolEvidence(runtime, "http", `${method} ${url} -> ${result.status}${actorId ? ` actor=${actorId}` : ""}`, {
        trafficId,
        actor: actorId,
        ...result,
      });
      await observeAttackSurface(runtime, {
        method,
        url,
        requestBody: params.body,
        responseBody: result.body,
        evidenceIds: [evidenceId],
        source: "http",
      });
      return jsonResult({ traffic_id: trafficId, evidence_id: evidenceId, actor: actorId, ...result }, { evidenceId, trafficId });
    },
  };
}

export function sendHttp(input: {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  proxyUrl?: string;
}): Promise<{ status: number; statusText: string; headers: Record<string, string>; body: string }> {
  const url = new URL(input.url);
  const proxy = input.proxyUrl ? new URL(input.proxyUrl) : undefined;
  if (proxy && url.protocol === "https:" && proxy.protocol === "http:") {
    return sendHttpsViaHttpProxy(input, url, proxy);
  }
  return new Promise((resolve, reject) => {
    const requestUrl = proxy || url;
    const transport = requestUrl.protocol === "https:" ? httpsRequest : httpRequest;
    const headers: Record<string, string> = { "user-agent": "my-ai-pen-node2/0.1", ...input.headers };
    if (proxy) {
      headers.host = url.host;
    }
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      fn();
    };
    // Hard deadline covers hung sockets and slow/never-ending bodies (socket inactivity alone is not enough).
    const hardTimer = setTimeout(() => {
      req.destroy(new Error("request timed out"));
      finish(() => reject(new Error("request timed out")));
    }, 60_000);
    const req = transport(
      requestUrl,
      {
        method: input.method,
        path: proxy ? url.toString() : `${url.pathname}${url.search}`,
        headers,
        rejectUnauthorized: false,
        timeout: 60_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let total = 0;
        const complete = () => {
          const responseHeaders: Record<string, string> = {};
          for (const [key, value] of Object.entries(res.headers)) {
            responseHeaders[key] = Array.isArray(value) ? value.join(", ") : String(value || "");
          }
          finish(() =>
            resolve({
              status: res.statusCode || 0,
              statusText: res.statusMessage || "",
              headers: responseHeaders,
              body: Buffer.concat(chunks).toString("utf8"),
            }),
          );
        };
        res.on("data", (chunk: Buffer) => {
          if (total >= MAX_BODY_CHARS) return;
          const remaining = MAX_BODY_CHARS - total;
          chunks.push(chunk.subarray(0, remaining));
          total += Math.min(chunk.length, remaining);
          // Cap body and finish early so large/streaming responses cannot stall the agent.
          if (total >= MAX_BODY_CHARS) {
            res.removeAllListeners("data");
            res.destroy();
            complete();
          }
        });
        res.on("end", complete);
        res.on("error", (error: Error) => finish(() => reject(error)));
      },
    );
    req.on("timeout", () => req.destroy(new Error("request timed out")));
    req.on("error", (error: Error) => finish(() => reject(error)));
    if (input.body) req.write(input.body);
    req.end();
  });
}

function sendHttpsViaHttpProxy(
  input: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: string;
    proxyUrl?: string;
  },
  url: URL,
  proxy: URL,
): Promise<{ status: number; statusText: string; headers: Record<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    const proxyPort = Number(proxy.port || 80);
    const targetPort = Number(url.port || 443);
    const proxySocket = netConnect(proxyPort, proxy.hostname);
    const fail = (error: Error) => {
      proxySocket.destroy();
      reject(error);
    };
    let buffered = Buffer.alloc(0);
    let connected = false;
    const timer = setTimeout(() => fail(new Error("request timed out")), 60_000);

    proxySocket.once("error", fail);
    proxySocket.once("connect", () => {
      const auth = proxy.username || proxy.password
        ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}\r\n`
        : "";
      proxySocket.write(
        `CONNECT ${url.hostname}:${targetPort} HTTP/1.1\r\n` +
          `Host: ${url.hostname}:${targetPort}\r\n` +
          auth +
          "Connection: close\r\n\r\n",
      );
    });

    proxySocket.on("data", (chunk: Buffer) => {
      if (connected) return;
      buffered = Buffer.concat([buffered, chunk]);
      const headerEnd = buffered.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const head = buffered.subarray(0, headerEnd).toString("latin1");
      const rest = buffered.subarray(headerEnd + 4);
      const statusLine = head.split("\r\n")[0] || "";
      const match = /^HTTP\/\d(?:\.\d)?\s+(\d+)/i.exec(statusLine);
      if (!match || Number(match[1]) < 200 || Number(match[1]) >= 300) {
        fail(new Error(`proxy CONNECT failed: ${statusLine || head.slice(0, 120)}`));
        return;
      }
      connected = true;
      proxySocket.removeAllListeners("data");
      proxySocket.removeAllListeners("error");
      const tlsSocket = tlsConnect({
        socket: proxySocket,
        servername: isIP(url.hostname) ? undefined : url.hostname,
        rejectUnauthorized: false,
      });
      tlsSocket.once("secureConnect", () => {
        const headers = requestHeaders(input, url);
        const requestHead = [
          `${input.method} ${url.pathname}${url.search} HTTP/1.1`,
          ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`),
          "",
          "",
        ].join("\r\n");
        tlsSocket.write(requestHead);
        if (input.body) tlsSocket.write(input.body);
        tlsSocket.end();
        if (rest.length) tlsSocket.unshift(rest);
      });
      readRawHttpResponse(tlsSocket, timer).then(resolve, reject);
    });
  });
}

function requestHeaders(input: { headers: Record<string, string>; body?: string }, url: URL): Record<string, string> {
  const headers: Record<string, string> = {
    "user-agent": "my-ai-pen-node2/0.1",
    host: url.host,
    connection: "close",
    ...input.headers,
  };
  if (input.body && !hasHeader(headers, "content-length")) {
    headers["content-length"] = String(Buffer.byteLength(input.body));
  }
  return headers;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const wanted = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === wanted);
}

function readRawHttpResponse(
  socket: NodeJS.ReadableStream & { once(event: "error", listener: (error: Error) => void): unknown },
  timer: NodeJS.Timeout,
): Promise<{ status: number; statusText: string; headers: Record<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    socket.once("error", (error: Error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on("data", (chunk: Buffer) => {
      if (total >= MAX_BODY_CHARS + 64 * 1024) return;
      chunks.push(chunk);
      total += chunk.length;
    });
    socket.on("end", () => {
      clearTimeout(timer);
      try {
        resolve(parseRawHttpResponse(Buffer.concat(chunks)));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function parseRawHttpResponse(raw: Buffer): { status: number; statusText: string; headers: Record<string, string>; body: string } {
  const headerEnd = raw.indexOf("\r\n\r\n");
  if (headerEnd < 0) throw new Error("invalid HTTPS proxy response: missing headers");
  const head = raw.subarray(0, headerEnd).toString("latin1");
  const bodyRaw = raw.subarray(headerEnd + 4);
  const lines = head.split("\r\n");
  const statusLine = lines.shift() || "";
  const match = /^HTTP\/\d(?:\.\d)?\s+(\d+)\s*(.*)$/i.exec(statusLine);
  if (!match) throw new Error(`invalid HTTPS proxy response status: ${statusLine}`);
  const headers: Record<string, string> = {};
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    headers[key] = headers[key] ? `${headers[key]}, ${value}` : value;
  }
  const decoded = headers["transfer-encoding"]?.toLowerCase().includes("chunked")
    ? decodeChunked(bodyRaw)
    : bodyRaw.subarray(0, contentLength(headers) ?? bodyRaw.length);
  return {
    status: Number(match[1]),
    statusText: match[2] || "",
    headers,
    body: decoded.subarray(0, MAX_BODY_CHARS).toString("utf8"),
  };
}

function contentLength(headers: Record<string, string>): number | undefined {
  const parsed = Number(headers["content-length"]);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function decodeChunked(raw: Buffer): Buffer {
  const chunks: Buffer[] = [];
  let offset = 0;
  while (offset < raw.length) {
    const lineEnd = raw.indexOf("\r\n", offset);
    if (lineEnd < 0) break;
    const sizeText = raw.subarray(offset, lineEnd).toString("latin1").split(";", 1)[0] || "0";
    const size = Number.parseInt(sizeText.trim(), 16);
    if (!Number.isFinite(size) || size < 0) break;
    offset = lineEnd + 2;
    if (size === 0) break;
    chunks.push(raw.subarray(offset, Math.min(offset + size, raw.length)));
    offset += size + 2;
  }
  return Buffer.concat(chunks);
}
