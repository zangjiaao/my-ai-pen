/**
 * Intel tools are registered and citizen-visible.
 * Run: npx tsx src/tools/platform-intel.test.ts
 */
import assert from "node:assert/strict";
import { ALL_NODE4_TOOL_FACTORIES } from "./index.js";
import { DEFAULT_SEAT_PACK } from "../roles/default.js";
import { PLATFORM_CITIZEN_TOOL_NAMES, mergePlatformCitizenTools } from "../roles/platform-citizen.js";
import { toolNamesForPack } from "./index.js";
import { resolveIntelHang } from "./platform-intel.js";

assert.deepEqual(resolveIntelHang({ asset_id: "a1", port: "8080" }, []), { asset_id: "a1", port: "8080" });
assert.deepEqual(
  resolveIntelHang({}, [{ id: "only", on_ledger: true }]),
  { asset_id: "only" },
);
assert.equal(resolveIntelHang({}, [{ id: "a" }, { id: "b" }]), null);
assert.equal(resolveIntelHang({}, [{ id: "ghost", on_ledger: false }]), null);

for (const name of [
  "platform_record_intel",
  "platform_list_intel",
  "platform_get_intel",
  "platform_forget_intel",
] as const) {
  assert.equal(typeof ALL_NODE4_TOOL_FACTORIES[name], "function", `${name} factory`);
  assert.ok(!PLATFORM_CITIZEN_TOOL_NAMES.includes(name), `${name} is not a citizen tool — Agent uses fact`);
}

assert.ok(toolNamesForPack(DEFAULT_SEAT_PACK).includes("fact"), "notebook is fact");
assert.ok(!toolNamesForPack(DEFAULT_SEAT_PACK).includes("platform_record_intel"));
assert.ok(mergePlatformCitizenTools(["shell"], "ledger_assist").includes("fact"));
console.log("platform-intel.test.ts ok");
