/**
 * Spec #125 / #132 gate: f6ffa588-shaped process-quality e2e on runHardGraph.
 * Shape only (partial package fail + agent result.json full-success claim ignored +
 * L2 no clobber + zero confirms ⇒ booked 0). No live DVWA / platform DB.
 *
 * Run: npx tsx src/runtime/process-quality-store-first-e2e.test.ts
 */
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHardGraph, type StageExecutor } from "./hard-graph-runner.js";
import type { HardGraphDefinition } from "./hard-graph-definition.js";
import { settleHostStage } from "./host-stage-settlement.js";
import {
  createProcessQualityState,
  ensureProcessQuality,
} from "./package-honesty-host.js";
import { recordPackageTerminal } from "./package-settlement-law.js";
import {
  HardGraphPlanStore,
  buildHardGraphProgress,
} from "./hard-graph-plan.js";
import { ingestPackageCandidatesToStore } from "./finding-store.js";
import { createFindingTool } from "../tools/finding.js";
import { SurfaceLedgerStore } from "../stores/surface-ledger.js";
import { EvidenceStore } from "../stores/evidence.js";
import { TodoStore } from "../stores/todo.js";
import { GoalStore } from "../stores/goal.js";
import type { ToolRuntime } from "../types.js";
import { isPackageSuccess } from "./package-settlement-law.js";
import { mayMarkL2DoneForPackage } from "./package-settlement-law.js";

const dir = await mkdtemp(join(tmpdir(), "pq-store-first-"));
const platformMessages: Array<Record<string, unknown>> = [];

