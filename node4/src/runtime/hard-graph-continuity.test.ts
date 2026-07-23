/**
 * Hard Graph stage continuity (A1 booking/proof + A4 session).
 * Run: npx tsx src/runtime/hard-graph-continuity.test.ts
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolRuntime } from "../types.js";
import { proofGroundedInRecentWork } from "../tools/common.js";
import {
  resolveBookingMaterialFromSubagentEvidence,
} from "./subagent-booking.js";
import { normalizeSubagentResult } from "./subagent-result.js";
import {
  absorbStageResultIntoParent,
  seedStageLifecycleFromParent,
  seedStageSession,
  promoteStageSession,
} from "./hard-graph-continuity.js";

function bareRuntime(): ToolRuntime {
  return {
    lifecycle: {
      recentObservations: [],
      subagentEvidenceCache: [],
    },
  } as unknown as ToolRuntime;
}

const PROOF =
  "You have an error in your SQL syntax; check the manual that corresponds to your MariaDB server version near ''' at line 1";

const structured = normalizeSubagentResult({
  ok: true,
  summary: "probed login sqli",
  candidates: [
    {
      title: "SQL Injection",
      location: "http://127.0.0.1:3000/rest/user/login",
      claim: "error-based auth bypass class",
      proof_excerpt: PROOF,
      poc_hint: "POST email with quote → MariaDB syntax error in response body",
    },
  ],
  surfaces: [],
  facts: [],
  deadends: [],
});

// --- A1: absorb probe stage → seed book stage → book material grounds ---

const parent = bareRuntime();
const probeChild = bareRuntime();
const seedProbe = seedStageLifecycleFromParent(parent, probeChild);
assert.equal(seedProbe.observationCount, 0);

// Simulate act on probe child (would come from tools); absorb uses structured primarily.
absorbStageResultIntoParent(parent, {
  stageId: "class_probe",
  stageIndex: 2,
  structured,
  child: probeChild,
  seed: seedProbe,
});

assert.ok(
  (parent.lifecycle.subagentEvidenceCache || []).some((p) =>
    String(p.subagentId || "").includes("class_probe"),
  ),
  "parent cache remembers hard-stage candidates",
);
assert.ok(
  (parent.lifecycle.recentObservations || []).length >= 1,
  "parent has groundable observations after absorb",
);

const bookChild = bareRuntime();
const seedBook = seedStageLifecycleFromParent(parent, bookChild);
assert.ok(seedBook.observationCount >= 1, "book stage seeds prior observations");
assert.ok(
  (bookChild.lifecycle.subagentEvidenceCache || []).length >= 1,
  "book stage seeds candidate cache",
);

const mat = resolveBookingMaterialFromSubagentEvidence(bookChild, {
  title: "SQL Injection",
  location: "http://127.0.0.1:3000/rest/user/login",
  proof: "there was some database error",
  poc: "short",
});
assert.ok(mat, "book stage resolves verbatim material by location");
assert.equal(mat!.proof, PROOF);

const grounded = proofGroundedInRecentWork(mat!.proof, bookChild.lifecycle.recentObservations);
assert.equal(grounded.ok, true, `proof should ground on book stage: ${grounded.reason}`);

const byIdx = resolveBookingMaterialFromSubagentEvidence(bookChild, {
  title: "x",
  location: "http://127.0.0.1:3000/rest/user/login",
  candidate_index: 0,
});
assert.equal(byIdx?.proof, PROOF);

// Hallucination still fails (no matching observation)
const hall = proofGroundedInRecentWork(
  "totally fabricated uid=0(root) never observed in any stage",
  bookChild.lifecycle.recentObservations,
);
assert.equal(hall.ok, false, "fabricated proof must fail on book stage");

// Empty continuity: fresh book stage without absorb cannot resolve material
const emptyParent = bareRuntime();
const emptyBook = bareRuntime();
seedStageLifecycleFromParent(emptyParent, emptyBook);
const noMat = resolveBookingMaterialFromSubagentEvidence(emptyBook, {
  title: "SQL Injection",
  location: "http://127.0.0.1:3000/rest/user/login",
});
assert.equal(noMat, null, "empty continuity yields no booking material");
const noGround = proofGroundedInRecentWork(PROOF, emptyBook.lifecycle.recentObservations);
assert.equal(noGround.ok, false, "empty continuity cannot ground proof");

// Child act observations (post-seed) promote to parent without duplicating seed
const parent2 = bareRuntime();
const child2 = bareRuntime();
const seed2 = seedStageLifecycleFromParent(parent2, child2);
// inject a prior observation on parent then re-seed would be multi-stage; here:
// first absorb something, then next stage adds new obs
absorbStageResultIntoParent(parent2, {
  stageId: "surface",
  stageIndex: 1,
  structured: normalizeSubagentResult({
    ok: true,
    summary: "found login",
    surfaces: [{ location: "http://t/login", kind: "form" }],
    candidates: [],
  }),
  child: child2,
  seed: seed2,
});
const midCount = (parent2.lifecycle.recentObservations || []).length;
const stage2 = bareRuntime();
const seedS2 = seedStageLifecycleFromParent(parent2, stage2);
// new act on stage2 only
stage2.lifecycle.recentObservations = [
  ...(stage2.lifecycle.recentObservations || []),
  {
    sourceTool: "shell",
    summary: "curl login",
    excerpt: PROOF,
    path_or_url: "http://t/login",
    at: Date.now(),
    capture: { via: "shell", command: "curl -s http://t/login" },
  },
];
absorbStageResultIntoParent(parent2, {
  stageId: "class_probe",
  stageIndex: 2,
  structured,
  child: stage2,
  seed: seedS2,
});
const after = parent2.lifecycle.recentObservations || [];
assert.ok(after.length > midCount, "new child acts merge into parent");
// seed copies + new acts + inject from structured — must not explode unboundedly in one absorb of empty candidates only
assert.ok(after.length <= 80, "observation list stays capped");

// --- A4: session seed / promote across stage workDirs ---

const root = await mkdtemp(join(tmpdir(), "hg-cont-"));
const parentTaskDir = join(root, "task");
const stageA = join(root, "stage-a");
const stageB = join(root, "stage-b");
await mkdir(parentTaskDir, { recursive: true });
await mkdir(stageA, { recursive: true });
await mkdir(stageB, { recursive: true });

// Stage A creates default jar under session/cookies.json (product session layout)
const actorJar = join(stageA, "session", "cookies.json");
await mkdir(join(stageA, "session"), { recursive: true });
await writeFile(actorJar, JSON.stringify({ token: "auth-from-stage-a" }), "utf8");

const prom = await promoteStageSession(stageA, parentTaskDir);
assert.equal(prom.promoted, true, `promote: ${prom.detail}`);

const seedB = await seedStageSession(parentTaskDir, stageB);
assert.equal(seedB.seeded, true, `seed B: ${seedB.detail}`);

const seededJar = join(stageB, "session", "cookies.json");
const jarRaw = JSON.parse(await readFile(seededJar, "utf8")) as { token?: string };
assert.equal(jarRaw.token, "auth-from-stage-a", "stage B sees promoted cookies");

// No session on parent → seed is best-effort no-op
const emptyRoot = await mkdtemp(join(tmpdir(), "hg-cont-empty-"));
const emptyParentDir = join(emptyRoot, "task");
const emptyStage = join(emptyRoot, "stage");
await mkdir(emptyParentDir, { recursive: true });
await mkdir(emptyStage, { recursive: true });
const seedEmpty = await seedStageSession(emptyParentDir, emptyStage);
assert.equal(seedEmpty.seeded, false);

console.log("hard-graph-continuity.test.ts: ok");
