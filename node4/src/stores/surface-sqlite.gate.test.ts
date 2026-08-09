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
assert.equal(sum.in_probe, 1);
assert.equal(sum.open, 1);

await store.markProbed(["http://127.0.0.1:8080/vulnerabilities/sqli/?id=2"]);
sum = await store.summary();
assert.equal(sum.probed, 1);
assert.ok(await store.hasActedMatch("/vulnerabilities/sqli"));

await store.markBooked("http://127.0.0.1:8080/vulnerabilities/sqli/");
sum = await store.summary();
assert.equal(sum.booked, 1);

// Gate: open xss still blocks bare done
const blocked = await assertTodoDoneAllowed({
  task: "XSS Reflected & Stored",
  note: undefined,
  summary: await store.summary(),
  hasActedMatch: (t) => store.hasActedMatch(t),
  findByLocationHint: (t) => store.findByLocationHint(t),
});
assert.equal(blocked.ok, false);

// Gate: path acted match allows
const okPath = await assertTodoDoneAllowed({
  task: "SQLi at /vulnerabilities/sqli",
  summary: await store.summary(),
  hasActedMatch: (t) => store.hasActedMatch(t),
  findByLocationHint: (t) => store.findByLocationHint(t),
});
assert.equal(okPath.ok, true);

// Gate: deadend note
const dead = await assertTodoDoneAllowed({
  task: "XSS Reflected & Stored",
  note: "deadend: /vulnerabilities/xss_r no reflection",
  summary: await store.summary(),
  hasActedMatch: (t) => store.hasActedMatch(t),
  findByLocationHint: (t) => store.findByLocationHint(t),
});
assert.equal(dead.ok, true);
if (!dead.ok) throw new Error("expected deadend allow");
assert.equal(dead.ledgerOp?.op, "deadend");

await store.markDeadend("/vulnerabilities/xss_r/", "no reflection");
sum = await store.summary();
assert.equal(sum.actionable, 0);

const clear = await assertTodoDoneAllowed({
  task: "anything",
  summary: await store.summary(),
  hasActedMatch: (t) => store.hasActedMatch(t),
  findByLocationHint: (t) => store.findByLocationHint(t),
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

store.close();
await rm(dir, { recursive: true, force: true });
console.log("surface-sqlite.gate.test.ts: ok");
