/**
 * Smoke: tool presentation produces user-valuable lines (not raw JSON).
 */
import { presentToolResult, presentToolStart } from "./runtime/tool-presentation.js";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const httpStart = presentToolStart("http", { method: "GET", url: "http://127.0.0.1:3000/api/Users" });
assert(httpStart.line.includes("GET"), `http start: ${httpStart.line}`);
assert(httpStart.line.includes("http://127.0.0.1:3000/api/Users"), httpStart.line);
assert(!httpStart.line.includes("{"), "http start should not be JSON");

const httpDone = presentToolResult(
  "http",
  { method: "GET", url: "http://127.0.0.1:3000/api/Users" },
  JSON.stringify({ method: "GET", url: "http://127.0.0.1:3000/api/Users", status: 200, body: "{...}" }, null, 2),
  false,
);
assert(httpDone.line === "GET - http://127.0.0.1:3000/api/Users - 200" || /GET -.+- 200/.test(httpDone.line), httpDone.line);
assert(httpDone.result?.status === 200, "structured result status");

// Realistic Node2 http tool payload: method/url only in args; body may truncate JSON.
const httpRealistic = presentToolResult(
  "http",
  { method: "POST", url: "http://127.0.0.1:3000/rest/user/login" },
  JSON.stringify({
    traffic_id: "t1",
    evidence_id: "e1",
    status: 200,
    statusText: "OK",
    headers: { "content-type": "application/json" },
    body: '{"authentication":{"token":"x"}}',
  }, null, 2),
  false,
);
assert(httpRealistic.line === "POST - http://127.0.0.1:3000/rest/user/login - 200", httpRealistic.line);
assert(!httpRealistic.line.includes("traffic_id"), httpRealistic.line);

const truncated = presentToolResult(
  "http",
  { method: "GET", url: "http://127.0.0.1:3000/api/Products" },
  '{"traffic_id":"t2","evidence_id":"e2","status":401,"statusText":"Unauthorized","headers":{},"body":"' + "x".repeat(5000),
  false,
);
assert(/GET -.+Products - 401/.test(truncated.line), truncated.line);

const browserDone = presentToolResult(
  "browser",
  { action: "goto", url: "http://host.docker.internal:3000/" },
  JSON.stringify({ runner: "strix-sandbox", action: "goto", url: "http://host.docker.internal:3000/#/", title: "Juice" }),
  false,
);
assert(browserDone.line.includes("http://host.docker.internal:3000"), browserDone.line);
assert(browserDone.line.startsWith("GET -"), `browser should look like GET - url: ${browserDone.line}`);
assert(!browserDone.line.includes('"runner"'), browserDone.line);

const scanDone = presentToolResult(
  "scan",
  { scanner: "httpx", url: "http://127.0.0.1:3000" },
  JSON.stringify({
    scanner: "httpx",
    argv: ["-silent", "-json", "-u", "http://host.docker.internal:3000/"],
    exitCode: 0,
  }),
  false,
);
assert(scanDone.command?.includes("httpx"), String(scanDone.command));
assert(scanDone.line.toLowerCase().includes("httpx"), scanDone.line);

const verifierDone = presentToolResult(
  "verifier",
  { vuln_class: "sql-injection", url: "http://127.0.0.1:3000/search" },
  JSON.stringify({ confirmed: true, reason: "payload worked" }),
  false,
);
assert(/sql-injection/i.test(verifierDone.line) && /confirmed/i.test(verifierDone.line), verifierDone.line);

console.log(
  JSON.stringify(
    {
      ok: true,
      http: httpDone.line,
      httpRealistic: httpRealistic.line,
      truncated: truncated.line,
      browser: browserDone.line,
      scan: scanDone.line,
      verifier: verifierDone.line,
      scanCommand: scanDone.command,
    },
    null,
    2,
  ),
);
