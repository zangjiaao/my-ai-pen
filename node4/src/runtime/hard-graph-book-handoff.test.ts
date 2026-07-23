/**
 * #70 Hard book-from-handoff integrity (stage boundary).
 * Probe candidates with proof_excerpt → absorb → seed book stage → finding(confirm)
 * without act tools. Run: npx tsx src/runtime/hard-graph-book-handoff.test.ts
 */
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlatformSink, ToolRuntime } from "../types.js";
import { EvidenceStore } from "../stores/evidence.js";
import { GoalStore } from "../stores/goal.js";
import { TodoStore } from "../stores/todo.js";
import { createFindingTool } from "../tools/finding.js";
import { normalizeSubagentResult } from "./subagent-result.js";
import {
  absorbStageResultIntoParent,
  seedStageLifecycleFromParent,
} from "./hard-graph-continuity.js";

function textOf(result: { content?: Array<{ type?: string; text?: string }> }): string {
  const item = result.content?.find((c) => c.type === "text");
  return String(item?.text || "");
}

async function bookRuntime(): Promise<ToolRuntime> {
  const root = await mkdtemp(join(tmpdir(), "hard-book-handoff-"));
  const taskDir = join(root, "task");
  const platform: PlatformSink = {
    async send() {
      /* noop */
    },
  };
  return {
    task: {
      taskId: "hard-book-handoff",
      conversationId: "conv-hard-book",
      instruction: "book from handoff only",
      target: { type: "url", value: "http://127.0.0.1:3010" },
      scope: { allow: ["127.0.0.1", "localhost"] },
      engagement: "pentest",
      graphDiscipline: "hard",
    },
    workspaceDir: root,
    taskDir,
    platform,
    todo: new TodoStore(),
    evidence: new EvidenceStore(join(taskDir, "evidence")),
    findingsDir: join(taskDir, "findings"),
    goals: new GoalStore(),
    rolePackId: "pentest",
    lifecycle: {
      recentObservations: [],
      subagentEvidenceCache: [],
    },
  } as unknown as ToolRuntime;
}

const PROOFS = [
  {
    title: "SQL Injection in Login",
    location: "http://127.0.0.1:3010/rest/user/login",
    proof:
      'POST /rest/user/login body {"email":"\' OR 1=1 --","password":"x"} returns HTTP 200 with JWT token field for admin@juice-sh.op',
    poc_hint:
      "POST /rest/user/login with email=' OR 1=1 -- and any password; observed 200 + JWT authentication token in JSON body",
  },
  {
    title: "Excessive Data Exposure Memories",
    location: "http://127.0.0.1:3010/rest/memories",
    proof:
      "GET /rest/memories (no auth) returns JSON User.password hashes such as 0192023a7bbd73250516f069df18b500 for admin accounts",
    poc_hint:
      "GET http://127.0.0.1:3010/rest/memories without Authorization; observed nested User.password MD5 hashes in response body",
  },
  {
    title: "Sensitive File Exposure Encryption Keys",
    location: "http://127.0.0.1:3010/encryptionkeys/",
    proof:
      "GET /encryptionkeys/ returns directory listing HTML with jwt.pub and premium.key; GET /encryptionkeys/premium.key returns 1337133713371337.EA99A61D92D2955B1E9285B55BF2AD42",
    poc_hint:
      "GET /encryptionkeys/ shows listing; GET /encryptionkeys/jwt.pub returns BEGIN RSA PUBLIC KEY; observed premium.key material in body",
  },
] as const;

function multiCandStructured() {
  return normalizeSubagentResult({
    ok: true,
    summary: "class_probe: three bookable candidates with verbatim proof",
    candidates: PROOFS.map((p) => ({
      title: p.title,
      location: p.location,
      claim: p.title,
      proof_excerpt: p.proof,
      poc_hint: p.poc_hint,
    })),
    surfaces: [],
    facts: [],
    deadends: [],
  });
}

// --- N candidates → N booked findings via finding tool (no shell/http on book stage) ---

