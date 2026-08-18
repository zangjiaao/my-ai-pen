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

// promote child → parent (Graph hard path)
const { promoteChildSessionToParent } = await import("./subagent-session-seed.js");
const parent2 = join(root, "parent2");
const child3 = join(root, "child3");
await mkdir(join(child3, "session"), { recursive: true });
await writeFile(join(child3, "session", "cookies.json"), JSON.stringify({ PHPSESSID: "from-child" }), "utf8");
const prom = await promoteChildSessionToParent(child3, parent2);
assert.equal(prom.promoted, true);
const up = await import("node:fs/promises").then((fs) =>
  fs.readFile(join(parent2, "session", "cookies.json"), "utf8"),
);
assert.match(up, /from-child/);
// next seed from promoted parent
const child4 = join(root, "child4");
const seed2 = await seedChildSessionFromParent(parent2, child4);
assert.equal(seed2.seeded, true);

// Shared expert/pi tree: live jars stay on expert; promote must not clobber.
const expert = join(root, "expert");
const piChild = join(expert, "pi-child");
await mkdir(join(expert, "session"), { recursive: true });
await mkdir(piChild, { recursive: true });
await writeFile(join(expert, "session", "cookies.json"), JSON.stringify({ live: "during-package" }), "utf8");
await mkdir(join(piChild, "session"), { recursive: true });
await writeFile(join(piChild, "session", "cookies.json"), JSON.stringify({ stale: "seed-snapshot" }), "utf8");
const sharedSeed = await seedChildSessionFromParent(expert, piChild);
assert.equal(sharedSeed.seeded, true, sharedSeed.detail);
assert.match(sharedSeed.detail, /shared/);
const sharedProm = await promoteChildSessionToParent(piChild, expert);
assert.equal(sharedProm.promoted, false, sharedProm.detail);
const live = await import("node:fs/promises").then((fs) =>
  fs.readFile(join(expert, "session", "cookies.json"), "utf8"),
);
assert.match(live, /during-package/);
assert.doesNotMatch(live, /stale/);

await rm(root, { recursive: true, force: true });
console.log("subagent-salvage.test.ts: ok");
