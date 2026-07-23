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
  promoteChildSessionToParent,
  seedChildSessionFromParent,
} from "./subagent-session-seed.js";
import {
  absorbStageResultIntoParent,
  dropStageKeyContinuity,
  observationSummaryBelongsToStageKey,
  seedStageLifecycleFromParent,
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
const PROOF_V2 =
  "You have an error in your SQL syntax; check the manual that corresponds to your MariaDB server version near ''admin'' at line 1 — RETRY PROOF";

function cand(proof: string) {
  return normalizeSubagentResult({
    ok: true,
    summary: "probed login sqli",
    candidates: [
      {
        title: "SQL Injection",
        location: "http://127.0.0.1:3000/rest/user/login",
        claim: "error-based auth bypass class",
        proof_excerpt: proof,
        poc_hint: "POST email with quote → MariaDB syntax error in response body",
      },
    ],
    surfaces: [],
    facts: [],
    deadends: [],
  });
}

const structured = cand(PROOF);

// --- A1: absorb probe stage → seed book stage → book material grounds ---

const parent = bareRuntime();
const probeChild = bareRuntime();
const seedProbe = seedStageLifecycleFromParent(parent, probeChild);
assert.equal(seedProbe.fingerprints.size, 0);

absorbStageResultIntoParent(parent, {
  stageId: "class_probe",
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
assert.ok(seedBook.fingerprints.size >= 1, "book stage seeds prior observations");
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

// Hallucination still fails
const hall = proofGroundedInRecentWork(
  "totally fabricated uid=0(root) never observed in any stage",
  bookChild.lifecycle.recentObservations,
);
assert.equal(hall.ok, false, "fabricated proof must fail on book stage");

// Empty continuity
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

// --- Retry upsert: second absorb with candidates wins; empty retry does not wipe ---

const retryParent = bareRuntime();
const r1 = bareRuntime();
const s1 = seedStageLifecycleFromParent(retryParent, r1);
absorbStageResultIntoParent(retryParent, {
  stageId: "class_probe",
  structured: cand(PROOF),
  child: r1,
  seed: s1,
});
const packsAfter1 = (retryParent.lifecycle.subagentEvidenceCache || []).filter(
  (p) => p.subagentId === "hard-stage:class_probe",
);
assert.equal(packsAfter1.length, 1);
assert.equal(packsAfter1[0]!.candidates[0]!.proof_excerpt, PROOF);

const r2 = bareRuntime();
const s2 = seedStageLifecycleFromParent(retryParent, r2);
absorbStageResultIntoParent(retryParent, {
  stageId: "class_probe",
  structured: cand(PROOF_V2),
  child: r2,
  seed: s2,
});
const packsAfter2 = (retryParent.lifecycle.subagentEvidenceCache || []).filter(
  (p) => p.subagentId === "hard-stage:class_probe",
);
assert.equal(packsAfter2.length, 1, "upsert keeps one pack per stageKey");
assert.equal(packsAfter2[0]!.candidates[0]!.proof_excerpt, PROOF_V2, "second attempt wins");

const bookRetry = bareRuntime();
seedStageLifecycleFromParent(retryParent, bookRetry);
const matRetry = resolveBookingMaterialFromSubagentEvidence(bookRetry, {
  title: "SQL Injection",
  location: "http://127.0.0.1:3000/rest/user/login",
});
assert.equal(matRetry?.proof, PROOF_V2, "booking resolves latest attempt proof");
assert.equal(
  proofGroundedInRecentWork(PROOF_V2, bookRetry.lifecycle.recentObservations).ok,
  true,
  "latest proof grounds",
);
// Superseded pack is gone; verbatim resolve must not return first-attempt proof.
const onlyV2 = (bookRetry.lifecycle.subagentEvidenceCache || []).filter(
  (p) => p.subagentId === "hard-stage:class_probe",
);
assert.equal(onlyV2.length, 1);
assert.equal(onlyV2[0]!.candidates[0]!.proof_excerpt, PROOF_V2);

// Empty-candidate retry must not wipe prior pack
const r3 = bareRuntime();
const s3 = seedStageLifecycleFromParent(retryParent, r3);
absorbStageResultIntoParent(retryParent, {
  stageId: "class_probe",
  structured: normalizeSubagentResult({
    ok: false,
    summary: "retry failed",
    candidates: [],
    surfaces: [],
  }),
  child: r3,
  seed: s3,
});
const packsAfterEmpty = (retryParent.lifecycle.subagentEvidenceCache || []).filter(
  (p) => p.subagentId === "hard-stage:class_probe",
);
assert.equal(packsAfterEmpty.length, 1, "empty absorb does not drop prior pack");
assert.equal(packsAfterEmpty[0]!.candidates[0]!.proof_excerpt, PROOF_V2);

// --- Child observation merge: array replace (not just append) ---

const parent2 = bareRuntime();
const child2 = bareRuntime();
const seed2 = seedStageLifecycleFromParent(parent2, child2);
// Seed parent with one observation via absorb of another stage first
absorbStageResultIntoParent(parent2, {
  stageId: "surface",
  // no candidates → no inject; put a fake parent obs manually then re-seed
  structured: normalizeSubagentResult({
    ok: true,
    summary: "found login",
    surfaces: [{ location: "http://t/login", kind: "form" }],
    candidates: [
      {
        title: "surface note",
        location: "http://t/login",
        claim: "live form",
        proof_excerpt: "HTTP 200 login form action=/rest/user/login method=POST",
        poc_hint: "GET /login → 200 form",
      },
    ],
  }),
  child: child2,
  seed: seed2,
});
const midCount = (parent2.lifecycle.recentObservations || []).length;
assert.ok(midCount >= 1);

const stage2 = bareRuntime();
const seedS2 = seedStageLifecycleFromParent(parent2, stage2);
// Full array replace: only new act (no seed prefix) — fingerprint merge must still pick it up
stage2.lifecycle.recentObservations = [
  {
    sourceTool: "shell",
    summary: "curl login",
    excerpt: PROOF,
    path_or_url: "http://t/login",
    at: Date.now() + 1,
    capture: { via: "shell", command: "curl -s http://t/login" },
  },
];
absorbStageResultIntoParent(parent2, {
  stageId: "class_probe",
  structured,
  child: stage2,
  seed: seedS2,
});
const after = parent2.lifecycle.recentObservations || [];
assert.ok(
  after.some((o) => o.excerpt === PROOF && o.sourceTool === "shell"),
  "replaced-array child act still merges into parent",
);
assert.ok(after.length > midCount || after.some((o) => o.sourceTool === "shell"));
assert.ok(after.length <= 80, "observation list stays capped");

// --- Token-safe stageKey drop (prefix collision: class vs class_probe) ---

assert.equal(
  observationSummaryBelongsToStageKey(
    "subagent hard-stage:class [class]: found form",
    "hard-stage:class",
  ),
  true,
);
assert.equal(
  observationSummaryBelongsToStageKey(
    "subagent hard-stage:class_probe [class_probe]: probed",
    "hard-stage:class",
  ),
  false,
  "shorter key must not match longer stage id",
);
assert.equal(
  observationSummaryBelongsToStageKey(
    "subagent hard-stage:class_probe candidate: SQLi",
    "hard-stage:class_probe",
  ),
  true,
);

const prefixParent = bareRuntime();
const shortChild = bareRuntime();
const shortSeed = seedStageLifecycleFromParent(prefixParent, shortChild);
absorbStageResultIntoParent(prefixParent, {
  stageId: "class",
  structured: normalizeSubagentResult({
    ok: true,
    summary: "short stage",
    candidates: [
      {
        title: "Short",
        location: "http://t/short",
        claim: "c",
        proof_excerpt: "SHORT proof excerpt with enough characters for inject filter gate",
        poc_hint: "GET /short → short body",
      },
    ],
  }),
  child: shortChild,
  seed: shortSeed,
});
const longChild = bareRuntime();
const longSeed = seedStageLifecycleFromParent(prefixParent, longChild);
absorbStageResultIntoParent(prefixParent, {
  stageId: "class_probe",
  structured: normalizeSubagentResult({
    ok: true,
    summary: "long stage",
    candidates: [
      {
        title: "Long",
        location: "http://t/long",
        claim: "c",
        proof_excerpt: "LONG proof excerpt with enough characters for inject filter gate xx",
        poc_hint: "GET /long → long body",
      },
    ],
  }),
  child: longChild,
  seed: longSeed,
});

// Drop only the short stageKey — class_probe pack + injects must remain
dropStageKeyContinuity(prefixParent, "hard-stage:class");
const packsLeft = prefixParent.lifecycle.subagentEvidenceCache || [];
assert.ok(
  packsLeft.some((p) => p.subagentId === "hard-stage:class_probe"),
  "class_probe pack survives drop of class",
);
assert.ok(
  !packsLeft.some((p) => p.subagentId === "hard-stage:class"),
  "class pack removed",
);
const obsLeft = prefixParent.lifecycle.recentObservations || [];
assert.ok(
  obsLeft.some((o) => observationSummaryBelongsToStageKey(o.summary, "hard-stage:class_probe")),
  "class_probe inject observations survive",
);
assert.ok(
  !obsLeft.some((o) => observationSummaryBelongsToStageKey(o.summary, "hard-stage:class")),
  "class inject observations removed",
);

// --- A4: session seed / promote (canonical session-seed helpers) ---

const root = await mkdtemp(join(tmpdir(), "hg-cont-"));
const parentTaskDir = join(root, "task");
const stageA = join(root, "stage-a");
const stageB = join(root, "stage-b");
await mkdir(parentTaskDir, { recursive: true });
await mkdir(stageA, { recursive: true });
await mkdir(stageB, { recursive: true });

const actorJar = join(stageA, "session", "cookies.json");
await mkdir(join(stageA, "session"), { recursive: true });
await writeFile(actorJar, JSON.stringify({ token: "auth-from-stage-a" }), "utf8");

const prom = await promoteChildSessionToParent(stageA, parentTaskDir);
assert.equal(prom.promoted, true, `promote: ${prom.detail}`);

const seedB = await seedChildSessionFromParent(parentTaskDir, stageB);
assert.equal(seedB.seeded, true, `seed B: ${seedB.detail}`);

const seededJar = join(stageB, "session", "cookies.json");
const jarRaw = JSON.parse(await readFile(seededJar, "utf8")) as { token?: string };
assert.equal(jarRaw.token, "auth-from-stage-a", "stage B sees promoted cookies");

const emptyRoot = await mkdtemp(join(tmpdir(), "hg-cont-empty-"));
const emptyParentDir = join(emptyRoot, "task");
const emptyStage = join(emptyRoot, "stage");
await mkdir(emptyParentDir, { recursive: true });
await mkdir(emptyStage, { recursive: true });
const seedEmpty = await seedChildSessionFromParent(emptyParentDir, emptyStage);
assert.equal(seedEmpty.seeded, false);

console.log("hard-graph-continuity.test.ts: ok");
