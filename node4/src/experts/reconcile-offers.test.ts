/**
 * Platform UI offers → filesystem install reconciliation.
 * Run: npx tsx src/experts/reconcile-offers.test.ts
 */
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, cpSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expertsCatalogRoot } from "./paths.js";
import { reconcilePlatformOffers, listInstalledPackIds } from "./install.js";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

const catalog = expertsCatalogRoot();
const srcPentest = join(catalog, "pentest");
assert(existsSync(join(srcPentest, "pack.json")), "catalog pentest must exist in repo");

const installRoot = mkdtempSync(join(tmpdir(), "node4-offers-"));
process.env.NODE4_EXPERTS_INSTALL = installRoot;
process.env.NODE4_EXPERTS_CATALOG = catalog;

try {
  assert(listInstalledPackIds().length === 0, "start empty");
  const r = reconcilePlatformOffers(["pentest", "default", ""]);
  assert(r.ok, `reconcile ok: ${JSON.stringify(r.results)}`);
  assert(r.installed.includes("pentest"), "pentest installed");
  assert(existsSync(join(installRoot, "pentest", "pack.json")), "pack.json on disk");
  // idempotent
  const r2 = reconcilePlatformOffers(["pentest"]);
  assert(r2.ok && r2.installed.includes("pentest"), "second reconcile ok");
  console.log("reconcile-offers.test.ts: ok");
} finally {
  rmSync(installRoot, { recursive: true, force: true });
  delete process.env.NODE4_EXPERTS_INSTALL;
}
