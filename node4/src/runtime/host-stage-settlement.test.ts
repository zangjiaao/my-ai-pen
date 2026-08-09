/**
 * Spec #125 / #126: host stage settlement SoT — ignore agent result.json.
 * Seam: settleHostStage + runHardGraph injectable executor.
 * Run: npx tsx src/runtime/host-stage-settlement.test.ts
 */
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hostDeclareFailedKeys,
  settleHostStage,
  packageNeedsHostDeclaration,
} from "./host-stage-settlement.js";
import {
  evaluateStageGate,
  runHardGraph,
  type StageExecutor,
} from "./hard-graph-runner.js";
import type { HardGraphDefinition } from "./hard-graph-definition.js";
import { createProcessQualityState, ensureProcessQuality } from "./package-honesty-host.js";
import { recordPackageTerminal } from "./package-settlement-law.js";
import { ingestPackageCandidatesToStore } from "./finding-store.js";
import { SurfaceLedgerStore } from "../stores/surface-ledger.js";
import type { ToolRuntime } from "../types.js";
import { isHardGraphDefinition } from "./hard-graph-definition.js";

const dir = await mkdtemp(join(tmpdir(), "host-settle-"));

function makeRuntime(opts?: {
  packageTerminals?: Array<{
    key: string;
    terminal: "success" | "failed" | "aborted" | "never_started" | "running";
    salvaged?: boolean;
  }>;
  stageId?: string;
}): ToolRuntime {
  const pq = createProcessQualityState();
  const stageId = opts?.stageId || "auth_session";
  const alias: Record<string, string> = {};
  for (const p of opts?.packageTerminals || []) {
    recordPackageTerminal(pq.packageTerminals, alias, {
      primary_key: p.key,
      terminal: p.terminal,
      salvaged: p.salvaged,
      stage_id: stageId,
    });
  }
  pq.packageTerminalAliasIndex = alias;
  const ledger = new SurfaceLedgerStore(SurfaceLedgerStore.pathFromTaskDir(dir));
  return {
    task: {
      taskId: "t1",
      conversationId: "c1",
      instruction: "test",
      workspaceDir: dir,
    },
    workspaceDir: dir,
    taskDir: dir,
    platform: { send: async () => {} },
    todo: {} as any,
    evidence: {} as any,
    findingsDir: join(dir, "findings"),
    lifecycle: {
      processQuality: pq,
      hardGraphRun: { plan: {} as any, usage: {} as any, panel: {} as any, stageId },
    },
    surfaceLedger: ledger,
  } as unknown as ToolRuntime;
}

// --- Pure host declare ---
{
  const pkgs = [
    { package_key: "a", terminal: "success" as const },
    { package_key: "b", terminal: "failed" as const },
    { package_key: "c", terminal: "success" as const, salvaged: true },
  ];
  assert.equal(packageNeedsHostDeclaration(pkgs[0]!), false);
  assert.equal(packageNeedsHostDeclaration(pkgs[1]!), true);
  assert.equal(packageNeedsHostDeclaration(pkgs[2]!), true);
  assert.deepEqual(hostDeclareFailedKeys(pkgs), ["b", "c"]);
}

// --- Host settlement ignores agent ok:true; declares package fails ---
{
  const runtime = makeRuntime({
    packageTerminals: [
      { key: "pkg-1", terminal: "success" },
      { key: "pkg-2", terminal: "success" },
      { key: "pkg-3", terminal: "success" },
      { key: "pkg-4", terminal: "success" },
      { key: "pkg-5", terminal: "success" },
      { key: "pkg-6", terminal: "failed" },
      { key: "pkg-7", terminal: "failed" },
    ],
  });
  // Agent would have claimed full success in result.json — host must not care.
  const settlement = await settleHostStage({
    stageId: "auth_session",
    runtime,
    narrative: {
      summary: "all packages green and booked",
      deadends: [],
    },
  });
  assert.equal(settlement.agent_result_json_ignored, true);
  assert.deepEqual(settlement.host_declared_keys.sort(), ["pkg-6", "pkg-7"]);
  assert.equal(settlement.honesty.host_owned_declare, true);
  assert.equal(settlement.honesty.silent_partial, false);
  assert.equal(settlement.honesty.ok, true, "host declare → no running → ok");
  assert.equal(settlement.structured.ok, true, "honest partial may pass");
  assert.ok(
    settlement.structured.deadends.some((d) => d.includes("pkg-6")),
    "declared fails appear in deadends",
  );
  // Captain surface is on settlement, not stripped normalize extras
  assert.deepEqual(settlement.host_declared_failed, settlement.host_declared_keys);
}

// --- Running packages block settlement ok ---
{
  const runtime = makeRuntime({
    packageTerminals: [
      { key: "p1", terminal: "success" },
      { key: "p2", terminal: "running" },
    ],
  });
  const s = await settleHostStage({ stageId: "auth_session", runtime });
  assert.equal(s.structured.ok, false);
  assert.ok(s.running_packages.includes("p2"));
}

