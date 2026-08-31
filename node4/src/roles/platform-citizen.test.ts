/**
 * Spec #546 / #543 Wave 1 — catalog + Citizen mission seams.
 * Run: npx tsx src/roles/platform-citizen.test.ts
 */
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPackFromDirSync } from "../experts/load-pack.js";
import { DEFAULT_SEAT_PACK } from "./default.js";
import {
  mergePlatformCitizenMission,
  mergePlatformCitizenTools,
  PLATFORM_CITIZEN_MARKER,
} from "./platform-citizen.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const pentest = loadPackFromDirSync(join(repoRoot, "experts/pentest"));
const ctf = loadPackFromDirSync(join(repoRoot, "experts/ctf"));

const ACT_LOOP_REQUIRED = [
  "http",
  "finding",
  "fact",
  "surface",
  "workset",
  "request_user_decision",
] as const;

const ACT_LOOP_FORBIDDEN = [
  "inventory",
  "platform_list_assets",
  "platform_get_asset",
  "platform_create_asset",
  "platform_list_groups",
  "platform_list_vulnerabilities",
  "platform_get_vulnerability",
  "platform_conversation_snapshot",
  "platform_list_experts",
  "platform_list_reports",
  "traffic_list",
  "goal",
] as const;

for (const name of ACT_LOOP_REQUIRED) {
  assert.ok(pentest.toolNames.includes(name), `pentest loop includes ${name}`);
}
for (const name of ACT_LOOP_FORBIDDEN) {
  assert.ok(!pentest.toolNames.includes(name), `pentest loop omits ${name}`);
}
assert.ok(pentest.toolNames.includes("platform_create_report"), "pentest keeps create_report");
assert.ok(
  pentest.toolNames.includes("platform_set_conversation_title"),
  "Wave 1 keeps title tool until Wave 2",
);
assert.ok(pentest.toolNames.includes("hypothesis"), "hypothesis stays on pack for Graph stages");

assert.ok(DEFAULT_SEAT_PACK.toolNames.includes("inventory"), "Default clerk uses inventory");
assert.ok(!DEFAULT_SEAT_PACK.toolNames.includes("platform_list_assets"), "Default catalog dropped list_assets");
assert.ok(!DEFAULT_SEAT_PACK.toolNames.includes("platform_create_asset"), "Default creates Hosts via inventory");
assert.ok(!DEFAULT_SEAT_PACK.toolNames.includes("finding"), "Default does not book");

assert.ok(!ctf.toolNames.includes("inventory"), "ctf is not a hidden asset manager");
assert.ok(!ctf.toolNames.includes("platform_list_assets"), "ctf is not a hidden asset manager");
assert.ok(ctf.toolNames.includes("http"), "ctf keeps act tools");

const prepended = mergePlatformCitizenTools(["shell", "http"], "act_expert");
assert.ok(!prepended.includes("platform_list_assets"), "act_expert prepend has no inventory reads");
assert.ok(prepended.includes("fact") && prepended.includes("request_user_decision"));
assert.deepEqual(
  mergePlatformCitizenTools(["shell", "fact"], "act_expert").filter((n) => n === "fact"),
  ["fact"],
  "citizen prepend is idempotent",
);
assert.equal(
  mergePlatformCitizenTools(["shell"], "ledger_assist")[0],
  "inventory",
  "ledger_assist prepends inventory",
);

const actMission = mergePlatformCitizenMission(["You are pentest."], "act_expert");
assert.ok(actMission.some((l) => l.includes(PLATFORM_CITIZEN_MARKER)));
assert.ok(
  actMission.some((l) => /blackboard|### Case/i.test(l)),
  "act mission is blackboard-first",
);
assert.ok(
  !actMission.some((l) => /platform_list_assets first/i.test(l)),
  "act mission must not say list_assets first",
);
assert.ok(
  actMission.some((l) => /kickoff/i.test(l) && /list_vulnerabilit/i.test(l)),
  "act mission still forbids kickoff vuln dump",
);
assert.deepEqual(
  mergePlatformCitizenMission([`${PLATFORM_CITIZEN_MARKER} already`], "act_expert").filter((l) =>
    l.includes(PLATFORM_CITIZEN_MARKER),
  ).length,
  1,
  "citizen mission inject is idempotent",
);

const ledgerMission = mergePlatformCitizenMission(["You are default."], "ledger_assist");
assert.ok(
  ledgerMission.some((l) => /inventory\(list\) first/i.test(l)),
  "Default clerk mission still lists first",
);
assert.ok(
  !actMission.some((l) => /inventory\(list\) first/i.test(l)),
  "act mission must stay blackboard-first",
);

console.log("platform-citizen.test.ts ok");
