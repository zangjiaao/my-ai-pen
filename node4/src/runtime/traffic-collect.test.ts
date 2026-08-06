/**
 * Spec #309 S1 — Runtime collect contracts (http two-phase + browser shape + truncation).
 */
import assert from "node:assert/strict";
import {
  buildPendingHttpExchange,
  browserExchangeRichness,
  browserNetworkRowToExchange,
  captureBody,
  completeExchange,
  DEFAULT_BODY_BUDGET,
  drainBrowserNetworkRows,
  emitHttpComplete,
  emitHttpPending,
  failExchange,
  mapBrowserResourceClass,
  newExchangeId,
  parseBrowserNetworkList,
  shouldEmitBrowserRow,
  type BrowserSeenMap,
  type TrafficExchange,
} from "./traffic-collect.js";

function testNewExchangeId() {
  const a = newExchangeId("http");
  const b = newExchangeId("http");
  assert.ok(a.startsWith("tx_http_"), a);
  assert.notEqual(a, b);
}

function testPendingThenCompleteSameId() {
  const pending = buildPendingHttpExchange({
    conversationId: "conv-1",
    taskId: "task-1",
    sequence: 1,
    method: "POST",
    url: "https://example.com/api",
    requestHeaders: { "content-type": "application/json" },
    requestBody: '{"q":1}',
  });
  assert.equal(pending.phase, "pending");
  assert.equal(pending.source, "http");
  assert.equal(pending.method, "POST");
  assert.equal(pending.url, "https://example.com/api");
  assert.equal(pending.status_code, null);
  assert.equal(pending.response_body, null);
  assert.equal(pending.request_body, '{"q":1}');
  assert.ok(pending.exchange_id);

  const done = completeExchange(pending, {
    statusCode: 200,
    responseHeaders: { "content-type": "application/json" },
    responseBody: '{"ok":true}',
    contentType: "application/json",
  });
  assert.equal(done.exchange_id, pending.exchange_id, "R2: same exchange_id");
  assert.equal(done.phase, "completed");
  assert.equal(done.status_code, 200);
  assert.equal(done.response_body, '{"ok":true}');
  assert.equal(done.content_type, "application/json");
  assert.ok(done.completed_at);
  assert.ok(typeof done.duration_ms === "number");
}

function testFailKeepsSameId() {
  const pending = buildPendingHttpExchange({
    conversationId: "conv-1",
    method: "GET",
    url: "https://example.com/slow",
  });
  const failed = failExchange(pending, "aborted");
  assert.equal(failed.exchange_id, pending.exchange_id);
  assert.equal(failed.phase, "failed");
  assert.equal(failed.error, "aborted");
  assert.equal(failed.status_code, null);
  assert.ok(failed.completed_at);
}

function testBodyTruncationMetadata() {
  const big = "x".repeat(DEFAULT_BODY_BUDGET + 1000);
  const cap = captureBody(big, { budget: DEFAULT_BODY_BUDGET });
  assert.equal(cap.truncated, true);
  assert.ok(cap.text && cap.text.length < big.length);
  assert.equal(cap.bytes, Buffer.byteLength(big, "utf8"));
  assert.ok(cap.hash);

  const pending = buildPendingHttpExchange({
    conversationId: "c",
    method: "POST",
    url: "https://ex.com/",
    requestBody: big,
    bodyBudget: DEFAULT_BODY_BUDGET,
  });
  assert.equal(pending.request_body_truncated, true);
  assert.ok((pending.request_body || "").length < big.length);
  assert.equal(pending.request_body_bytes, Buffer.byteLength(big, "utf8"));

  const done = completeExchange(pending, {
    statusCode: 201,
    responseBody: big,
    bodyBudget: DEFAULT_BODY_BUDGET,
  });
  assert.equal(done.response_body_truncated, true);
  assert.ok(done.response_body_hash);
}

function testBinaryNotForcedUtf8() {
  const cap = captureBody("\u0000binary", { contentType: "application/octet-stream" });
  assert.equal(cap.binary, true);
  assert.equal(cap.text, null);
  assert.equal(cap.truncated, true);
  assert.ok(cap.hash);
}