const parent = await bookRuntime();
const probeChild = {
  lifecycle: { recentObservations: [], subagentEvidenceCache: [] },
} as unknown as ToolRuntime;
const seedProbe = seedStageLifecycleFromParent(parent, probeChild);
absorbStageResultIntoParent(parent, {
  stageId: "class_probe",
  structured: multiCandStructured(),
  child: probeChild,
  seed: seedProbe,
});

const bookChild = await bookRuntime();
// Share findings/evidence dirs with parent product task
bookChild.findingsDir = parent.findingsDir;
bookChild.evidence = parent.evidence;
bookChild.task = parent.task;
bookChild.platform = parent.platform;
const seedBook = seedStageLifecycleFromParent(parent, bookChild);
assert.ok(
  (bookChild.lifecycle.subagentEvidenceCache || []).length >= 1,
  "book stage has absorbed candidate pack",
);
assert.ok(seedBook.fingerprints.size >= 1, "book stage has groundable observations");

const finding = createFindingTool(bookChild);

for (let i = 0; i < PROOFS.length; i += 1) {
  const p = PROOFS[i]!;
  // Agent supplies weak/short proof+poc; harness must fill from candidate match.
  const raw = await finding.execute(`book-${i}`, {
    action: "confirm",
    title: p.title,
    severity: i === 0 ? "critical" : "high",
    location: p.location,
    description: `${p.title}: demonstrated on target during class_probe handoff booking path.`,
    // Intentionally short / paraphrased — must still book via candidate material
    proof: "some database error happened",
    poc: "tried login",
    candidate_index: i,
  });
  const text = textOf(raw);
  assert.ok(!text.startsWith("error:"), `candidate ${i} should book, got: ${text.slice(0, 280)}`);
  assert.ok(text.includes(p.title) || text.includes('"ok"') || text.includes(p.location), text.slice(0, 200));
}

const files = (await readdir(parent.findingsDir)).filter((f) => f.endsWith(".json"));
assert.equal(files.length, PROOFS.length, `expected ${PROOFS.length} finding files, got ${files.length}`);

for (const f of files) {
  const rec = JSON.parse(await readFile(join(parent.findingsDir, f), "utf8")) as {
    proof?: string;
    title?: string;
  };
  assert.ok(String(rec.proof || "").length >= 24, `finding ${f} must store grounded proof`);
  // Must be verbatim candidate proof, not agent paraphrase
  assert.ok(
    PROOFS.some((p) => p.proof === rec.proof || rec.proof?.includes(p.proof.slice(0, 40))),
    `finding ${f} proof should match a candidate proof_excerpt`,
  );
}

// --- Location match without candidate_index also books ---

const parent2 = await bookRuntime();
const probe2 = { lifecycle: { recentObservations: [], subagentEvidenceCache: [] } } as unknown as ToolRuntime;
const seed2 = seedStageLifecycleFromParent(parent2, probe2);
absorbStageResultIntoParent(parent2, {
  stageId: "class_probe",
  structured: multiCandStructured(),
  child: probe2,
  seed: seed2,
});
const book2 = await bookRuntime();
book2.findingsDir = parent2.findingsDir;
book2.evidence = parent2.evidence;
book2.task = parent2.task;
book2.platform = parent2.platform;
seedStageLifecycleFromParent(parent2, book2);
const finding2 = createFindingTool(book2);
const onlyMemories = PROOFS[1]!;
const byLoc = textOf(
  await finding2.execute("by-loc", {
    action: "confirm",
    title: onlyMemories.title,
    severity: "critical",
    location: onlyMemories.location,
    description: "Mass password hash leak via public memories endpoint without authentication.",
    // omit proof/poc entirely — candidate location match must fill
  }),
);
assert.ok(!byLoc.startsWith("error:"), `location match should book: ${byLoc.slice(0, 300)}`);

// --- Paraphrased / invented proof with no matching candidate fails closed ---

