/**
 * #75 Juice lab process gate (deterministic; real HTTP to local Juice when up).
 * Does not use live LLM. Exercises mature hard graph + processMetrics + book-from-handoff
 * with proof excerpts taken from real tool-like responses.
 *
 * Run: npx tsx src/runtime/hard-graph-juice-process-gate.test.ts
 * Skip: set JUICE_GATE_SKIP=1 if target down (still exits 0 after writing env note).
 */
import assert from "node:assert/strict";
import { mkdtemp, readdir, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PlatformSink, ToolRuntime } from "../types.js";
import { EvidenceStore } from "../stores/evidence.js";
import { GoalStore } from "../stores/goal.js";
import { TodoStore } from "../stores/todo.js";
import { createFindingTool } from "../tools/finding.js";
import { loadHardGraphFile } from "./hard-graph-definition.js";
import { runHardGraph } from "./hard-graph-runner.js";
import { normalizeSubagentResult } from "./subagent-result.js";
import {
  absorbStageResultIntoParent,
  seedStageLifecycleFromParent,
} from "./hard-graph-continuity.js";
import {
  buildHardGraphStageChildRuntime,
  promoteStageSubagentPackagesToParent,
} from "./hard-graph-stage-executor.js";
import { rememberSubagentEvidence } from "./subagent-booking.js";
import { evaluateCandidatesForAcceptance } from "./subagent-result.js";
import { assertSubagentNestAllowed } from "./subagent-handoff.js";
import type { RolePack } from "../roles/types.js";

const JUICE = process.env.JUICE_URL || "http://127.0.0.1:3010";
const SCRATCH =
  process.env.GOAL_SCRATCH || "/tmp/grok-goal-790360bdc7ba/implementer";

async function juiceUp(): Promise<boolean> {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 3000);
    const res = await fetch(JUICE + "/", { signal: ac.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

const up = await juiceUp();
if (!up || process.env.JUICE_GATE_SKIP === "1") {
  await mkdir(join(SCRATCH, "juice-lab"), { recursive: true });
  await writeFile(
    join(SCRATCH, "juice-lab", "env-unavailable.txt"),
    `juice_url=${JUICE}\nup=${up}\nskip=${process.env.JUICE_GATE_SKIP || ""}\n`,
    "utf8",
  );
  console.log("hard-graph-juice-process-gate.test.ts: skip (Juice unavailable or JUICE_GATE_SKIP)");
  process.exit(0);
}

const repoExperts = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../experts/pentest",
);
const mature = await loadHardGraphFile(repoExperts, "app_assessment");
assert.ok(mature);

// Live recon snippets for proof_excerpt (real target)
const loginProbe = await fetch(JUICE + "/rest/user/login", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: "' OR 1=1--", password: "x" }),
});
const loginBody = (await loginProbe.text()).slice(0, 500);
const loginProof = `POST ${JUICE}/rest/user/login email=' OR 1=1-- status=${loginProbe.status} body=${loginBody.slice(0, 200)}`;
assert.ok(loginProof.length >= 40, "login proof from live target");

const memRes = await fetch(JUICE + "/rest/memories");
const memBody = (await memRes.text()).slice(0, 400);
const memProof = `GET ${JUICE}/rest/memories status=${memRes.status} body=${memBody.slice(0, 180)}`;

const root = await mkdtemp(join(tmpdir(), "juice-gate-"));
const taskDir = join(root, "task");
const platform: PlatformSink = { async send() {} };
const parent = {
  task: {
    taskId: "juice-gate",
    conversationId: "c",
    instruction: "lab gate",
    target: { type: "url", value: JUICE },
    scope: { allow: ["127.0.0.1", "localhost"] },
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
    subagentDepth: 0,
    subagentEvidenceCache: [],
  },
} as unknown as ToolRuntime;

const pack: RolePack = {
  id: "pentest",
  label: "pentest",
  toolNames: ["todo", "write", "shell", "http", "subagent", "skill", "finding"],
  skillIds: [],
};

