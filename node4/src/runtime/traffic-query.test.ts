/**
 * Spec #378 — Agent traffic raw-material query + no surface auto-fill from collect.
 */
import assert from "node:assert/strict";
import {
  aggregateTrafficByPath,
  listRuntimeTraffic,
  mergeLocalExchange,
  parseUrlParts,
  projectTrafficSummary,
  queryTrafficExchanges,
  rememberTrafficExchange,
  TRAFFIC_STORE_CAP,
  getTrafficStore,
} from "./traffic-query.js";
import {
  buildPendingHttpExchange,
  completeExchange,
  emitHttpComplete,
  emitHttpPending,
  type TrafficExchange,
} from "./traffic-collect.js";
import { createTrafficListTool } from "../tools/traffic.js";
import type { ToolRuntime } from "../types.js";

function makeEx(partial: Partial<TrafficExchange> & { exchange_id: string; url: string }): TrafficExchange {
  return {
    type: "traffic_exchange",
    conversation_id: "conv-1",
    source: "http",
    phase: "completed",
    method: "GET",
    status_code: 200,
    started_at: "2026-01-01T00:00:00.000Z",
    completed_at: "2026-01-01T00:00:01.000Z",
    duration_ms: 1000,
    sequence: 1,
    ...partial,
  };
}

function testParseUrlParts() {
  const p = parseUrlParts("https://app.example.com:8443/api/v1/users?x=1");
  assert.equal(p.host, "app.example.com:8443");
  assert.equal(p.path, "/api/v1/users");
  assert.equal(p.origin, "https://app.example.com:8443");
}

function testSummaryOmitsBodies() {
  const ex = makeEx({
    exchange_id: "tx_1",
    url: "https://example.com/login",
    method: "POST",
    request_body: "user=a&pass=b",
    response_body: "<html>ok</html>",
  });
  const row = projectTrafficSummary(ex);
  assert.equal(row.method, "POST");
  assert.equal(row.host, "example.com");
  assert.equal(row.path, "/login");
  assert.equal(row.status_code, 200);
  assert.ok(!("request_body" in row));
  assert.ok(!("response_body" in row));
}

function testLatestAndPagination() {
  const store = new Map<string, TrafficExchange>();
  for (let i = 1; i <= 5; i += 1) {
    rememberTrafficExchange(
      { trafficById: store },
      makeEx({
        exchange_id: `tx_${i}`,
        sequence: i,
        url: `https://example.com/p${i}`,
        started_at: `2026-01-01T00:00:0${i}.000Z`,
      }),
    );
  }
  const latest = queryTrafficExchanges(store, { limit: 2 });
  assert.equal(latest.total, 5);
  assert.equal(latest.exchanges.length, 2);
  assert.equal((latest.exchanges[0] as any).sequence, 5);
  assert.equal((latest.exchanges[1] as any).sequence, 4);
  assert.equal(latest.has_more, true);
  assert.equal(latest.next_offset, 2);

  const page2 = queryTrafficExchanges(store, { limit: 2, offset: 2 });
  assert.equal((page2.exchanges[0] as any).sequence, 3);
  assert.equal(page2.has_more, true);

  const delta = queryTrafficExchanges(store, { since_sequence: 3, limit: 10 });
  assert.equal(delta.total, 2);
  assert.deepEqual(
    delta.exchanges.map((e) => (e as any).sequence),
    [5, 4],
  );
  assert.equal(delta.max_sequence, 5);
}

function testPathAggregation() {
  const rows = [
    makeEx({ exchange_id: "a", sequence: 1, method: "GET", url: "https://h/x", status_code: 200 }),
    makeEx({ exchange_id: "b", sequence: 2, method: "POST", url: "https://h/x", status_code: 201 }),
    makeEx({ exchange_id: "c", sequence: 3, method: "GET", url: "https://h/y", status_code: 404 }),
  ];
  const agg = aggregateTrafficByPath(rows);
  assert.equal(agg.length, 2);
  const x = agg.find((r) => r.path === "/x");
  assert.ok(x);
  assert.equal(x!.count, 2);
  assert.ok(x!.methods.includes("GET") && x!.methods.includes("POST"));
  assert.ok(x!.status_codes.includes(200) && x!.status_codes.includes(201));
}

function testIncludeBodiesAndGetById() {
  const store = new Map<string, TrafficExchange>();
  const full = makeEx({
    exchange_id: "tx_body",
    sequence: 9,
    url: "https://example.com/api",
    request_body: '{"a":1}',
    response_body: '{"ok":true}',
  });
  rememberTrafficExchange({ trafficById: store }, full);
  const detail = queryTrafficExchanges(store, { exchange_id: "tx_body", include_bodies: true });
  assert.equal(detail.exchanges.length, 1);
  assert.equal((detail.exchanges[0] as TrafficExchange).response_body, '{"ok":true}');

  const missing = queryTrafficExchanges(store, { exchange_id: "nope" });
  assert.equal(missing.exchanges.length, 0);
}

