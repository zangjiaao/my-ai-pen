/**
 * Spec #371: Graph coverage gates against SQLite working store (external behavior).
 * Run: npx tsx src/stores/surface-sqlite.gate.test.ts
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertTodoDoneAllowed } from "./surface-ledger.js";
import { SurfaceSqliteStore } from "./surface-sqlite.js";

const dir = await mkdtemp(join(tmpdir(), "node4-surface-sqlite-gate-"));
const store = new SurfaceSqliteStore(SurfaceSqliteStore.pathFromTaskDir(dir));
await store.open();

await store.upsertFromRecon([
  { location: "http://127.0.0.1:8080/vulnerabilities/sqli/", kind: "form", params: ["id"] },
  { location: "http://127.0.0.1:8080/vulnerabilities/xss_r/", kind: "form" },
  { location: "http://127.0.0.1:8080/vulnerabilities/sqli/?id=1" }, // same identity as first
]);
let sum = await store.summary();
assert.equal(sum.total, 2, "dedupe by origin+path identity");
assert.equal(sum.open, 2);
assert.equal(sum.actionable, 2);
assert.ok(sum.open_preview.length >= 1);

await store.markInProbe(["http://127.0.0.1:8080/vulnerabilities/sqli/"]);
sum = await store.summary();
// v2: in_probe/probed → touched; summary maps touched → in_probe field (open ≈ seen)
assert.equal(sum.in_probe, 1);
assert.equal(sum.open, 1);

await store.markProbed(["http://127.0.0.1:8080/vulnerabilities/sqli/?id=2"]);
sum = await store.summary();
// Same rank as markInProbe under v2 (both → touched); no separate probed bucket.
assert.equal(sum.in_probe, 1);
assert.equal(sum.probed, 0);
assert.ok(await store.hasActedMatch("/vulnerabilities/sqli"));

await store.markBooked("http://127.0.0.1:8080/vulnerabilities/sqli/");
sum = await store.summary();
assert.equal(sum.booked, 1);

// Gate: remaining untested xss still blocks bare done
const blocked = await assertTodoDoneAllowed({
  task: "XSS Reflected & Stored",
  note: undefined,
  summary: await store.summary(),
});
assert.equal(blocked.ok, false);

// Spec #518: mentioning an already-booked path does not green todo while others remain open
const stillOpen = await assertTodoDoneAllowed({
  task: "SQLi at /vulnerabilities/sqli",
  summary: await store.summary(),
});
assert.equal(stillOpen.ok, false);

// Spec #518: note=deadend is retired — explicit error, does not write coverage
const dead = await assertTodoDoneAllowed({
  task: "XSS Reflected & Stored",
  note: "deadend: /vulnerabilities/xss_r no reflection",
  summary: await store.summary(),
});
assert.equal(dead.ok, false);
if (dead.ok) throw new Error("expected deadend note to be rejected");
assert.match(dead.error, /surface\(op=skip/);

const skipped = await store.setCoverage({
  location: "http://127.0.0.1:8080/vulnerabilities/xss_r/",
  coverage: "skipped",
  skip_reason: "deadend",
  marked_by: "test",
});
assert.ok(skipped.ok);
sum = await store.summary();
assert.equal(sum.actionable, 0);
const xss = await store.get({ location: "http://127.0.0.1:8080/vulnerabilities/xss_r/" });
assert.equal(xss?.status, "seen", "skip does not change status");
assert.equal(xss?.coverage, "skipped");

const clear = await assertTodoDoneAllowed({
  task: "anything",
  summary: await store.summary(),
});
assert.equal(clear.ok, true);

// listOpen only actionable
const open = await store.listOpen();
assert.equal(open.length, 0);

// Spec #376 D7: markBooked with no match system-creates source=finding
const nCreated = await store.markBooked("http://127.0.0.1:8080/new-from-finding");
assert.equal(nCreated, 1);
const created = await store.get({ location: "http://127.0.0.1:8080/new-from-finding" });
assert.ok(created);
assert.equal(created?.status, "booked");
assert.equal(created?.source, "finding");

// Spec #382 D7: create-on-book from method-path + host/port/location_key (no scheme)
const nPut = await store.markBooked("PUT /api/Products/{id} (IDOR)", {
  host: "127.0.0.1",
  port: 8080,
  locationKey: "/api/products/{id}",
});
assert.equal(nPut, 1);
const putRow = await store.get({ location: "http://127.0.0.1:8080/api/products/{id}" });
assert.ok(putRow);
assert.equal(putRow?.status, "booked");
assert.equal(putRow?.source, "finding");
assert.equal(putRow?.path_key, "/api/products/{id}");

// Unresolvable scheme-less location soft-skips create
const nSkip = await store.markBooked("PUT /api/Never/1");
assert.equal(nSkip, 0);

store.close();
await rm(dir, { recursive: true, force: true });
console.log("surface-sqlite.gate.test.ts: ok");
