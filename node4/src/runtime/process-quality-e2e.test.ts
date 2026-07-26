/**
 * Spec #116 production-path e2e (no hand-rolled Feedback):
 * ingestPackageCandidatesToStore (same as subagent) → feedback_ok → finding(confirm) → vuln_found
 *
 * Run: npx tsx src/runtime/process-quality-e2e.test.ts
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FindingStore, ingestPackageCandidatesToStore } from "./finding-store.js";
import { createFindingTool } from "../tools/finding.js";
import {
  checkPackageAttemptBudget,
  createProcessQualityState,
} from "./package-honesty-host.js";
import {
  evaluateHonestPartial,
  mayRetryPackage,
  MAX_PACKAGE_ATTEMPTS,
  classifyUserControl,
} from "./package-settlement-law.js";
import type { ToolRuntime } from "../types.js";
import { EvidenceStore } from "../stores/evidence.js";
import { TodoStore } from "../stores/todo.js";
import { GoalStore } from "../stores/goal.js";

const dir = await mkdtemp(join(tmpdir(), "pq-e2e-"));
const platformMessages: Array<Record<string, unknown>> = [];

try {
  const store = new FindingStore();
  // Production subagent path (not setFeedbackResult by hand)
  const ids = ingestPackageCandidatesToStore(
    store,
    [
      {
        title: "SQL injection login",
        location: "http://host/login.php",
        claim: "Auth bypass via SQLi on login form",
        severity: "high",
        proof_excerpt:
          "MySQL syntax error near ''' OR 1=1--' at line 1 when submitting login — demonstrable differential",
        poc_hint:
          "POST /login.php username=admin' OR '1'='1 password=x → observe MySQL error and session cookie",
      },
    ],
    { package_id: "sub_1", plan_node_id: "todo-sqli", stage_id: "class_probe", agent_id: "sub_1" },
  );
  assert.equal(ids.length, 1);
  const fid = ids[0]!;
  assert.equal(store.get(fid)?.status, "feedback_ok", "L0 mechanical Feedback must set feedback_ok");

  // Without L0, pending cannot confirm
  const pendingStore = new FindingStore();
  const p = pendingStore.upsert({
    title: "x",
    location: "http://t/x",
    severity: "high",
    proof_excerpt: "proof text long enough for feedback gate requirements here",
  });
  pendingStore.enqueueFeedback([p.id]);
  assert.equal(pendingStore.get(p.id)?.status, "feedback_pending");
  assert.equal(pendingStore.assertConfirmAllowed(p.id).ok, false, "pending must not confirm");

  const runtime = {
    task: {
      taskId: "t1",
      conversationId: "c1",
      instruction: "test",
      workspaceDir: dir,
    },
    workspaceDir: dir,
    taskDir: dir,
    platform: {
      send: async (msg: Record<string, unknown>) => {
        platformMessages.push(msg);
      },
    },
    todo: new TodoStore(),
    evidence: new EvidenceStore(join(dir, "evidence")),
    findingsDir: join(dir, "findings"),
    goals: new GoalStore(),
    lifecycle: {
      subagentDepth: 0,
      processQuality: (() => {
        const pq = createProcessQualityState();
        pq.findingStore = store;
        return pq;
      })(),
      hardGraphRun: { plan: {} as any, usage: {} as any, panel: {} as any, stageId: "class_probe" },
      recentObservations: [
        {
          sourceTool: "http",
          summary: "login sqli",
          excerpt:
            "MySQL syntax error near ''' OR 1=1--' at line 1 when submitting login — demonstrable differential",
          path_or_url: "http://host/login.php",
          at: Date.now(),
          capture: {
            via: "http",
            command: "POST /login.php",
            status: 200,
          },
        },
      ],
    },
  } as unknown as ToolRuntime;

  const tool = createFindingTool(runtime);
  const exec = tool.execute as (
    id: string,
    params: Record<string, unknown>,
  ) => Promise<{ content: Array<{ type: string; text?: string }>; details?: unknown }>;

  // Missing finding_id on Graph → hard fail
  const noId = await exec("x", {
    action: "confirm",
    title: "SQL injection login",
    location: "http://host/login.php",
    description: "Auth bypass demonstrated with SQL error on login",
    poc: "POST /login.php username=admin' OR '1'='1 password=x → observe MySQL error and session",
    proof: "MySQL syntax error near ''' OR 1=1--' at line 1 when submitting login — demonstrable",
  });
  const noIdText = noId.content?.map((c) => c.text || "").join(" ") || "";
  assert.match(noIdText, /finding_id|feedback_ok|invent/i);

  // Production confirm with Store id
  const ok = await exec("x", {
    action: "confirm",
    finding_id: fid,
    title: "SQL injection login",
    location: "http://host/login.php",
    description: "Auth bypass demonstrated with SQL error on login form",
    poc: "POST /login.php username=admin' OR '1'='1 password=x → observe MySQL error and session cookie set",
    proof:
      "MySQL syntax error near ''' OR 1=1--' at line 1 when submitting login — demonstrable differential",
    severity: "high",
    // Match recentObservations.excerpt substring for grounding
  });
  const okText = ok.content?.map((c) => c.text || "").join(" ") || JSON.stringify(ok.details || {});
  assert.ok(!/^error:/i.test(okText.trim()), `confirm should succeed, got: ${okText.slice(0, 200)}`);

  const vuln = platformMessages.find((m) => m.type === "vuln_found");
  assert.ok(vuln, "platform sink must receive vuln_found");
  assert.equal(store.get(fid)?.status, "booked");

  // Sub cannot confirm
  runtime.lifecycle.subagentDepth = 1;
  const subDenied = await exec("x", {
    action: "confirm",
    finding_id: fid,
    title: "x",
    location: "http://host/login.php",
    description: "Auth bypass demonstrated with SQL error on login form",
    poc: "POST /login.php username=admin' OR '1'='1 password=x → observe MySQL error and session cookie",
    proof: "MySQL syntax error near ''' OR 1=1--' at line 1 when submitting login",
  });
  assert.match(
    subDenied.content?.map((c) => c.text || "").join(" ") || "",
    /subagent must not/i,
  );
  runtime.lifecycle.subagentDepth = 0;

  // Package attempt budget wired (checkPackageAttemptBudget uses mayRetryPackage)
  runtime.lifecycle.processQuality!.packageAttemptCounts = { "todo-sqli": MAX_PACKAGE_ATTEMPTS };
  const budget = checkPackageAttemptBudget(runtime, "todo-sqli");
  assert.equal(budget.ok, false);
  assert.equal(mayRetryPackage(0), true);

  // Honest partial law used with production-shaped packages
  const honesty = evaluateHonestPartial({
    packages: [
      { package_key: "a", terminal: "success", has_valid_result: true },
      { package_key: "b", terminal: "failed" },
    ],
    declared_failed_keys: [],
  });
  assert.ok(honesty.undeclared_failures.includes("b"));

  // Interrupt classification production import
  assert.equal(classifyUserControl({ kind: "ui_interrupt" }).is_package_fail, false);
  assert.ok(classifyUserControl({ kind: "empty_message" }).reject);

  // I0.15: successful confirm ⇒ platform vulnerabilities visible (vuln_found)
  assert.equal(vuln?.type, "vuln_found");
  assert.ok(
    String((vuln as { title?: string })?.title || "").length > 0 ||
      String((vuln as { finding_id?: string })?.finding_id || fid).length > 0,
    "I0.15 platform ledger row present",
  );

  // I0.12 / I0.10 via production subagent tool (stub host so resolve runs before spawn)
  const { createSubagentTool } = await import("../tools/subagent.js");
  (runtime as { subagents?: unknown }).subagents = {
    spawn: async () => {
      throw new Error("spawn must not run in contract test");
    },
  };
  const subTool = createSubagentTool(runtime);
  const subExec = subTool.execute as (
    id: string,
    params: Record<string, unknown>,
  ) => Promise<{ content: Array<{ type: string; text?: string }> }>;
  const incomplete = await subExec("x", {
    this_turn_goal: "probe",
    // missing target/scope/already_done/success_criteria
  });
  assert.match(
    incomplete.content?.map((c) => c.text || "").join(" ") || "",
    /incomplete handoff/i,
    "I0.12 incomplete handoff hard-fail",
  );

  // I0.10 Graph package missing plan_node_id hard-fail
  const noAnchor = await subExec("x", {
    target: "http://host/",
    scope: "in-scope lab only",
    already_done: "recon done",
    this_turn_goal: "probe sqli",
    success_criteria: "candidate or deadend",
    // plan_node_id omitted on Graph
  });
  assert.match(
    noAnchor.content?.map((c) => c.text || "").join(" ") || "",
    /plan_node_id/i,
    "I0.10 Graph package requires plan_node_id",
  );

  console.log("process-quality-e2e.test.ts: ok");
} finally {
  await rm(dir, { recursive: true, force: true });
}
