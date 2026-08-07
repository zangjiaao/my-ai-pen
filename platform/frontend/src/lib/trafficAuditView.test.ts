/**
 * Spec #309 S3/S4 — Traffic panel view model + detail projection.
 */
import assert from "node:assert/strict";
import {
  TRAFFIC_EMPTY_COPY,
  bodyDisplayText,
  domainPathFromUrl,
  filterTrafficDefaultView,
  filterTrafficListRows,
  formatTrafficDuration,
  isN3DefaultVisible,
  projectTrafficDetail,
  projectTrafficListRows,
  trafficSourceDisplay,
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

function testEmptyCopy() {
  assert.ok(TRAFFIC_EMPTY_COPY.length > 5);
}

function testShellSourceVisibleInN3() {
  assert.equal(
    isN3DefaultVisible(ex({ exchange_id: "s1", source: "shell", url: "http://h/api" })),
    true,
  );
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
  assert.equal(rows.length, 7);
  const view = filterTrafficDefaultView(rows);
  const ids = view.map((r) => r.exchange_id);
  assert.deepEqual(ids.sort(), ["1", "2", "3", "7"].sort());
  assert.equal(isN3DefaultVisible(rows[3]), false);
  assert.equal(isN3DefaultVisible(rows[0]), true);
}

function testDomainPathAndSourceDisplay() {
  assert.deepEqual(domainPathFromUrl("https://host.example:8443/path?q=1"), {
    domain: "host.example:8443",
    path: "/path?q=1",
  });
  assert.equal(trafficSourceDisplay("shell"), "curl");
  assert.equal(trafficSourceDisplay("http"), "http");
  assert.equal(trafficSourceDisplay("browser"), "browser");
  assert.equal(formatTrafficDuration(42, false), "42ms");
  assert.equal(formatTrafficDuration(1500, false), "1.5s");
  assert.equal(formatTrafficDuration(null, true), "…");
  assert.equal(formatTrafficDuration(null, false), "—");
}

function testL1ListFieldsNewestFirst() {
  const rows = projectTrafficListRows([
    ex({
      exchange_id: "tx1",
      method: "post",
      url: "https://host.example/path?q=1",
      status_code: 201,
      source: "http",
      phase: "completed",
      sequence: 2,
      duration_ms: 120,
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
    ex({
      exchange_id: "tx-shell",
      method: "GET",
      url: "https://api.lab/v1",
      source: "shell",
      phase: "completed",
      sequence: 3,
      duration_ms: 30,
      status_code: 200,
    }),
  ]);
  assert.equal(rows.length, 3);
  // Newest (highest sequence) first
  assert.equal(rows[0].exchange_id, "tx-shell");
  assert.equal(rows[0].index, 3);
  assert.equal(rows[0].source, "curl");
  assert.equal(rows[0].domain, "api.lab");
  assert.equal(rows[0].path, "/v1");
  assert.equal(rows[0].duration, "30ms");
  assert.equal(rows[1].exchange_id, "tx1");
  assert.equal(rows[1].method, "POST");
  assert.equal(rows[1].status, "201");
  assert.equal(rows[1].domain, "host.example");
  assert.equal(rows[1].path, "/path?q=1");
  assert.equal(rows[1].duration, "120ms");
  assert.equal(rows[2].exchange_id, "tx0");
  assert.equal(rows[2].status, "pending");
  assert.equal(rows[2].pending, true);
  assert.equal(rows[2].duration, "…");
}

function testFilterSearchAndSource() {
  const rows = projectTrafficListRows([
    ex({
      exchange_id: "a",
      sequence: 1,
      url: "https://a.example/api",
      source: "http",
      method: "GET",
    }),
    ex({
      exchange_id: "b",
      sequence: 2,
      url: "https://b.example/login",
      source: "browser",
      method: "POST",
      browser_resource_class: "xhr",
    }),
    ex({
      exchange_id: "c",
      sequence: 3,
      url: "https://c.example/",
      source: "shell",
      method: "GET",
    }),
  ]);
  assert.equal(filterTrafficListRows(rows, { source: "curl" }).length, 1);
  assert.equal(filterTrafficListRows(rows, { source: "curl" })[0].exchange_id, "c");
  assert.equal(filterTrafficListRows(rows, { source: "http" }).length, 1);
  assert.equal(filterTrafficListRows(rows, { query: "login" }).length, 1);
  assert.equal(filterTrafficListRows(rows, { query: "POST" }).length, 1);
  assert.equal(filterTrafficListRows(rows, { query: "nope" }).length, 0);
  assert.equal(filterTrafficListRows(rows, { source: "all" }).length, 3);
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
  assert.ok(TRAFFIC_EMPTY_COPY.length > 5);
}

testEmptyCopy();
testShellSourceVisibleInN3();
testN3HidesStaticKeepsStoreConcept();
testDomainPathAndSourceDisplay();
testL1ListFieldsNewestFirst();
testFilterSearchAndSource();
testUpsertSameId();
testUpsertStalePendingDoesNotClobberTerminal();
testUpsertFailedTerminal();
testDetailPendingAndTruncation();
testEmptyMeansNoExchanges();
console.log("trafficAuditView.test.ts: ok");