// Mature hard graph run: class_probe uses shipped stage child + promote; fanout N enters processMetrics
const available = ["todo", "read", "fact", "skill", "write", "shell", "http", "subagent", "finding"];
const run = await runHardGraph({
  graph: mature!,
  availableTools: available,
  executeStage: async (input) => {
    const id = input.stage.id;
    if (id === "init") {
      return {
        structured: normalizeSubagentResult({
          ok: true,
          summary: `init ok target ${JUICE}`,
        }),
      };
    }
    if (id === "surface") {
      return {
        structured: normalizeSubagentResult({
          ok: true,
          summary: "surface mapped from live juice",
          surfaces: [
            { location: `${JUICE}/`, kind: "webapp" },
            { location: `${JUICE}/rest/user/login`, kind: "api" },
            { location: `${JUICE}/rest/memories`, kind: "api" },
            { location: `${JUICE}/ftp/`, kind: "directory" },
            { location: `${JUICE}/api/Products`, kind: "api" },
          ],
        }),
      };
    }
    if (id === "class_probe") {
      // Production fan-out path inside the stage that processMetrics will count
      const workDir = join(taskDir, "hard-graph", "app_assessment", "stage-class_probe");
      const { childRuntime } = buildHardGraphStageChildRuntime({
        parent,
        workDir,
        tools: input.tools,
        pack,
      });
      assert.ok(childRuntime.subagents, "class_probe stage host required");
      assert.equal(assertSubagentNestAllowed(childRuntime.lifecycle.subagentDepth).ok, true);
      rememberSubagentEvidence(childRuntime, {
        subagentId: "sub_sqli",
        nodeType: "class_probe",
        candidates: [
          {
            title: "Login SQLi",
            location: `${JUICE}/rest/user/login`,
            severity: "high",
            proof_excerpt: loginProof,
          },
        ],
        acceptance: evaluateCandidatesForAcceptance([
          {
            title: "Login SQLi",
            location: `${JUICE}/rest/user/login`,
            severity: "high",
            proof_excerpt: loginProof,
          },
        ]),
        at: Date.now(),
      });
      rememberSubagentEvidence(childRuntime, {
        subagentId: "sub_mem",
        nodeType: "class_probe",
        candidates: [
          {
            title: "Memories exposure",
            location: `${JUICE}/rest/memories`,
            severity: "high",
            proof_excerpt: memProof,
          },
        ],
        acceptance: evaluateCandidatesForAcceptance([
          {
            title: "Memories exposure",
            location: `${JUICE}/rest/memories`,
            severity: "high",
            proof_excerpt: memProof,
          },
        ]),
        at: Date.now(),
      });
      // Real Join count (same promote used by createHardGraphStageExecutor finalize)
      const fanoutPackagesN = promoteStageSubagentPackagesToParent(
        parent,
        childRuntime,
        "class_probe",
      );
      assert.equal(fanoutPackagesN, 2, "promote returns real package count");
      return {
        structured: normalizeSubagentResult({
          ok: true,
          summary: "class_probe fan-out complete",
          candidates: [
            {
              title: "Login SQLi",
              location: `${JUICE}/rest/user/login`,
              severity: "high",
              proof_excerpt: loginProof,
            },
            {
              title: "Memories exposure",
              location: `${JUICE}/rest/memories`,
              severity: "high",
              proof_excerpt: memProof,
            },
          ],
          deadends: ["ssrf: no internal fetch vector on public rest surface"],
        }),
        fanoutPackagesN,
      };
    }
    if (id === "validate_book") {
      // Book from parent packages joined during class_probe (no act tools)
      const bookChild = {
        ...parent,
        lifecycle: { recentObservations: [], subagentEvidenceCache: [] },
      } as unknown as ToolRuntime;
      bookChild.findingsDir = parent.findingsDir;
      bookChild.evidence = parent.evidence;
      seedStageLifecycleFromParent(parent, bookChild);
      const finding = createFindingTool(bookChild);
      let booked = 0;
      let rejects = 0;
      for (const loc of [`${JUICE}/rest/user/login`, `${JUICE}/rest/memories`]) {
        const title = loc.includes("login") ? "Login SQLi" : "Memories exposure";
        const text = String(
          (
            await finding.execute("f", {
              action: "confirm",
              vuln_type: "other",
              title,
              severity: "high",
              location: loc,
              description: `${title} evidence-backed from live Juice process gate.`,
            })
          ).content?.find((c: { type?: string }) => c.type === "text")?.text || "",
        );
        if (text.startsWith("error:")) rejects += 1;
        else booked += 1;
      }
      assert.equal(booked, 2, "two findings booked without thrash");
      return {
        structured: normalizeSubagentResult({
          ok: true,
          summary: "booked from handoff candidates",
          candidates: input.handoff.candidates.slice(0, 5),
        }),
        bookOutcomes: { booked_n: booked, reject_hints_n: rejects },
      };
    }
    return {
      structured: normalizeSubagentResult({
        ok: true,
        summary: `${id} complete`,
        surfaces: input.handoff.surfaces.slice(0, 3),
        deadends: id === "component" ? ["no rce surface"] : [],
      }),
    };
  },
});

assert.equal(run.terminal, "completed");
assert.ok(run.processMetrics, "process metrics present");
assert.ok(run.processMetrics!.stages_done.length >= 5);
assert.ok(run.processMetrics!.surfaces_n >= 4);
assert.ok(run.processMetrics!.new_candidates_n >= 2);
assert.ok(
  run.processMetrics!.coverage_attempt_rate > 0,
  "coverage attempts not all silent untested after probe",
);
// Feedback export must carry REAL fan-out package N (not candidates>0 heuristic)
assert.equal(
  run.processMetrics!.fanout_packages_n,
  2,
  `processMetrics.fanout_packages_n must be real Join count, got ${run.processMetrics!.fanout_packages_n}`,
);
assert.ok(run.processMetrics!.book_outcomes, "book_outcomes always exported");
assert.equal(run.processMetrics!.book_outcomes.booked_n, 2, "book_outcomes.booked_n from validate_book");
assert.ok((parent.lifecycle.subagentEvidenceCache || []).length >= 2, "parent holds joined packages");

const files = (await readdir(parent.findingsDir)).filter((f) => f.endsWith(".json"));
assert.equal(files.length, 2, "two findings on disk");

await mkdir(join(SCRATCH, "juice-lab"), { recursive: true });
await writeFile(
  join(SCRATCH, "juice-lab", "process-metrics.json"),
  JSON.stringify(
    {
      juice: JUICE,
      terminal: run.terminal,
      processMetrics: run.processMetrics,
      booked: files.length,
      fanout_packs_lifecycle: (parent.lifecycle.subagentEvidenceCache || []).length,
      fanout_packages_n_metrics: run.processMetrics!.fanout_packages_n,
      book_outcomes: run.processMetrics!.book_outcomes,
    },
    null,
    2,
  ),
  "utf8",
);

console.log("hard-graph-juice-process-gate.test.ts: ok");