function testBrowserShape() {
  const row = {
    id: "1.2",
    method: "GET",
    url: "https://app.example/api/items",
    status: 200,
    resourceType: "xhr",
    responseBody: "[]",
    responseHeaders: { "content-type": "application/json" },
  };
  const ex = browserNetworkRowToExchange({
    conversationId: "conv-b",
    taskId: "t1",
    sequence: 3,
    row,
  });
  assert.ok(ex);
  assert.equal(ex!.source, "browser");
  assert.equal(ex!.phase, "completed");
  assert.equal(ex!.method, "GET");
  assert.equal(ex!.url, "https://app.example/api/items");
  assert.equal(ex!.status_code, 200);
  assert.equal(ex!.browser_resource_class, "xhr");
  assert.ok(ex!.exchange_id.includes("browser"));
  assert.equal(ex!.conversation_id, "conv-b");
}

function testBrowserStaticClass() {
  assert.equal(mapBrowserResourceClass("stylesheet"), "stylesheet");
  assert.equal(mapBrowserResourceClass("script"), "script");
  assert.equal(mapBrowserResourceClass("image"), "image");
  assert.equal(mapBrowserResourceClass("document"), "document");
  assert.equal(mapBrowserResourceClass("fetch"), "fetch");
  assert.equal(mapBrowserResourceClass("websocket"), "websocket");
}

function testParseBrowserNetworkList() {
  const rows = parseBrowserNetworkList(
    JSON.stringify({
      success: true,
      data: [
        { id: "a", url: "https://x/1", method: "GET", resourceType: "document", status: 200 },
        { id: "b", url: "https://x/app.js", method: "GET", resourceType: "script", status: 200 },
      ],
    }),
  );
  assert.equal(rows.length, 2);
  assert.equal(String(rows[0].id), "a");
}

async function testDrainIdempotent() {
  const sent: TrafficExchange[] = [];
  const platform = {
    send: async (msg: Record<string, unknown>) => {
      sent.push(msg as TrafficExchange);
    },
  };
  const task = {
    taskId: "t",
    conversationId: "c",
    instruction: "",
    target: {},
    scope: {},
  };
  const seen: BrowserSeenMap = new Map();
  const rows = [
    { id: "r1", url: "https://x/", method: "GET", resourceType: "document", status: 200 },
    { id: "r1", url: "https://x/", method: "GET", resourceType: "document", status: 200 },
  ];
  const first = await drainBrowserNetworkRows({ platform, task, rows, seenIds: seen });
  const second = await drainBrowserNetworkRows({ platform, task, rows, seenIds: seen });
  assert.equal(first.length, 1);
  assert.equal(second.length, 0);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].source, "browser");
  assert.equal(sent[0].type, "traffic_exchange");
}

/**
 * R2 / BUG fix: same browser request id must upgrade pending → completed,
 * not be permanently dropped after first sight.
 */
async function testDrainSameIdPhaseUpgrade() {
  const sent: TrafficExchange[] = [];
  const platform = {
    send: async (msg: Record<string, unknown>) => {
      sent.push(msg as TrafficExchange);
    },
  };
  const task = {
    taskId: "t",
    conversationId: "c",
    instruction: "",
    target: {},
    scope: {},
  };
  const seen: BrowserSeenMap = new Map();
  const pendingRow = {
    id: "req-42",
    url: "https://app.example/api",
    method: "GET",
    resourceType: "xhr",
    // no status → browserNetworkRowToExchange phase pending
  };
  const completeRow = {
    id: "req-42",
    url: "https://app.example/api",
    method: "GET",
    resourceType: "xhr",
    status: 200,
    responseBody: '{"ok":true}',
    responseHeaders: { "content-type": "application/json" },
  };
  const first = await drainBrowserNetworkRows({
    platform,
    task,
    rows: [pendingRow],
    seenIds: seen,
  });
  const second = await drainBrowserNetworkRows({
    platform,
    task,
    rows: [completeRow],
    seenIds: seen,
  });
  assert.equal(first.length, 1);
  assert.equal(first[0].phase, "pending");
  assert.equal(second.length, 1, "same-id completion must re-emit");
  assert.equal(second[0].phase, "completed");
  assert.equal(second[0].status_code, 200);
  assert.equal(first[0].exchange_id, second[0].exchange_id);
  assert.equal(sent.length, 2);

  // Identical complete again: idempotent skip
  const third = await drainBrowserNetworkRows({
    platform,
    task,
    rows: [completeRow],
    seenIds: seen,
  });
  assert.equal(third.length, 0);
  assert.equal(sent.length, 2);
}

