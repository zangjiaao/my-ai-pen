import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect as netConnect } from "node:net";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { CoverageStore } from "./stores/coverage.js";
import { EvidenceStore } from "./stores/evidence.js";
import { PlanStore } from "./stores/plan.js";
import { TrafficStore } from "./stores/traffic.js";
import { createHttpTool } from "./tools/http.js";
import type { PlatformMessage, PlatformSink, ToolRuntime } from "./types.js";

const require = createRequire(import.meta.url);
const forge = require("node-forge") as any;

class MemorySink implements PlatformSink {
  readonly events: PlatformMessage[] = [];
  async send(message: PlatformMessage): Promise<void> {
    this.events.push(message);
  }
}

const cert = selfSignedCertificate();
const targetServer = createHttpsServer({ key: cert.key, cert: cert.cert }, async (req, res) => {
  send(res, 200, `https-target:${req.method}:${req.url || "/"}`);
});
await listen(targetServer);
const targetAddress = targetServer.address();
if (!targetAddress || typeof targetAddress === "string") throw new Error("target server did not bind");
const target = `https://127.0.0.1:${targetAddress.port}`;

const connectRequests: string[] = [];
const proxyServer = createHttpServer();
proxyServer.on("connect", (req, clientSocket, head) => {
  const authority = String(req.url || "");
  connectRequests.push(authority);
  const [host, portText] = authority.split(":");
  const upstream = netConnect(Number(portText || 443), host);
  upstream.once("connect", () => {
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
  upstream.once("error", (error) => {
    clientSocket.end(`HTTP/1.1 502 Bad Gateway\r\nContent-Length: ${Buffer.byteLength(error.message)}\r\n\r\n${error.message}`);
  });
});
await listen(proxyServer);
const proxyAddress = proxyServer.address();
if (!proxyAddress || typeof proxyAddress === "string") throw new Error("proxy server did not bind");
const proxyUrl = `http://127.0.0.1:${proxyAddress.port}`;

try {
  const workspaceDir = resolve("tmp", "node2-https-proxy-routing-smoke");
  const taskId = `https-proxy-${randomUUID()}`;
  const taskDir = resolve(workspaceDir, taskId);
  await mkdir(taskDir, { recursive: true });
  const runtime: ToolRuntime = {
    task: {
      taskId,
      conversationId: taskId,
      instruction: "https proxy routing smoke",
      target: { type: "url", value: target },
      scope: { allow: [target] },
      snapshot: {},
    },
    workspaceDir,
    platform: new MemorySink(),
    plan: new PlanStore(),
    coverage: new CoverageStore(),
    evidence: new EvidenceStore(resolve(taskDir, "evidence")),
    traffic: new TrafficStore(),
    pocCatalogPath: "",
    workflowRuns: [],
    lifecycle: {},
    trafficProxyUrl: proxyUrl,
  };
  runtime.plan.start();
  const http = createHttpTool(runtime);
  const result = await execJson(http, "proxy-https", { method: "GET", url: `${target}/through-proxy?x=1` });
  if (!String(result.body || "").includes("/through-proxy?x=1")) throw new Error(`unexpected target response: ${JSON.stringify(result)}`);
  if (!connectRequests.some((item) => item === `127.0.0.1:${targetAddress.port}`)) {
    throw new Error(`HTTPS request did not route through CONNECT proxy: ${JSON.stringify(connectRequests)}`);
  }
  console.log(JSON.stringify({ ok: true, proxyUrl, connectRequests, trafficTotal: runtime.traffic.list({ limit: 10 }).length }, null, 2));
} finally {
  await close(proxyServer);
  await close(targetServer);
}

function selfSignedCertificate(): { key: string; cert: string } {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const attrs = [{ name: "commonName", value: "127.0.0.1" }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: "basicConstraints", cA: true },
    { name: "subjectAltName", altNames: [{ type: 7, ip: "127.0.0.1" }] },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return {
    key: forge.pki.privateKeyToPem(keys.privateKey),
    cert: forge.pki.certificateToPem(cert),
  };
}

function listen(server: ReturnType<typeof createHttpServer> | ReturnType<typeof createHttpsServer>): Promise<void> {
  return new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
}

function close(server: ReturnType<typeof createHttpServer> | ReturnType<typeof createHttpsServer>): Promise<void> {
  return new Promise((resolveClose) => server.close(() => resolveClose()));
}

function send(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "content-type": "text/plain", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

async function execJson(tool: any, callId: string, params: Record<string, unknown>): Promise<any> {
  const result = await tool.execute(callId, params);
  const text = result.content.find((item: { type: string; text?: string }) => item.type === "text")?.text || "{}";
  return JSON.parse(text);
}
