/**
 * #71 Hard class_probe Agent Graph fan-out absorb → book.
 * Run: npx tsx src/runtime/hard-graph-fanout.test.ts
 */
import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
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
  hardStagePackageKey,
  seedStageLifecycleFromParent,
} from "./hard-graph-continuity.js";
import {
  applyHardGraphToolProfile,
  loadHardGraphFile,
} from "./hard-graph-definition.js";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

function textOf(result: { content?: Array<{ type?: string; text?: string }> }): string {
  const item = result.content?.find((c) => c.type === "text");
  return String(item?.text || "");
}

assert.equal(hardStagePackageKey("class_probe"), "hard-stage:class_probe");
assert.equal(hardStagePackageKey("class_probe", "sqli"), "hard-stage:class_probe:sqli");
assert.equal(
  hardStagePackageKey("class_probe", "xss/dom"),
  "hard-stage:class_probe:xss_dom",
);

const repoExperts = join(dirname(fileURLToPath(import.meta.url)), "../../../experts/pentest");

// Tool profile: class_probe allows subagent (Agent Graph)
const thin = await loadHardGraphFile(repoExperts, "app_assessment_thin");
assert.ok(thin);
const classProbe = thin!.stages.find((s) => s.id === "class_probe");
assert.ok(classProbe?.tools?.allow?.includes("subagent"), "thin class_probe must allow subagent");
const mature = await loadHardGraphFile(repoExperts, "app_assessment");
assert.ok(mature);
const matureProbe = mature!.stages.find((s) => s.id === "class_probe");
assert.ok(matureProbe?.tools?.allow?.includes("subagent"), "mature class_probe must allow subagent");
const profiled = applyHardGraphToolProfile(
  ["shell", "http", "subagent", "finding", "write", "todo"],
  classProbe!.tools,
);
assert.ok(profiled.includes("subagent"));
assert.ok(!profiled.includes("finding"), "probe stage does not book");

// Multi-package Join absorb
async function runtime(): Promise<ToolRuntime> {
  const root = await mkdtemp(join(tmpdir(), "hard-fanout-"));
  const taskDir = join(root, "task");
  const platform: PlatformSink = { async send() {} };
  return {
    task: {
      taskId: "fanout",
      conversationId: "c",
      instruction: "fanout",
      target: { type: "url", value: "http://127.0.0.1:3010" },
      scope: { allow: ["127.0.0.1"] },
      graphDiscipline: "hard",
    },
    workspaceDir: root,
    piDir: taskDir,
    platform,
    todo: new TodoStore(),
    evidence: new EvidenceStore(join(taskDir, "evidence")),
    findingsDir: join(taskDir, "findings"),
    goals: new GoalStore(),
    rolePackId: "pentest",
    lifecycle: { recentObservations: [], subagentEvidenceCache: [] },
  } as unknown as ToolRuntime;
}

const PROOF_SQL =
  'POST /rest/user/login email="\' OR 1=1 --" returns HTTP 200 with admin JWT token in JSON body';
const PROOF_XSS =
  'PUT /rest/products/1/reviews message="<script>alert(1)</script>" stores payload; GET reviews returns the script tag unescaped';

const parent = await runtime();
const child = {
  lifecycle: { recentObservations: [], subagentEvidenceCache: [] },
} as unknown as ToolRuntime;
const seed = seedStageLifecycleFromParent(parent, child);

absorbStageResultIntoParent(parent, {
  stageId: "class_probe",
  workerId: "sqli",
  structured: normalizeSubagentResult({
    ok: true,
    summary: "sqli worker",
    candidates: [
      {
        title: "Login SQLi",
        location: "http://127.0.0.1:3010/rest/user/login",
        severity: "high",
        proof_excerpt: PROOF_SQL,
        poc_hint:
          "POST /rest/user/login with SQLi email; observed 200 JWT for admin in response body",
      },
    ],
  }),
  child,
  seed,
});

absorbStageResultIntoParent(parent, {
  stageId: "class_probe",
  workerId: "xss",
  structured: normalizeSubagentResult({
    ok: true,
    summary: "xss worker",
    candidates: [
      {
        title: "Stored XSS reviews",
        location: "http://127.0.0.1:3010/rest/products/1/reviews",
        severity: "high",
        proof_excerpt: PROOF_XSS,
        poc_hint:
          "PUT review with script tag; observed unescaped script in GET reviews response",
      },
    ],
  }),
  child,
  seed,
});

const packs = parent.lifecycle.subagentEvidenceCache || [];
assert.equal(packs.length, 2, "two worker packages Join");
assert.ok(packs.some((p) => p.subagentId === "hard-stage:class_probe:sqli"));
assert.ok(packs.some((p) => p.subagentId === "hard-stage:class_probe:xss"));

// Empty retry for one worker does not wipe sibling
absorbStageResultIntoParent(parent, {
  stageId: "class_probe",
  workerId: "sqli",
  structured: normalizeSubagentResult({
    ok: true,
    summary: "empty retry",
    candidates: [],
  }),
  child,
  seed,
});
assert.equal(
  (parent.lifecycle.subagentEvidenceCache || []).length,
  2,
  "empty worker absorb must not wipe sibling packages",
);

// Book both from book stage (no act tools)
const book = await runtime();
book.findingsDir = parent.findingsDir;
book.evidence = parent.evidence;
book.task = parent.task;
book.platform = parent.platform;
seedStageLifecycleFromParent(parent, book);
const finding = createFindingTool(book);

const bookSql = textOf(
  await finding.execute("s", {
    action: "confirm",
    vuln_type: "other",
    title: "Login SQLi",
    severity: "critical",
    location: "http://127.0.0.1:3010/rest/user/login",
    description: "SQL injection authentication bypass on login endpoint proven in class_probe worker.",
  }),
);
assert.ok(!bookSql.startsWith("error:"), bookSql.slice(0, 280));

const bookXss = textOf(
  await finding.execute("x", {
    action: "confirm",
    vuln_type: "other",
    title: "Stored XSS reviews",
    severity: "high",
    location: "http://127.0.0.1:3010/rest/products/1/reviews",
    description: "Stored XSS via product reviews message field proven in class_probe worker.",
  }),
);
assert.ok(!bookXss.startsWith("error:"), bookXss.slice(0, 280));

const files = (await readdir(parent.findingsDir)).filter((f) => f.endsWith(".json"));
assert.equal(files.length, 2, "both fan-out candidates booked");

console.log("hard-graph-fanout.test.ts: ok");