// --- Surfaces + summary from host (no result.json) can pass gate ---
{
  const runtime = makeRuntime({ stageId: "surface" });
  await runtime.surfaceLedger!.upsertFromRecon([
    { location: "http://t/login", kind: "form" },
    { location: "http://t/setup.php", kind: "page" },
  ]);
  const s = await settleHostStage({
    stageId: "surface",
    runtime,
    narrative: { summary: "recon complete" },
  });
  assert.equal(s.structured.surfaces.length, 2);
  assert.equal(s.structured.ok, true);
  const gate = evaluateStageGate(
    { id: "surface", require: { summary: true, surfaces_min: 1 } },
    s.structured,
  );
  assert.equal(gate.ok, true, "host ledger surfaces satisfy surfaces_min without result.json");
}

// --- Definition: write no longer required ---
assert.equal(
  isHardGraphDefinition({
    discipline: "hard",
    id: "no_write_ok",
    stages: [{ id: "init", tools: { allow: ["todo", "fact", "skill"] } }],
  }),
  true,
  "non-empty allow without write is valid under Spec #125",
);

// --- Seam: runHardGraph with host settlement projection (partial fail class) ---
{
  const graph: HardGraphDefinition = {
    discipline: "hard",
    id: "settle_probe",
    label: "settle probe",
    stages: [
      {
        id: "wave",
        require: { summary: true },
        max_retries: 0,
      },
    ],
  };

  // Simulate production: executor returns host-settled structured (not agent file).
  const exec: StageExecutor = async () => {
    const runtime = makeRuntime({
      stageId: "wave",
      packageTerminals: [
        { key: "s1", terminal: "success" },
        { key: "s2", terminal: "success" },
        { key: "s3", terminal: "success" },
        { key: "s4", terminal: "success" },
        { key: "s5", terminal: "success" },
        { key: "f1", terminal: "failed" },
        { key: "f2", terminal: "failed" },
      ],
    });
    // Poison workdir with agent full-success claim — must not matter to gate input.
    const work = join(dir, "poison-stage");
    await mkdir(work, { recursive: true });
    await writeFile(
      join(work, "result.json"),
      JSON.stringify({
        ok: true,
        summary: "all green silent partial",
        surfaces: [],
        candidates: [],
        failed_packages: [],
      }),
      "utf8",
    );
    const settlement = await settleHostStage({
      stageId: "wave",
      runtime,
      narrative: { summary: "wave complete" },
    });
    // Prove agent file claimed ok true while host declared fails
    assert.equal(settlement.structured.ok, true);
    assert.ok(settlement.host_declared_keys.length === 2);
    return { structured: settlement.structured, fanoutPackagesN: 7 };
  };

  const result = await runHardGraph({
    graph,
    executeStage: exec,
    availableTools: ["todo", "subagent", "fact"],
  });
  assert.equal(result.terminal, "completed", "honest partial host settlement may complete stage");
  assert.ok((result.processMetrics?.structure_fail_n ?? 0) === 0);
}

// --- Seam: silent partial impossible when host settles (running undeclared was old path) ---
// Host always declares; structure_fail only when honesty fails (e.g. illegal L2) or require fails.
{
  const graph: HardGraphDefinition = {
    discipline: "hard",
    id: "require_fail",
    label: "require fail",
    stages: [
      {
        id: "surface",
        require: { summary: true, surfaces_min: 1 },
        max_retries: 0,
      },
    ],
  };
  const exec: StageExecutor = async () => {
    const runtime = makeRuntime({ stageId: "surface" });
    // No surfaces in ledger → require fails even with agent ok:true narrative
    const settlement = await settleHostStage({
      stageId: "surface",
      runtime,
      narrative: { summary: "I wrote result.json with surfaces" },
    });
    return { structured: settlement.structured };
  };
  const blocked = await runHardGraph({
    graph,
    executeStage: exec,
    availableTools: ["todo"],
  });
  assert.equal(blocked.terminal, "blocked");
  assert.ok((blocked.processMetrics?.structure_fail_n ?? 0) >= 1);
  const rec = blocked.stages.find((s) => s.stageId === "surface");
  assert.ok(rec?.errors?.some((e) => e.startsWith("surfaces_min")));
}

