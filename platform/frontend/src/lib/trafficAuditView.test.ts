/**
 * Spec #309 S3/S4 — Traffic panel view model + detail projection.
 */
import assert from "node:assert/strict";
import {
  TRAFFIC_EMPTY_COPY,
  TRAFFIC_HONESTY_LINE,
  bodyDisplayText,
  filterTrafficDefaultView,
  isN3DefaultVisible,
  projectTrafficDetail,
  projectTrafficListRows,
  upsertTrafficExchange,
  type TrafficExchange,
} from "./trafficAuditView.ts";

function ex(partial: Partial<TrafficExchange> & { exchange_id: string }): TrafficExchange {
  return {
    method: "GET",
    url: "https://example.com/api",
    phase: "completed",
    source: "http",
    status_code: 200,
    started_at: "2026-08-07T12:00:00.000Z",
    ...partial,
  };
}

function testHonestyCopyPresent() {
  assert.ok(TRAFFIC_HONESTY_LINE.includes("Tool-channel"));
  assert.ok(TRAFFIC_HONESTY_LINE.includes("MITM"));
  assert.ok(TRAFFIC_EMPTY_COPY.includes("http"));
  assert.ok(TRAFFIC_EMPTY_COPY.toLowerCase().includes("shell") || TRAFFIC_EMPTY_COPY.includes("curl"));
}

function testN3HidesStaticKeepsStoreConcept() {
  const rows: TrafficExchange[] = [
    ex({ exchange_id: "1", source: "http", url: "https://a/api" }),
    ex({
      exchange_id: "2",
      source: "browser",
      browser_resource_class: "document",
      url: "https://a/",
    }),
    ex({
      exchange_id: "3",
      source: "browser",
      browser_resource_class: "xhr",
      url: "https://a/x",
    }),
    ex({
      exchange_id: "4",
      source: "browser",
      browser_resource_class: "stylesheet",
      url: "https://a/app.css",
    }),
    ex({
      exchange_id: "5",
      source: "browser",
      browser_resource_class: "script",
      url: "https://a/app.js",
    }),
    ex({
      exchange_id: "6",
      source: "browser",
      browser_resource_class: "image",
      url: "https://a/logo.png",
    }),
    ex({
      exchange_id: "7",
      source: "browser",
      is_websocket: true,
      browser_resource_class: "websocket",
      url: "wss://a/ws",
    }),
  ];
  // Store still has all 7
  assert.equal(rows.length, 7);
  const view = filterTrafficDefaultView(rows);
  const ids = view.map((r) => r.exchange_id);
  assert.deepEqual(ids.sort(), ["1", "2", "3", "7"].sort());
  assert.equal(isN3DefaultVisible(rows[3]), false);
  assert.equal(isN3DefaultVisible(rows[0]), true);
}

function testL1ListFields() {
  const rows = projectTrafficListRows([
    ex({
      exchange_id: "tx1",
      method: "post",
      url: "https://host.example/path?q=1",
      status_code: 201,
      source: "http",
      phase: "completed",
      sequence: 2,
      started_at: "2026-08-07T15:30:00.000Z",
    }),
    ex({
      exchange_id: "tx0",
      method: "GET",
      url: "https://host.example/",
      phase: "pending",
      source: "http",
      sequence: 1,
      status_code: null,
    }),
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].exchange_id, "tx0");
  assert.equal(rows[0].status, "pending");
  assert.equal(rows[0].pending, true);
  assert.equal(rows[1].method, "POST");
  assert.equal(rows[1].status, "201");
  assert.ok(rows[1].hostPath.includes("host.example/path"));
  assert.equal(rows[1].source, "http");
  assert.ok(rows[1].time);
}

function testUpsertSameId() {
  let list: TrafficExchange[] = [];
  list = upsertTrafficExchange(list, ex({ exchange_id: "same", phase: "pending", status_code: null }));
  list = upsertTrafficExchange(
    list,
    ex({ exchange_id: "same", phase: "completed", status_code: 204 }),
  );
  assert.equal(list.length, 1);
  assert.equal(list[0].phase, "completed");
  assert.equal(list[0].status_code, 204);
}

/** Phase-ranked merge: stale pending must not clobber completed (platform merge_exchange law). */
function testUpsertStalePendingDoesNotClobberTerminal() {
  let list: TrafficExchange[] = [];
  list = upsertTrafficExchange(
    list,
    ex({
      exchange_id: "e1",
      phase: "completed",
      status_code: 200,
      response_body: '{"ok":true}',
      request_headers: { accept: "json" },
    }),
  );
  list = upsertTrafficExchange(
    list,
    ex({
      exchange_id: "e1",
      phase: "pending",
      status_code: null,
      response_body: null,
      method: "GET",
    }),
  );
  assert.equal(list.length, 1);
  assert.equal(list[0].phase, "completed");
  assert.equal(list[0].status_code, 200);
  assert.equal(list[0].response_body, '{"ok":true}');
}

function testUpsertFailedTerminal() {
  let list: TrafficExchange[] = [];
  list = upsertTrafficExchange(list, ex({ exchange_id: "f1", phase: "pending", status_code: null }));
  list = upsertTrafficExchange(
    list,
    ex({ exchange_id: "f1", phase: "failed", status_code: null, error: "timeout" }),
  );
  assert.equal(list[0].phase, "failed");
  assert.equal(list[0].error, "timeout");
  // pending again must not wipe failed
  list = upsertTrafficExchange(
    list,
    ex({ exchange_id: "f1", phase: "pending", status_code: null, error: null }),
  );
  assert.equal(list[0].phase, "failed");
  assert.equal(list[0].error, "timeout");
}

function testDetailPendingAndTruncation() {
  const pending = projectTrafficDetail(
    ex({ exchange_id: "p1", phase: "pending", status_code: null, response_body: null }),
  );
  assert.ok(pending);
  assert.equal(pending!.waiting_response, true);
  assert.equal(
    bodyDisplayText({ body: null, waiting: pending!.waiting_response }),
    "(waiting for response…)",
  );

  const done = projectTrafficDetail(
    ex({
      exchange_id: "d1",
      phase: "completed",
      status_code: 200,
      response_body: "partial",
      response_body_truncated: true,
      response_body_bytes: 99999,
      response_body_hash: "dead",
    }),
  );
  assert.ok(done);
  assert.equal(done!.waiting_response, false);
  const body = bodyDisplayText({
    body: done!.response_body,
    truncated: done!.response_truncated,
    bytes: done!.response_bytes,
    hash: done!.response_hash,
  });
  assert.ok(body.includes("partial"));
  assert.ok(body.includes("truncated"));
  assert.ok(body.includes("99999"));
}

function testEmptyMeansNoExchanges() {
  const rows = projectTrafficListRows([]);
  assert.equal(rows.length, 0);
  assert.ok(TRAFFIC_EMPTY_COPY.length > 20);
}

testHonestyCopyPresent();
testN3HidesStaticKeepsStoreConcept();
testL1ListFields();
testUpsertSameId();
testUpsertStalePendingDoesNotClobberTerminal();
testUpsertFailedTerminal();
testDetailPendingAndTruncation();
testEmptyMeansNoExchanges();
console.log("trafficAuditView.test.ts: ok");