const parent3 = await bookRuntime();
const book3 = await bookRuntime();
book3.findingsDir = parent3.findingsDir;
book3.evidence = parent3.evidence;
book3.task = parent3.task;
book3.platform = parent3.platform;
// Empty continuity — no candidates
seedStageLifecycleFromParent(parent3, book3);
const finding3 = createFindingTool(book3);
const hall = textOf(
  await finding3.execute("hall", {
    action: "confirm",
    title: "Invented RCE",
    severity: "critical",
    location: "http://127.0.0.1:3010/rest/user/login",
    description: "Claimed remote code execution with no supporting probe handoff evidence at all.",
    proof: "totally fabricated uid=0(root) never observed in any stage tool output whatsoever",
    poc: "POST /rest/user/login with evil payload; observed uid=0(root) in stdout which never happened",
  }),
);
assert.ok(hall.startsWith("error:"), "fabricated proof must fail closed");
assert.match(hall, /proof not found|no recent tool|no subagent candidates|not found/i);

// --- Empty-candidate absorb does not wipe prior pack (continuity) ---

const parent4 = await bookRuntime();
const c1 = { lifecycle: { recentObservations: [], subagentEvidenceCache: [] } } as unknown as ToolRuntime;
const s1 = seedStageLifecycleFromParent(parent4, c1);
absorbStageResultIntoParent(parent4, {
  stageId: "class_probe",
  structured: multiCandStructured(),
  child: c1,
  seed: s1,
});
const before = (parent4.lifecycle.subagentEvidenceCache || []).flatMap((p) => p.candidates || []).length;
assert.equal(before, PROOFS.length);
const c2 = { lifecycle: { recentObservations: [], subagentEvidenceCache: [] } } as unknown as ToolRuntime;
const s2 = seedStageLifecycleFromParent(parent4, c2);
absorbStageResultIntoParent(parent4, {
  stageId: "class_probe",
  structured: normalizeSubagentResult({
    ok: true,
    summary: "retry empty",
    candidates: [],
    surfaces: [],
  }),
  child: c2,
  seed: s2,
});
const after = (parent4.lifecycle.subagentEvidenceCache || []).flatMap((p) => p.candidates || []).length;
assert.equal(after, PROOFS.length, "empty absorb must not wipe prior candidates");

// --- Candidate with proof_excerpt but no poc_hint + weak agent poc still books ---

const parent5 = await bookRuntime();
const probe5 = {
  lifecycle: { recentObservations: [], subagentEvidenceCache: [] },
} as unknown as ToolRuntime;
const seed5 = seedStageLifecycleFromParent(parent5, probe5);
const PROOF_ONLY =
  "GET /encryptionkeys/premium.key returns 1337133713371337.EA99A61D92D2955B1E9285B55BF2AD42 key material in body";
absorbStageResultIntoParent(parent5, {
  stageId: "class_probe",
  structured: normalizeSubagentResult({
    ok: true,
    summary: "proof without poc_hint",
    candidates: [
      {
        title: "Key Exposure",
        location: "http://127.0.0.1:3010/encryptionkeys/premium.key",
        proof_excerpt: PROOF_ONLY,
        // no poc_hint
      },
    ],
  }),
  child: probe5,
  seed: seed5,
});
const book5 = await bookRuntime();
book5.findingsDir = parent5.findingsDir;
book5.evidence = parent5.evidence;
book5.task = parent5.task;
book5.platform = parent5.platform;
seedStageLifecycleFromParent(parent5, book5);
const finding5 = createFindingTool(book5);
const noPocHint = textOf(
  await finding5.execute("no-poc-hint", {
    action: "confirm",
    title: "Key Exposure",
    severity: "high",
    location: "http://127.0.0.1:3010/encryptionkeys/premium.key",
    description: "Premium key material exposed without authentication via static file path.",
    proof: "short garbage",
    poc: "got key",
  }),
);
assert.ok(
  !noPocHint.startsWith("error:"),
  `proof_excerpt-only candidate must book even without poc_hint: ${noPocHint.slice(0, 320)}`,
);

console.log("hard-graph-book-handoff.test.ts: ok");