// --- Store candidates project into settlement + captain-visible confirm ids ---
{
  const runtime = makeRuntime({ stageId: "class_probe" });
  const store = ensureProcessQuality(runtime.lifecycle).findingStore;
  ingestPackageCandidatesToStore(
    store,
    [
      {
        title: "SQLi",
        location: "http://t/login",
        claim: "auth bypass",
        severity: "high",
        proof_excerpt: "MySQL syntax error near ''' OR 1=1--' at line 1 when submitting login form",
      },
    ],
    { package_id: "p1", stage_id: "class_probe", plan_node_id: "todo-sqli" },
  );
  const s = await settleHostStage({ stageId: "class_probe", runtime, narrative: { summary: "probed" } });
  assert.ok(s.structured.candidates.length >= 1);
  assert.ok(s.feedback_ok_ids.length >= 1, "L0 feedback_ok ids captain-visible");
  assert.equal(s.structured.ok, true);
  assert.match(
    String(s.structured.notes || ""),
    /confirmable_feedback_ok_ids:/,
    "notes carry captain confirm surface",
  );
  assert.match(s.structured.summary, /feedback_ok_ids=/);
}

// --- Illegal L2 done for failed package fails host settlement ---
{
  const { HardGraphPlanStore } = await import("./hard-graph-plan.js");
  const graph: HardGraphDefinition = {
    discipline: "hard",
    id: "l2_illegal",
    label: "l2",
    stages: [{ id: "auth_session", require: { summary: true }, max_retries: 0 }],
  };
  const plan = new HardGraphPlanStore(graph);
  plan.setStageTodos("auth_session", [
    {
      node_id: "pkg-fail-a",
      title: "failed pkg",
      status: "done", // illegal: package failed but L2 done
      level: "work_item",
      kind: "task",
      source: "plan",
      agent_id: "sub_x",
    },
  ]);
  const runtime = makeRuntime({
    stageId: "auth_session",
    packageTerminals: [{ key: "pkg-fail-a", terminal: "failed" }],
  });
  (runtime.lifecycle as any).hardGraphRun = {
    plan,
    usage: {},
    panel: {},
    stageId: "auth_session",
  };
  const s = await settleHostStage({
    stageId: "auth_session",
    runtime,
    narrative: { summary: "wave" },
  });
  assert.equal(s.honesty.ok, false, "illegal L2 done fails honesty");
  assert.equal(s.structured.ok, false);
  assert.ok(s.honesty.illegal_l2_done.includes("pkg-fail-a"));
  assert.ok(s.structured.deadends.some((d) => d.startsWith("illegal_l2_done:")));
}

// --- runHardGraph stage_end carries feedback_ok_ids ---
{
  const graph: HardGraphDefinition = {
    discipline: "hard",
    id: "ids_emit",
    label: "ids",
    stages: [{ id: "wave", require: { summary: true }, max_retries: 0 }],
  };
  let seenIds: string[] | undefined;
  const exec: StageExecutor = async () => {
    const runtime = makeRuntime({ stageId: "wave" });
    const store = ensureProcessQuality(runtime.lifecycle).findingStore;
    const ids = ingestPackageCandidatesToStore(
      store,
      [
        {
          title: "X",
          location: "http://t/x",
          severity: "high",
          proof_excerpt: "proof excerpt long enough for L0 mechanical feedback gate xx",
        },
      ],
      { package_id: "p", stage_id: "wave" },
    );
    const settlement = await settleHostStage({
      stageId: "wave",
      runtime,
      narrative: { summary: "ok" },
    });
    return {
      structured: settlement.structured,
      feedbackOkIds: settlement.feedback_ok_ids.length
        ? settlement.feedback_ok_ids
        : ids,
    };
  };
  await runHardGraph({
    graph,
    executeStage: exec,
    availableTools: ["todo"],
    onEvent: (e) => {
      if (e.type === "stage_end" && e.outcome === "passed") {
        seenIds = e.feedback_ok_ids;
      }
    },
  });
  assert.ok(seenIds && seenIds.length >= 1, "stage_end emits feedback_ok_ids");
}

// --- NC-Honesty-Advance #183: book-path reject does not block stage settlement ---
{
  const runtime = makeRuntime({
    stageId: "class_probe",
    packageTerminals: [
      { key: "ok-pkg", terminal: "success" },
      { key: "fail-pkg", terminal: "failed" },
    ],
  });
  const store = ensureProcessQuality(runtime.lifecycle).findingStore;
  // severity missing → reject at ingest (not stored)
  const noSev = ingestPackageCandidatesToStore(
    store,
    [
      {
        title: "NoSev",
        location: "http://t/a",
        proof_excerpt: "proof excerpt long enough for L0 mechanical feedback gate xx",
      },
    ],
    { package_id: "ok-pkg", stage_id: "class_probe" },
  );
  assert.equal(noSev.length, 0, "missing severity rejected at ingest");
  // severity present, proof missing → feedback_reject after L0, not stage fail
  const weakIds = ingestPackageCandidatesToStore(
    store,
    [
      {
        title: "NoProof",
        location: "http://t/b",
        severity: "high",
        // proof omitted → mechanical L0 reject
      },
    ],
    { package_id: "ok-pkg", stage_id: "class_probe" },
  );
  assert.equal(weakIds.length, 1, "candidate stored then L0-evaluated");
  const weakRow = store.get(weakIds[0]!);
  assert.equal(weakRow?.status, "feedback_reject", "book-path L0 reject");
  const s = await settleHostStage({
    stageId: "class_probe",
    runtime,
    narrative: { summary: "partial packages + weak book path" },
  });
  assert.equal(s.honesty.ok, true, "book-path rejects do not flip honesty.ok");
  assert.equal(s.structured.ok, true, "book-path rejects do not flip structured.ok");
  assert.ok(s.host_declared_keys.includes("fail-pkg"));
  assert.equal(s.feedback_ok_ids.length, 0, "no feedback_ok from rejected book path");
  const gate = evaluateStageGate(
    { id: "class_probe", require: { summary: true } },
    s.structured,
  );
  assert.equal(gate.ok, true, "stage may advance with honest partial + book-path rejects");
}