try {
  const graph: HardGraphDefinition = {
    discipline: "hard",
    id: "f6_shape",
    label: "f6ffa588 shape",
    stages: [
      {
        id: "auth_session",
        require: { summary: true },
        max_retries: 1,
        tools: { allow: ["todo", "subagent", "fact", "finding"] },
      },
    ],
  };

  const plan = new HardGraphPlanStore(graph);
  const pq = createProcessQualityState();
  const stageId = "auth_session";
  const alias: Record<string, string> = {};

  // 5 success / 2 fail packages (forensic shape)
  const successKeys = ["pkg-csrf", "pkg-setup", "pkg-weak", "pkg-sec", "pkg-login"];
  const failKeys = ["pkg-fail-a", "pkg-fail-b"];
  for (const k of successKeys) {
    recordPackageTerminal(pq.packageTerminals, alias, {
      primary_key: k,
      terminal: "success",
      stage_id: stageId,
    });
  }
  for (const k of failKeys) {
    recordPackageTerminal(pq.packageTerminals, alias, {
      primary_key: k,
      terminal: "failed",
      stage_id: stageId,
    });
  }
  pq.packageTerminalAliasIndex = alias;

  // L2 package-anchored done rows with worker chips
  plan.setStageTodos(stageId, [
    {
      node_id: "todo-csrf",
      title: "CSRF on security.php",
      status: "done",
      level: "work_item",
      kind: "task",
      source: "plan",
      agent_id: "sub_csrf",
      owner_agent_name: "Worker CSRF",
    },
    {
      node_id: "todo-setup",
      title: "setup.php probe",
      status: "done",
      level: "work_item",
      kind: "task",
      source: "plan",
      agent_id: "sub_setup",
      owner_agent_name: "Worker Setup",
    },
    {
      node_id: "todo-other",
      title: "misc",
      status: "pending",
      level: "work_item",
      kind: "task",
      source: "plan",
    },
  ]);
  plan.setStageStatus(stageId, "running");

  // Store candidates with proof (no confirms yet)
  const ids = ingestPackageCandidatesToStore(
    pq.findingStore,
    [
      {
        title: "CSRF token missing",
        location: "http://dvwa/security.php",
        claim: "state-changing request without CSRF token accepted",
        severity: "high",
        proof_excerpt:
          "POST /security.php without token returned 200 and security level changed — verbatim tool body",
        poc_hint: "POST security.php seclev=low without csrf token → observe 200 and cookie",
      },
    ],
    {
      package_id: "sub_csrf",
      plan_node_id: "todo-csrf",
      stage_id: stageId,
      agent_id: "sub_csrf",
    },
  );
  assert.equal(ids.length, 1);
  assert.equal(pq.findingStore.get(ids[0]!)?.status, "feedback_ok");

  const ledger = new SurfaceLedgerStore(SurfaceLedgerStore.pathFromTaskDir(dir));
  await ledger.upsertFromRecon([{ location: "http://dvwa/security.php", kind: "form" }]);

  const runtime = {
    task: {
      taskId: "d38b48ed-shape",
      conversationId: "f6ffa588-shape",
      instruction: "assess",
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
    surfaceLedger: ledger,
    lifecycle: {
      subagentDepth: 0,
      processQuality: pq,
      hardGraphRun: { plan, usage: {} as any, panel: {} as any, stageId },
      recentObservations: [
        {
          sourceTool: "http",
          summary: "csrf",
          excerpt:
            "POST /security.php without token returned 200 and security level changed — verbatim tool body",
          path_or_url: "http://dvwa/security.php",
          at: Date.now(),
          capture: { via: "http", command: "POST /security.php", status: 200 },
        },
      ],
    },
  } as unknown as ToolRuntime;

  // Poison agent result.json claiming full success (silent partial fiction)
  const workDir = join(dir, "hard-graph", "f6_shape", "stage-0-auth_session");
  await mkdir(workDir, { recursive: true });
  await writeFile(
    join(workDir, "result.json"),
    JSON.stringify({
      ok: true,
      summary: "all packages succeeded; findings booked in result.json",
      surfaces: [],
      severity: "high",
      candidates: [{ title: "booked fiction", location: "http://x", proof_excerpt: "x".repeat(40) }],
      failed_packages: [],
    }),
    "utf8",
  );

  const exec: StageExecutor = async () => {
    // Host settlement only — agent file ignored
    const settlement = await settleHostStage({
      stageId,
      runtime,
      narrative: { summary: "auth_session wave settled" },
    });
    assert.equal(settlement.agent_result_json_ignored, true);
    assert.equal(settlement.host_declared_keys.length, 2);
    assert.equal(settlement.honesty.host_owned_declare, true);
    assert.equal(settlement.honesty.ok, true, "host declare → no running → ok");
    assert.equal(settlement.structured.ok, true);
    // Zero confirms so far
    assert.equal(pq.findingStore.counts().booked_n, 0);
    return {
      structured: settlement.structured,
      fanoutPackagesN: 7,
      findingsBookedN: pq.findingStore.counts().booked_n,
      feedbackOkIds: settlement.feedback_ok_ids,
    };
  };

  let stageEndIds: string[] | undefined;
  const result = await runHardGraph({
    graph,
    executeStage: exec,
    availableTools: ["todo", "subagent", "fact", "finding"],
    onEvent: (e) => {
      if (e.type === "stage_end" && e.stageId === stageId) {
        stageEndIds = e.feedback_ok_ids;
      }
    },
  });

  // Honest partial may pass (host declared fails)
  assert.equal(result.terminal, "completed");
  assert.equal(result.processMetrics?.structure_fail_n ?? 0, 0);
  assert.equal(result.processMetrics?.findings_booked_n ?? 0, 0, "zero confirms → booked 0");
  // Captain surface: confirmable ids after settlement (Spec #130)
  assert.ok(stageEndIds && stageEndIds.length >= 1, "stage_end feedback_ok_ids for Main");
  const settleAgain = await settleHostStage({
    stageId,
    runtime,
    narrative: { summary: "auth_session wave settled" },
  });
  assert.match(String(settleAgain.structured.notes || ""), /confirmable_feedback_ok_ids:/);

  // L2 no clobber: Main todo.done on another row
  plan.setStageTodos(stageId, [
    {
      node_id: "todo-csrf",
      title: "CSRF on security.php",
      status: "pending",
      level: "work_item",
      kind: "task",
      source: "plan",
    },
    {
      node_id: "todo-setup",
      title: "setup.php probe",
      status: "pending",
      level: "work_item",
      kind: "task",
      source: "plan",
    },
    {
      node_id: "todo-other",
      title: "misc",
      status: "done",
      level: "work_item",
      kind: "task",
      source: "plan",
    },
  ]);
  const csrf = plan.toPlanTree().find((n) => n.node_id === "todo-csrf") as any;
  assert.equal(csrf?.status, "done", "package done not clobbered by Main todo");
  assert.equal(csrf?.agent_id, "sub_csrf", "worker chip survives");

  // Package-owned failed cannot be greened by Todo done
  plan.upsertStageWorkItem(stageId, {
    node_id: "todo-fail-owned",
    title: "failed owned",
    status: "failed",
    agent_id: "sub_fail",
    owner_agent_name: "Worker Fail",
    level: "work_item",
    kind: "task",
    source: "plan",
  });
  plan.setStageTodos(stageId, [
    {
      node_id: "todo-fail-owned",
      title: "failed owned",
      status: "done",
      level: "work_item",
      kind: "task",
      source: "plan",
    },
  ]);
  assert.equal(
    (plan.toPlanTree().find((n) => n.node_id === "todo-fail-owned") as any)?.status,
    "failed",
    "package-owned failed not greened",
  );

  // If stage blocked, progress label must say so (not full-green success fiction)
  plan.setStageStatus(stageId, "blocked");
  const prog = buildHardGraphProgress(plan);
  assert.equal(prog.stage_blocked, true);
  assert.match(prog.label, /blocked/i);

  // Salvage ≠ success / L2 done
  assert.equal(
    isPackageSuccess({ ok: true, salvaged: true, has_valid_result: false }),
    false,
  );
  assert.equal(mayMarkL2DoneForPackage("success", true).ok, false);

  // Spec #279: confirm without Store id still books with valid L0; Store feedback_ok path remains.
  const tool = createFindingTool(runtime);
  const execFind = tool.execute as (
    id: string,
    params: Record<string, unknown>,
  ) => Promise<{ content: Array<{ type: string; text?: string }> }>;

  // Foreign UUID must not invent-without-id hard-stop (books as new row when L0 passes)
  const foreign = await execFind("x", {
    action: "confirm",
    vuln_type: "other",
    finding_id: "6194731f-aaaa-bbbb-cccc-ddddeeee0099",
    title: "CSRF token missing foreign",
    location: "http://dvwa/security.php",
    description: "state-changing request without CSRF token accepted on security level change",
    poc: "POST /security.php seclev=low without csrf → 200 and cookie change observed",
    proof:
      "POST /security.php without token returned 200 and security level changed — verbatim tool body",
    severity: "medium",
  });
  const foreignText = foreign.content?.map((c) => c.text || "").join(" ") || "";
  assert.ok(
    !/invent-without-id|unknown finding id/i.test(foreignText),
    `foreign id must not hard-stop: ${foreignText.slice(0, 200)}`,
  );
  assert.ok(!/^error:/i.test(foreignText.trim()), `foreign id books: ${foreignText.slice(0, 200)}`);
  // Store feedback_ok row not auto-booked by foreign path
  assert.equal(pq.findingStore.counts().booked_n, 0);

  const fid = ids[0]!;
  const ok = await execFind("x", {
    action: "confirm",
    vuln_type: "other",
    finding_id: fid,
    title: "CSRF token missing",
    location: "http://dvwa/security.php",
    description: "state-changing request without CSRF token accepted on security level change",
    poc: "POST /security.php seclev=low without csrf → 200 and cookie change observed",
    proof:
      "POST /security.php without token returned 200 and security level changed — verbatim tool body",
    severity: "medium",
  });
  const okText = ok.content?.map((c) => c.text || "").join(" ") || "";
  assert.ok(!/^error:/i.test(okText.trim()), `confirm should succeed: ${okText.slice(0, 200)}`);
  assert.equal(pq.findingStore.get(fid)?.status, "booked");
  assert.ok(platformMessages.some((m) => m.type === "vuln_found"), "platform booking signal");

  // Sub cannot confirm
  runtime.lifecycle.subagentDepth = 1;
  const subDenied = await execFind("x", {
    action: "confirm",
    vuln_type: "other",
    finding_id: fid,
    title: "x",
    location: "http://dvwa/x",
    description: "long enough description here",
    poc: "steps and observed result long enough for gate",
    proof: "proof excerpt long enough for grounding checks here ok",
  });
  const subText = subDenied.content?.map((c) => c.text || "").join(" ") || "";
  assert.match(subText, /subagent must not|Main books/i);

  // Serial upsert without result.json
  runtime.lifecycle.subagentDepth = 0;
  const upsert = await execFind("x", {
    action: "upsert",
    title: "Serial candidate",
    location: "http://dvwa/login.php",
    description: "serial Main deposit path",
    severity: "high",
    proof: "login response body showed SQL error near quote when testing auth form fields",
    poc: "POST login.php with quote payload → observe SQL error in body",
  });
  const upText = upsert.content?.map((c) => c.text || "").join(" ") || "";
  assert.ok(/finding_ids|feedback_ok/i.test(upText) || upText.includes("Serial"), upText.slice(0, 300));

  console.log("process-quality-store-first-e2e.test.ts: ok");
} finally {
  await rm(dir, { recursive: true, force: true });
}