async function testDrainRicherFieldsUpgrade() {
  const sent: TrafficExchange[] = [];
  const platform = {
    send: async (msg: Record<string, unknown>) => {
      sent.push(msg as TrafficExchange);
    },
  };
  const task = {
    taskId: "t",
    conversationId: "c",
    instruction: "",
    target: {},
    scope: {},
  };
  const seen: BrowserSeenMap = new Map();
  const thin = {
    id: "r9",
    url: "https://x/d",
    method: "GET",
    resourceType: "document",
    status: 200,
  };
  const rich = {
    ...thin,
    responseBody: "<html/>",
    responseHeaders: { "content-type": "text/html" },
  };
  await drainBrowserNetworkRows({ platform, task, rows: [thin], seenIds: seen });
  const upgraded = await drainBrowserNetworkRows({ platform, task, rows: [rich], seenIds: seen });
  assert.equal(upgraded.length, 1, "richer same-id row should re-emit");
  assert.ok(browserExchangeRichness(upgraded[0]) > browserExchangeRichness(sent[0]));
}

function testShouldEmitBrowserRowHelpers() {
  const seen: BrowserSeenMap = new Map();
  const pending = browserNetworkRowToExchange({
    conversationId: "c",
    row: { id: "1", url: "https://x/", method: "GET", resourceType: "xhr" },
  })!;
  assert.equal(shouldEmitBrowserRow(seen, "1", pending), true);
  seen.set("1", { phase: "pending", richness: browserExchangeRichness(pending) });
  const done = browserNetworkRowToExchange({
    conversationId: "c",
    row: { id: "1", url: "https://x/", method: "GET", resourceType: "xhr", status: 204 },
  })!;
  assert.equal(shouldEmitBrowserRow(seen, "1", done), true);
  seen.set("1", { phase: "completed", richness: browserExchangeRichness(done) });
  assert.equal(shouldEmitBrowserRow(seen, "1", pending), false, "stale pending must not clobber");
}

/** Terminal still lands when platform rejects the pending frame. */
async function testHttpCompleteWhenPendingEmitFails() {
  let call = 0;
  const sent: TrafficExchange[] = [];
  const platform = {
    send: async (msg: Record<string, unknown>) => {
      call += 1;
      if (call === 1) throw new Error("ws down");
      sent.push(msg as TrafficExchange);
    },
  };
  const runtime = {
    platform,
    task: {
      taskId: "t",
      conversationId: "c",
      instruction: "",
      target: {},
      scope: {},
    },
    lifecycle: {},
  } as any;
  const pending = await emitHttpPending(runtime, {
    method: "GET",
    url: "https://example.com/",
  });
  assert.ok(pending.exchange_id);
  assert.equal(pending.phase, "pending");
  assert.equal(sent.length, 0, "pending emit failed");
  const done = await emitHttpComplete(runtime, pending, {
    statusCode: 200,
    responseBody: "ok",
  });
  assert.equal(done.exchange_id, pending.exchange_id);
  assert.equal(done.phase, "completed");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].phase, "completed");
}

function testBrowserPendingPhaseFromInflightRow() {
  const ex = browserNetworkRowToExchange({
    conversationId: "c",
    row: {
      id: "in-flight",
      url: "https://app/x",
      method: "POST",
      resourceType: "fetch",
      // no status / response → pending (R2 when CLI exposes in-flight)
    },
  });
  assert.ok(ex);
  assert.equal(ex!.phase, "pending");
  assert.equal(ex!.source, "browser");
}

function testNoShellSource() {
  const pending = buildPendingHttpExchange({
    conversationId: "c",
    method: "GET",
    url: "https://x/",
  });
  assert.notEqual(pending.source, "shell" as any);
  assert.ok(pending.source === "http" || pending.source === "browser");
}

testNewExchangeId();
testPendingThenCompleteSameId();
testFailKeepsSameId();
testBodyTruncationMetadata();
testBinaryNotForcedUtf8();
testBrowserShape();
testBrowserStaticClass();
testParseBrowserNetworkList();
await testDrainIdempotent();
await testDrainSameIdPhaseUpgrade();
await testDrainRicherFieldsUpgrade();
testShouldEmitBrowserRowHelpers();
await testHttpCompleteWhenPendingEmitFails();
testBrowserPendingPhaseFromInflightRow();
testNoShellSource();
console.log("traffic-collect.test.ts: ok");
