/**
 * Unit tests: surface ledger + Graph todo gate.
 * Run: npx tsx src/stores/surface-ledger.test.ts
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertTodoDoneAllowed,
  SurfaceLedgerStore,
} from "./surface-ledger.js";

const dir = await mkdtemp(join(tmpdir(), "node4-surface-"));
const ledgerPath = join(dir, "ledger.json");
const store = new SurfaceLedgerStore(ledgerPath);

await store.upsertFromRecon([
  { location: "http://127.0.0.1:8080/vulnerabilities/sqli/", kind: "form", params: ["id"] },
  { location: "http://127.0.0.1:8080/vulnerabilities/xss_r/", kind: "form" },
  { location: "http://127.0.0.1:8080/vulnerabilities/sqli/?id=1" }, // dedupe path
]);
let sum = store.summary();
assert.equal(sum.total, 2, "dedupe by pathKey");
assert.equal(sum.open, 2);
assert.equal(sum.actionable, 2);

await store.markInProbe(["http://127.0.0.1:8080/vulnerabilities/sqli/"]);
sum = store.summary();
assert.equal(sum.in_probe, 1);
assert.equal(sum.open, 1);

await store.markProbed(["http://127.0.0.1:8080/vulnerabilities/sqli/?id=2"]);
sum = store.summary();
assert.equal(sum.probed, 1);
assert.ok(store.hasActedMatch("/vulnerabilities/sqli"));

await store.markBooked("http://127.0.0.1:8080/vulnerabilities/sqli/");
sum = store.summary();
assert.equal(sum.booked, 1);

// Gate: open xss still blocks bare done
const blocked = assertTodoDoneAllowed({
  task: "XSS Reflected & Stored",
  note: undefined,
  summary: store.summary(),
  hasActedMatch: (t) => store.hasActedMatch(t),
  findByLocationHint: (t) => store.findByLocationHint(t),
});
assert.equal(blocked.ok, false);

// Gate: path acted match allows
const okPath = assertTodoDoneAllowed({
  task: "SQLi at /vulnerabilities/sqli",
  summary: store.summary(),
  hasActedMatch: (t) => store.hasActedMatch(t),
  findByLocationHint: (t) => store.findByLocationHint(t),
});
assert.equal(okPath.ok, true);

// Gate: deadend note
const dead = assertTodoDoneAllowed({
  task: "XSS Reflected & Stored",
  note: "deadend: /vulnerabilities/xss_r no reflection",
  summary: store.summary(),
  hasActedMatch: (t) => store.hasActedMatch(t),
  findByLocationHint: (t) => store.findByLocationHint(t),
});
assert.equal(dead.ok, true);
if (!dead.ok) throw new Error("expected deadend allow");
assert.equal(dead.ledgerOp?.op, "deadend");

await store.markDeadend("/vulnerabilities/xss_r/", "no reflection");
sum = store.summary();
assert.equal(sum.actionable, 0);

const clear = assertTodoDoneAllowed({
  task: "anything",
  summary: store.summary(),
  hasActedMatch: (t) => store.hasActedMatch(t),
  findByLocationHint: (t) => store.findByLocationHint(t),
});
assert.equal(clear.ok, true);

await rm(dir, { recursive: true, force: true });
console.log("surface-ledger.test.ts: ok");
