/**
 * Spec #279 Wave1 — finding(confirm) id contract at tool boundary.
 *
 * - confirm without finding_id + valid L0 → ok + id
 * - confirm with random/other-case UUID + valid proof → books (not invent-without-id hard stop)
 * - L0 fail still fails closed
 * - this-run Store feedback_ok id still works (Graph Store-first overlay)
 *
 * Run: npx tsx src/tools/finding.confirm-id.test.ts
 */
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolRuntime } from "../types.js";
import { EvidenceStore } from "../stores/evidence.js";
import { GoalStore } from "../stores/goal.js";
import { TodoStore } from "../stores/todo.js";
import { FindingStore, ingestPackageCandidatesToStore } from "../runtime/finding-store.js";
import { createProcessQualityState } from "../runtime/package-honesty-host.js";
import { SurfaceSqliteStore } from "../stores/surface-sqlite.js";
import { createFindingTool } from "./finding.js";

const PROOF =
  "MySQL syntax error near ''' OR 1=1--' at line 1 when submitting login — demonstrable differential";
const POC =
  "POST /login.php username=admin' OR '1'='1 password=x → observe MySQL error and session cookie set";

function textOf(result: { content?: Array<{ type?: string; text?: string }> }): string {
  return (result.content || []).map((c) => c.text || "").join(" ");
}

