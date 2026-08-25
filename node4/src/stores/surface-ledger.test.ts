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

const blocked = await assertTodoDoneAllowed({
  task: "XSS Reflected & Stored",
  note: undefined,
  summary: store.summary(),
});
assert.equal(blocked.ok, false);

const dead = await assertTodoDoneAllowed({
  task: "XSS Reflected & Stored",
  note: "deadend: /vulnerabilities/xss_r no reflection",
  summary: store.summary(),
});
assert.equal(dead.ok, false);
if (dead.ok) throw new Error("expected deadend note to be rejected");
assert.match(dead.error, /surface\(op=skip/);

await store.markDeadend("/vulnerabilities/xss_r/", "no reflection");
sum = store.summary();
assert.equal(sum.actionable, 0);

const clear = await assertTodoDoneAllowed({
  task: "anything",
  summary: store.summary(),
});
assert.equal(clear.ok, true);

await rm(dir, { recursive: true, force: true });
console.log("surface-ledger.test.ts: ok");
