/**
 * Intel tools are registered and citizen-visible.
 * Run: npx tsx src/tools/platform-intel.test.ts
 */
import assert from "node:assert/strict";
import { ALL_NODE4_TOOL_FACTORIES } from "./index.js";
import { DEFAULT_SEAT_PACK } from "../roles/default.js";
import { PLATFORM_CITIZEN_TOOL_NAMES, mergePlatformCitizenTools } from "../roles/platform-citizen.js";
import { toolNamesForPack } from "./index.js";

for (const name of [
  "platform_record_intel",
  "platform_list_intel",
  "platform_get_intel",
  "platform_forget_intel",
] as const) {
  assert.equal(typeof ALL_NODE4_TOOL_FACTORIES[name], "function", `${name} factory`);
  assert.ok(PLATFORM_CITIZEN_TOOL_NAMES.includes(name), `${name} is a citizen tool`);
}

assert.ok(toolNamesForPack(DEFAULT_SEAT_PACK).includes("platform_record_intel"));
assert.ok(mergePlatformCitizenTools(["shell"]).includes("platform_list_intel"));
console.log("platform-intel.test.ts ok");