function parseJsonText(text: string): Record<string, unknown> | null {
  const t = text.trim();
  if (!t.startsWith("{")) return null;
  try {
    return JSON.parse(t) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function makeRuntime(opts: {
  dir: string;
  store?: FindingStore;
  hardGraph?: boolean;
  surfaceSqlite?: SurfaceSqliteStore;
  platformMessages: Array<Record<string, unknown>>;
}): Promise<ToolRuntime> {
  const pq = createProcessQualityState();
  if (opts.store) pq.findingStore = opts.store;
  return {
    task: {
      taskId: "t-279",
      conversationId: "c-279",
      instruction: "spec 279 confirm id",
      target: { type: "url", value: "http://host/login.php" },
      scope: { allow: ["host"] },
    },
    workspaceDir: opts.dir,
    piDir: opts.dir,
    platform: {
      send: async (msg: Record<string, unknown>) => {
        opts.platformMessages.push(msg);
      },
    },
    todo: new TodoStore(),
    evidence: new EvidenceStore(join(opts.dir, "evidence")),
    findingsDir: join(opts.dir, "findings"),
    goals: new GoalStore(),
    surfaceSqlite: opts.surfaceSqlite,
    lifecycle: {
      subagentDepth: 0,
      processQuality: pq,
      ...(opts.hardGraph
        ? { hardGraphRun: { plan: {} as any, usage: {} as any, panel: {} as any, stageId: "validate_book" } }
        : {}),
      recentObservations: [
        {
          sourceTool: "http",
          summary: "login sqli",
          excerpt: PROOF,
          path_or_url: "http://host/login.php",
          at: Date.now(),
          capture: { via: "http", command: "POST /login.php", status: 200 },
        },
      ],
    },
  } as unknown as ToolRuntime;
}

const baseConfirm = {
  action: "confirm",
  title: "SQL injection login",
  location: "http://host/login.php",
  description: "Auth bypass demonstrated with SQL error on login form",
  poc: POC,
  proof: PROOF,
  severity: "high",
  vuln_type: "sqli",
} as const;

const dir = await mkdtemp(join(tmpdir(), "finding-confirm-id-"));
const platformMessages: Array<Record<string, unknown>> = [];

try {
  // --- 1) Free path: confirm without finding_id + valid L0 → ok + id ---
  {
    platformMessages.length = 0;
    const runtime = await makeRuntime({ dir: join(dir, "no-id"), platformMessages });
    const tool = createFindingTool(runtime);
    const exec = tool.execute as (
      id: string,
      params: Record<string, unknown>,
    ) => Promise<{ content: Array<{ type: string; text?: string }> }>;
    const res = await exec("c1", { ...baseConfirm });
    const text = textOf(res);
    assert.ok(!/^error:/i.test(text.trim()), `no-id confirm should succeed: ${text.slice(0, 280)}`);
    assert.ok(!/invent-without-id/i.test(text), "must not invent-without-id hard stop");
    const obj = parseJsonText(text);
    assert.ok(obj?.ok === true, "json ok");
    const finding = obj?.finding as Record<string, unknown> | undefined;
    assert.ok(finding && String(finding.id || "").length > 0, "host-minted id present");
    assert.ok(
      platformMessages.some((m) => m.type === "vuln_found"),
      "platform vuln_found emitted",
    );
  }

  // --- 2) Foreign / other-Case UUID + valid proof → books (not invent-without-id) ---
  {
    platformMessages.length = 0;
    const store = new FindingStore();
    const runtime = await makeRuntime({
      dir: join(dir, "foreign"),
      store,
      hardGraph: true,
      platformMessages,
    });
    const tool = createFindingTool(runtime);
    const exec = tool.execute as (
      id: string,
      params: Record<string, unknown>,
    ) => Promise<{ content: Array<{ type: string; text?: string }> }>;
    const foreignId = "6194731f-aaaa-bbbb-cccc-ddddeeee0001"; // other-Case platform UUID
    const res = await exec("c2", { ...baseConfirm, finding_id: foreignId });
    const text = textOf(res);
    assert.ok(
      !/unknown finding id|invent-without-id/i.test(text),
      `foreign id must not hard-stop invent-without-id, got: ${text.slice(0, 300)}`,
    );
    assert.ok(!/^error:/i.test(text.trim()), `foreign id + valid L0 should book: ${text.slice(0, 280)}`);
    const obj = parseJsonText(text);
    assert.ok(obj?.ok === true, "foreign id books ok");
    const finding = obj?.finding as Record<string, unknown> | undefined;
    assert.ok(finding && String(finding.id || "").length > 0, "minted id present");
    // Local mint must not equal the foreign platform UUID (do not overwrite other Case)
    assert.notEqual(String(finding?.id), foreignId, "must not reuse foreign platform UUID as local id");
    assert.ok(
      platformMessages.some((m) => m.type === "vuln_found"),
      "this Case gains a ledger-bound row signal",
    );
    // Optional related_prior_id when foreign UUID provided
    const vuln = platformMessages.find((m) => m.type === "vuln_found");
    if (vuln && "related_prior_id" in vuln) {
      assert.equal(vuln.related_prior_id, foreignId);
    }
  }

  // --- 3) L0 fail still fails closed (missing vuln_type / ungrounded proof) ---
  {
    platformMessages.length = 0;
    const runtime = await makeRuntime({ dir: join(dir, "l0-fail"), platformMessages, hardGraph: true });
    const tool = createFindingTool(runtime);
    const exec = tool.execute as (
      id: string,
      params: Record<string, unknown>,
    ) => Promise<{ content: Array<{ type: string; text?: string }> }>;

    const noType = await exec("c3a", {
      ...baseConfirm,
      vuln_type: undefined,
      finding_id: "6194731f-aaaa-bbbb-cccc-ddddeeee0002",
    });
    const noTypeText = textOf(noType);
    assert.match(noTypeText, /vuln_type|error/i);
    assert.ok(/^error:/i.test(noTypeText.trim()) || /error:/i.test(noTypeText));

    const halluc = await exec("c3b", {
      ...baseConfirm,
      proof: "totally fabricated uid=0(root) never appeared in any tool output at all",
    });
    const hallucText = textOf(halluc);
    assert.ok(/^error:/i.test(hallucText.trim()) || /error:/i.test(hallucText), hallucText.slice(0, 200));
    assert.ok(
      !platformMessages.some((m) => m.type === "vuln_found"),
      "L0 fail must not emit vuln_found",
    );
  }

  // --- 4) This-run Store feedback_ok id still works (Graph Store-first) ---
  {
    platformMessages.length = 0;
    const store = new FindingStore();
    const ids = ingestPackageCandidatesToStore(
      store,
      [
        {
          title: "SQL injection login",
          location: "http://host/login.php",
          claim: "Auth bypass via SQLi",
          severity: "high",
          proof_excerpt: PROOF,
          poc_hint: POC,
        },
      ],
      { package_id: "sub_1", stage_id: "class_probe", agent_id: "sub_1" },
    );
    assert.equal(ids.length, 1);
    const fid = ids[0]!;
    assert.equal(store.get(fid)?.status, "feedback_ok");

    const runtime = await makeRuntime({
      dir: join(dir, "store-ok"),
      store,
      hardGraph: true,
      platformMessages,
    });
    const tool = createFindingTool(runtime);
    const exec = tool.execute as (
      id: string,
      params: Record<string, unknown>,
    ) => Promise<{ content: Array<{ type: string; text?: string }> }>;
    const res = await exec("c4", {
      action: "confirm",
      finding_id: fid,
      vuln_type: "sqli",
      // title/location/proof can be filled from Store; severity from Store when omitted
      title: "SQL injection login",
      location: "http://host/login.php",
      description: "Auth bypass demonstrated with SQL error on login form",
      poc: POC,
      proof: PROOF,
    });
    const text = textOf(res);
    assert.ok(!/^error:/i.test(text.trim()), `Store feedback_ok confirm: ${text.slice(0, 280)}`);
    assert.equal(store.get(fid)?.status, "booked", "Store row marked booked");
    assert.ok(platformMessages.some((m) => m.type === "vuln_found"));
  }

  // --- 5) Free path + store present + random UUID still books ---
  {
    platformMessages.length = 0;
    const store = new FindingStore();
    const runtime = await makeRuntime({
      dir: join(dir, "free-foreign"),
      store,
      hardGraph: false,
      platformMessages,
    });
    const tool = createFindingTool(runtime);
    const exec = tool.execute as (
      id: string,
      params: Record<string, unknown>,
    ) => Promise<{ content: Array<{ type: string; text?: string }> }>;
    const res = await exec("c5", {
      ...baseConfirm,
      finding_id: "e5e2b7cd-1111-2222-3333-444455556666",
    });
    const text = textOf(res);
    assert.ok(
      !/unknown finding id|invent-without-id/i.test(text),
      `Free+foreign must not invent-without-id: ${text.slice(0, 300)}`,
    );
    assert.ok(!/^error:/i.test(text.trim()), `Free foreign books: ${text.slice(0, 280)}`);
  }

  // --- 6) Path-bearing confirm stamps internal booked; must not flip TESTED (#548) ---
  {
    platformMessages.length = 0;
    const bookDir = join(dir, "booked-stamp");
    const surfaceSqlite = new SurfaceSqliteStore(SurfaceSqliteStore.pathFromTaskDir(bookDir));
    await surfaceSqlite.open();
    await surfaceSqlite.upsert(
      [{ location: "http://host/login.php", status: "seen" }],
      { source: "traffic" },
    );
    const before = await surfaceSqlite.get({ location: "http://host/login.php" });
    assert.equal(before?.status, "seen");
    assert.equal(before?.coverage, "untested");

    const runtime = await makeRuntime({
      dir: bookDir,
      surfaceSqlite,
      platformMessages,
    });
    const tool = createFindingTool(runtime);
    const exec = tool.execute as (
      id: string,
      params: Record<string, unknown>,
    ) => Promise<{ content: Array<{ type: string; text?: string }> }>;
    const res = await exec("c6", { ...baseConfirm });
    const text = textOf(res);
    assert.ok(!/^error:/i.test(text.trim()), `booked-stamp confirm should succeed: ${text.slice(0, 280)}`);

    const after = await surfaceSqlite.get({ location: "http://host/login.php" });
    assert.equal(after?.status, "booked", "path-bearing confirm must stamp internal booked");
    assert.equal(after?.coverage, "untested", "confirm must not flip TESTED / coverage");

    const traffic = await surfaceSqlite.upsert(
      [{ location: "http://host/login.php", status: "touched", case_tested: true }],
      { source: "traffic", allowTested: true, allowCaseTested: true },
    );
    assert.ok(traffic.ok);
    const afterTraffic = await surfaceSqlite.get({ location: "http://host/login.php" });
    assert.equal(afterTraffic?.coverage, "untested", "Traffic purpose=test must not write TESTED");
    surfaceSqlite.close();
  }

  // Sanity: at least one finding file written under no-id case
  const noIdFiles = await readdir(join(dir, "no-id", "findings")).catch(() => [] as string[]);
  assert.ok(noIdFiles.some((f) => f.endsWith(".json")), "local finding file written");

  console.log("finding.confirm-id.test.ts: ok");
} finally {
  await rm(dir, { recursive: true, force: true });
}
