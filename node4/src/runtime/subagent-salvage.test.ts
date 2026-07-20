/**
 * Run: npx tsx src/runtime/subagent-salvage.test.ts
 */
import assert from "node:assert/strict";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { salvageSubagentResult } from "./subagent-salvage.js";
import { seedChildSessionFromParent } from "./subagent-session-seed.js";

const root = join(tmpdir(), `node4-salvage-${Date.now()}`);
const workDir = join(root, "child");
await mkdir(join(workDir, "tool-output"), { recursive: true });
await writeFile(
  join(workDir, "tool-output", "out1.json"),
  JSON.stringify({
    stdout: "SQL syntax error near ''' at line 1 in MySQL response body for id=",
    ok: true,
  }),
  "utf8",
);

const salvaged = await salvageSubagentResult({
  workDir,
  handoff: {
    target: "http://t/vulnerabilities/sqli/",
    scope: "t",
    already_done: "none",
    this_turn_goal: "probe sqli",
    success_criteria: "proof",
  },
  toolsUsed: 3,
});
assert.ok(salvaged.candidates.length >= 1);
assert.match(salvaged.candidates[0]!.proof_excerpt || "", /SQL syntax/);
assert.ok(salvaged.deadends.some((d) => /salvag/i.test(d)));

// session seed
const parent = join(root, "parent");
await mkdir(join(parent, "session"), { recursive: true });
await writeFile(join(parent, "session", "cookies.json"), JSON.stringify({ PHPSESSID: "abc" }), "utf8");
const child2 = join(root, "child2");
const seed = await seedChildSessionFromParent(parent, child2);
assert.equal(seed.seeded, true);
const copied = await import("node:fs/promises").then((fs) =>
  fs.readFile(join(child2, "session", "cookies.json"), "utf8"),
);
assert.match(copied, /PHPSESSID/);

await rm(root, { recursive: true, force: true });
console.log("subagent-salvage.test.ts: ok");