// --- NC-Honesty-Advance #183: gate error codes distinguish honesty vs structure ---
{
  // structure miss only
  const structGate = evaluateStageGate(
    { id: "surface", require: { summary: true, surfaces_min: 2 } },
    {
      ok: true,
      summary: "hi",
      summaryProvided: true,
      surfaces: [{ location: "http://t/one" }],
      candidates: [],
      facts: [],
      deadends: [],
    } as any,
  );
  assert.equal(structGate.ok, false);
  assert.ok(structGate.ok === false && structGate.errors.some((e) => e.startsWith("surfaces_min:")));
  assert.ok(structGate.ok === false && !structGate.errors.includes("structured_ok_false"));

  // honesty cannot-advance (illegal L2 deadend projected)
  const honestyGate = evaluateStageGate(
    { id: "authz_logic", require: { summary: true } },
    {
      ok: false,
      summary: "host settlement · illegal_l2_done=pkg-x",
      summaryProvided: true,
      surfaces: [],
      candidates: [],
      facts: [],
      deadends: ["illegal_l2_done:pkg-x", "failed_package:pkg-x"],
    } as any,
  );
  assert.equal(honestyGate.ok, false);
  assert.ok(honestyGate.ok === false && honestyGate.errors.includes("structured_ok_false"));
  assert.ok(
    honestyGate.ok === false && honestyGate.errors.includes("illegal_l2_done:pkg-x"),
    "honesty machine reason on gate errors",
  );
  assert.ok(
    honestyGate.ok === false && !honestyGate.errors.some((e) => e.startsWith("failed_package:")),
    "failed_package alone is not a gate error code (honest partial residual)",
  );

  // running package reason
  const runGate = evaluateStageGate(
    { id: "wave", require: { summary: true } },
    {
      ok: false,
      summary: "still running",
      summaryProvided: true,
      surfaces: [],
      candidates: [],
      facts: [],
      deadends: ["running_package:p2"],
    } as any,
  );
  assert.ok(runGate.ok === false && runGate.errors.includes("running_package:p2"));
}

// --- NC-Honesty-Advance #183: illegal L2 → runHardGraph blocked (not honest partial) ---
{
  const { HardGraphPlanStore } = await import("./hard-graph-plan.js");
  const graph: HardGraphDefinition = {
    discipline: "hard",
    id: "illegal_blocks",
    label: "illegal",
    stages: [{ id: "authz_logic", require: { summary: true }, max_retries: 0 }],
  };
  const exec: StageExecutor = async () => {
    const plan = new HardGraphPlanStore(graph);
    plan.setStageTodos("authz_logic", [
      {
        node_id: "pkg-bad",
        title: "bad",
        status: "done",
        level: "work_item",
        kind: "task",
        source: "plan",
      },
    ]);
    const runtime = makeRuntime({
      stageId: "authz_logic",
      packageTerminals: [
        { key: "pkg-good", terminal: "success" },
        { key: "pkg-bad", terminal: "failed" },
      ],
    });
    (runtime.lifecycle as any).hardGraphRun = {
      plan,
      usage: {},
      panel: {},
      stageId: "authz_logic",
    };
    const settlement = await settleHostStage({
      stageId: "authz_logic",
      runtime,
      narrative: { summary: "wave" },
    });
    assert.equal(settlement.structured.ok, false);
    return { structured: settlement.structured };
  };
  const blocked = await runHardGraph({
    graph,
    executeStage: exec,
    availableTools: ["todo", "subagent"],
  });
  assert.equal(blocked.terminal, "blocked");
  const rec = blocked.stages.find((s) => s.stageId === "authz_logic");
  assert.ok(rec?.errors?.includes("structured_ok_false"));
  assert.ok(rec?.errors?.some((e) => e.startsWith("illegal_l2_done:")));
}

await rm(dir, { recursive: true, force: true });
console.log("host-stage-settlement.test.ts: ok");