function testMergeLocalPendingToComplete() {
  const pending = buildPendingHttpExchange({
    conversationId: "c",
    sequence: 1,
    method: "GET",
    url: "https://example.com/z",
  });
  const done = completeExchange(pending, {
    statusCode: 204,
    responseBody: "",
  });
  const merged = mergeLocalExchange(pending, done);
  assert.equal(merged.exchange_id, pending.exchange_id);
  assert.equal(merged.phase, "completed");
  assert.equal(merged.status_code, 204);
}

function testStoreCap() {
  const host: { trafficById?: Map<string, TrafficExchange> } = {};
  for (let i = 1; i <= TRAFFIC_STORE_CAP + 10; i += 1) {
    rememberTrafficExchange(
      host,
      makeEx({
        exchange_id: `cap_${i}`,
        sequence: i,
        url: `https://example.com/${i}`,
      }),
    );
  }
  const store = getTrafficStore(host);
  assert.equal(store.size, TRAFFIC_STORE_CAP);
  assert.ok(!store.has("cap_1"));
  assert.ok(store.has(`cap_${TRAFFIC_STORE_CAP + 10}`));
}

function testCollectDoesNotTouchSurfaceLedger() {
  const surfaceCalls: string[] = [];
  const surfaceLedger = new Proxy(
    {},
    {
      get(_t, prop) {
        surfaceCalls.push(String(prop));
        return async () => {
          throw new Error("surface ledger must not be called from traffic collect");
        };
      },
    },
  );
  const sent: unknown[] = [];
  const runtime = {
    task: { conversationId: "conv-no-surface", taskId: "t1" },
    platform: {
      send: async (msg: unknown) => {
        sent.push(msg);
      },
    },
    lifecycle: {},
    surfaceLedger,
  } as unknown as ToolRuntime;

  return (async () => {
    const pending = await emitHttpPending(runtime, {
      method: "GET",
      url: "https://example.com/no-surface",
    });
    await emitHttpComplete(runtime, pending, {
      statusCode: 200,
      responseBody: "ok",
    });
    assert.equal(surfaceCalls.length, 0, "traffic collect must not touch surfaceLedger");
    assert.ok(sent.length >= 1);
    const listed = listRuntimeTraffic(runtime, { limit: 5 });
    assert.equal(listed.total, 1);
    assert.equal((listed.exchanges[0] as any).path, "/no-surface");
    // Query result still does not write surface
    assert.equal(surfaceCalls.length, 0);
  })();
}

async function testToolSeam() {
  const runtime = {
    task: { conversationId: "conv-tool", taskId: "t2" },
    platform: { send: async () => {} },
    lifecycle: {},
  } as unknown as ToolRuntime;

  const pending = await emitHttpPending(runtime, {
    method: "POST",
    url: "https://api.example.com/v1/items",
    requestBody: "x=1",
  });
  await emitHttpComplete(runtime, pending, {
    statusCode: 201,
    responseBody: '{"id":1}',
  });

  const tool = createTrafficListTool(runtime);
  assert.equal(tool.name, "traffic_list");
  const res = await tool.execute("call-1", { limit: 10, aggregate_paths: true });
  const text = String((res.content as any)?.[0]?.text || "");
  const parsed = JSON.parse(text);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.total, 1);
  assert.equal(parsed.exchanges[0].method, "POST");
  assert.equal(parsed.exchanges[0].host, "api.example.com");
  assert.equal(parsed.exchanges[0].path, "/v1/items");
  assert.equal(parsed.exchanges[0].status_code, 201);
  assert.equal(parsed.exchanges[0].request_body, undefined);
  assert.ok(Array.isArray(parsed.path_summary));
  assert.ok(String(parsed.note || "").toLowerCase().includes("surface"));

  const withBody = await tool.execute("call-2", {
    exchange_id: pending.exchange_id,
    include_bodies: true,
  });
  const detail = JSON.parse(String((withBody.content as any)?.[0]?.text || ""));
  assert.equal(detail.exchanges[0].response_body, '{"id":1}');
}

async function main() {
  testParseUrlParts();
  testSummaryOmitsBodies();
  testLatestAndPagination();
  testPathAggregation();
  testIncludeBodiesAndGetById();
  testMergeLocalPendingToComplete();
  testStoreCap();
  await testCollectDoesNotTouchSurfaceLedger();
  await testToolSeam();
  console.log("traffic-query.test.ts: ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
