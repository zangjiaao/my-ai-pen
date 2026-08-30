/**
 * S-cov-1: surface mark/unmark/skip work-state (Spec #518).
 * External behavior through the surface tool + SQLite store.
 * Run: npx tsx src/tools/surface-coverage.test.ts
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SurfaceSqliteStore, SURFACE_UPSERT_BATCH_MAX } from "../stores/surface-sqlite.js";
import { createSurfaceTool } from "./surface.js";
import type { ToolRuntime } from "../types.js";
import type { TaskEnvelope } from "../types.js";
import { UPSERT_TERMINAL_STATUS_ERROR } from "../stores/surface-coverage.js";

function minimalRuntime(taskDir: string, store: SurfaceSqliteStore, expertId = "pentest"): ToolRuntime {
  const task = {
    taskId: "t-cov-518",
    conversationId: "c-518",
    instruction: "test",
    expertId,
    target: { type: "url", value: "https://lab.example/" },
    scope: { allow: ["https://lab.example"] },
  } as TaskEnvelope;
  return {
    task,
    workspaceDir: taskDir,
    piDir: taskDir,
    platform: { async send() {} },
    todo: {} as ToolRuntime["todo"],
    evidence: {} as ToolRuntime["evidence"],
    findingsDir: join(taskDir, "findings"),
    goals: {} as ToolRuntime["goals"],
    surfaceSqlite: store,
    lifecycle: { subagentDepth: 0, workerAudit: null },
  };
}

async function toolJson(tool: ReturnType<typeof createSurfaceTool>, params: Record<string, unknown>) {
  const out = await tool.execute("call-1", params);
  const text = out.content?.[0] && "text" in out.content[0] ? String((out.content[0] as { text: string }).text) : "";
  if (text.startsWith("error:")) {
    return { error: text, raw: out };
  }
  return { data: JSON.parse(text) as Record<string, unknown>, raw: out };
}

const dir = await mkdtemp(join(tmpdir(), "node4-surface-cov-"));
const store = new SurfaceSqliteStore(SurfaceSqliteStore.pathFromTaskDir(dir));
await store.open();
const tool = createSurfaceTool(minimalRuntime(dir, store));

await store.upsert(
  [
    { location: "https://lab.example/login" },
    { location: "https://lab.example/" },
    { location: "https://lab.example/admin" },
  ],
  { source: "traffic", allowTested: true },
);

// --- mark existing identity → tested; status stays probe-machine ---
{
  const before = await store.get({ location: "https://lab.example/login" });
  assert.equal(before?.status, "seen");
  assert.equal(before?.coverage, "untested");
  const r = await toolJson(tool, { op: "mark", location: "https://lab.example/login" });
  assert.ok(r.data, `mark failed: ${r.error}`);
  const row = r.data!.surface as Record<string, unknown>;
  assert.equal(row.coverage, "tested");
  assert.equal(row.status, "seen", "mark does not change internal status");
  assert.equal(row.coverage_marked_by, "pentest");
  assert.ok(typeof row.coverage_marked_at === "string" && String(row.coverage_marked_at).length > 0);
}

// --- skip existing identity → skipped + reason; status unchanged ---
{
  const r = await toolJson(tool, {
    op: "skip",
    location: "https://lab.example/admin",
    reason: "deadend",
  });
  assert.ok(r.data, `skip failed: ${r.error}`);
  const row = r.data!.surface as Record<string, unknown>;
  assert.equal(row.coverage, "skipped");
  assert.equal(row.coverage_skip_reason, "deadend");
  assert.equal(row.status, "seen");
}

// --- skip reason=roe ---
{
  await store.upsert([{ location: "https://lab.example/wipe" }], { source: "traffic" });
  const r = await toolJson(tool, { op: "skip", location: "https://lab.example/wipe", reason: "roe" });
  assert.ok(r.data, `skip roe failed: ${r.error}`);
  assert.equal((r.data!.surface as Record<string, unknown>).coverage_skip_reason, "roe");
}

// --- skip without reason errors ---
{
  const r = await toolJson(tool, { op: "skip", location: "https://lab.example/" });
  assert.ok(r.error);
  assert.match(r.error!, /reason=deadend\|roe/);
}

// --- unmark returns untested ---
{
  const r = await toolJson(tool, { op: "unmark", location: "https://lab.example/login" });
  assert.ok(r.data, `unmark failed: ${r.error}`);
  const row = r.data!.surface as Record<string, unknown>;
  assert.equal(row.coverage, "untested");
  assert.equal(row.coverage_skip_reason, undefined);
}

// --- missing identity cannot invent coverage ---
{
  const r = await toolJson(tool, { op: "mark", location: "https://lab.example/not-on-tree" });
  assert.ok(r.error);
  assert.match(r.error!, /not on the tree|cannot invent coverage/i);
  assert.match(r.error!, /mark\|unmark\|skip/);
}

// --- origin/root seed row may be marked without HTTP (row already exists) ---
{
  const r = await toolJson(tool, { op: "mark", location: "https://lab.example/" });
  assert.ok(r.data, `root mark failed: ${r.error}`);
  assert.equal((r.data!.surface as Record<string, unknown>).coverage, "tested");
  assert.equal((r.data!.surface as Record<string, unknown>).path_key, "/");
}

// --- mark locations[] covers many existing identities in one call ---
{
  await store.upsert(
    [
      { location: "https://lab.example/batch-a" },
      { location: "https://lab.example/batch-b" },
      { location: "https://lab.example/batch-c" },
    ],
    { source: "traffic" },
  );
  const r = await toolJson(tool, {
    op: "mark",
    locations: [
      "https://lab.example/batch-a",
      "https://lab.example/batch-b",
      "https://lab.example/batch-c",
    ],
  });
  assert.ok(r.data, `batch mark failed: ${r.error}`);
  assert.equal(r.data!.ok, true);
  const rows = r.data!.surfaces as Array<Record<string, unknown>>;
  assert.equal(rows.length, 3);
  assert.equal(r.data!.written, 3);
  assert.deepEqual(
    rows.map((s) => s.coverage),
    ["tested", "tested", "tested"],
  );
  assert.equal((await store.get({ location: "https://lab.example/batch-a" }))?.coverage, "tested");
  assert.equal((await store.get({ location: "https://lab.example/batch-c" }))?.coverage, "tested");
}

// --- batch keeps admitted marks when one location is fail-closed ---
{
  await store.upsert([{ location: "https://lab.example/batch-keep" }], { source: "traffic" });
  const r = await toolJson(tool, {
    op: "mark",
    locations: ["https://lab.example/batch-keep", "https://crt.sh/"],
  });
  assert.ok(r.data, `mixed batch should return JSON, not a hard error: ${r.error}`);
  assert.equal(r.data!.ok, true);
  assert.equal(r.data!.written, 1);
  const errs = r.data!.errors as Array<Record<string, unknown>>;
  assert.equal(errs.length, 1);
  assert.match(String(errs[0]!.error), /fail-closed|admitted Case Host/i);
  assert.equal((await store.get({ location: "https://lab.example/batch-keep" }))?.coverage, "tested");
}

// --- skip locations[] uses one reason for every row ---
{
  await store.upsert(
    [
      { location: "https://lab.example/skip-a" },
      { location: "https://lab.example/skip-b" },
    ],
    { source: "traffic" },
  );
  const r = await toolJson(tool, {
    op: "skip",
    reason: "deadend",
    locations: ["https://lab.example/skip-a", "https://lab.example/skip-b"],
  });
  assert.ok(r.data, `batch skip failed: ${r.error}`);
  assert.equal(r.data!.written, 2);
  assert.equal((await store.get({ location: "https://lab.example/skip-a" }))?.coverage, "skipped");
  assert.equal((await store.get({ location: "https://lab.example/skip-b" }))?.coverage_skip_reason, "deadend");
}

{
  const tooMany = Array.from({ length: SURFACE_UPSERT_BATCH_MAX + 1 }, (_, i) => `https://lab.example/cap-${i}`);
  const r = await toolJson(tool, { op: "mark", locations: tooMany });
  assert.ok(r.error);
  assert.match(r.error!, /batch max/);
}

// --- upsert deadend/skipped_roe is a hard error, not a silent translate ---
{
  const dead = await toolJson(tool, {
    op: "upsert",
    location: "https://lab.example/login",
    status: "deadend",
  });
  assert.ok(dead.error);
  assert.match(dead.error!, /no longer accepts status=deadend\|skipped_roe/);
  assert.match(dead.error!, /op=skip/);
  assert.ok(dead.error!.includes("skip") || dead.error!.includes(UPSERT_TERMINAL_STATUS_ERROR.slice(0, 20)));

  const roe = await toolJson(tool, {
    op: "upsert",
    location: "https://lab.example/login",
    status: "skipped_roe",
  });
  assert.ok(roe.error);
  assert.match(roe.error!, /skipped_roe/);
}

// --- purpose=test / allowCaseTested does not write work-state ---
{
  const r = await store.upsert(
    [
      {
        location: "https://lab.example/login",
        status: "touched",
        case_tested: true,
      },
    ],
    { source: "traffic", allowTested: true, allowCaseTested: true },
  );
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.upserted[0]!.status, "touched");
    assert.equal(r.upserted[0]!.coverage, "untested", "Traffic must not write coverage");
  }
}

// --- summary buckets read work-state ---
{
  await toolJson(tool, { op: "mark", location: "https://lab.example/login" });
  const r = await toolJson(tool, { op: "summary" });
  assert.ok(r.data);
  assert.equal(typeof r.data!.tested, "number");
  assert.equal(typeof r.data!.untested, "number");
  assert.equal(typeof r.data!.skipped, "number");
  assert.ok((r.data!.tested as number) >= 2, "login + root marked tested");
  assert.ok((r.data!.skipped as number) >= 1);
  assert.equal(
    (r.data!.tested as number) + (r.data!.untested as number) + (r.data!.skipped as number),
    r.data!.total,
  );
  const guidance = String(r.data!.guidance);
  assert.match(guidance, /surface\(op=mark\)|op=mark/i);
  assert.doesNotMatch(guidance, /purpose=test traffic sets case_tested/);
  assert.doesNotMatch(guidance, /cannot fake case_tested/);
}

// --- default list is the untested actionable queue ---
{
  const r = await toolJson(tool, { op: "list" });
  assert.ok(r.data);
  const list = r.data!.surfaces as Array<Record<string, unknown>>;
  for (const s of list) {
    assert.equal(s.coverage, "untested");
    assert.ok(s.status === "seen" || s.status === "touched");
  }
}

// --- Worker stamp on skip ---
{
  const workerRt = minimalRuntime(dir, store, "pentest");
  workerRt.lifecycle.workerAudit = { agentId: "sub_cov", packageTurnId: "pkg_1" };
  workerRt.lifecycle.subagentDepth = 1;
  const workerTool = createSurfaceTool(workerRt);
  await store.upsert([{ location: "https://lab.example/api" }], { source: "traffic" });
  const r = await toolJson(workerTool, {
    op: "skip",
    location: "https://lab.example/api",
    reason: "deadend",
  });
  assert.ok(r.data);
  assert.equal((r.data!.surface as Record<string, unknown>).coverage_marked_by, "pentest/sub_cov");
}

{
  const missing = await store.get({ location: "https://crt.sh/" });
  assert.equal(missing, null);
  const r = await toolJson(tool, { op: "mark", location: "https://crt.sh/" });
  assert.ok(r.error);
  assert.match(r.error!, /fail-closed|admitted Case Host/i);
  assert.equal(await store.get({ location: "https://crt.sh/" }), null);
}

{
  await store.upsert([{ location: "https://crt.sh/" }], { source: "traffic" });
  const r = await toolJson(tool, { op: "mark", location: "https://crt.sh/" });
  assert.ok(r.error);
  assert.match(r.error!, /fail-closed|admitted Case Host/i);
  const row = await store.get({ location: "https://crt.sh/" });
  assert.equal(row?.coverage, "untested");
}

{
  const r = await toolJson(tool, { op: "upsert", location: "https://dns.google/resolve" });
  assert.ok(r.error);
  assert.match(r.error!, /fail-closed|admitted Case Host/i);
}

{
  const portRt = minimalRuntime(dir, store, "pentest");
  portRt.task = {
    ...portRt.task,
    target: { type: "url", value: "https://lab.example:443/" },
    scope: { allow: ["https://lab.example:443"] },
  };
  const portTool = createSurfaceTool(portRt);
  const r8080 = await toolJson(portTool, { op: "upsert", location: "https://lab.example:8080/side" });
  assert.ok(r8080.error);
  assert.match(r8080.error!, /fail-closed|admitted Case Host/i);
  const r443 = await toolJson(portTool, { op: "mark", location: "https://lab.example/login" });
  assert.ok(r443.data);
}

store.close();

// --- one-time historical status → coverage map; later open only reads work-state ---
{
  const migDir = await mkdtemp(join(tmpdir(), "node4-surface-cov-mig-"));
  const sqlitePath = SurfaceSqliteStore.pathFromTaskDir(migDir);
  const { mkdir } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  await mkdir(dirname(sqlitePath), { recursive: true });
  const db = new DatabaseSync(sqlitePath);
  db.exec(`
    CREATE TABLE surfaces (
      id TEXT PRIMARY KEY NOT NULL,
      origin_key TEXT NOT NULL,
      path_key TEXT NOT NULL,
      location TEXT NOT NULL,
      kind TEXT,
      methods_json TEXT,
      params_json TEXT,
      auth TEXT,
      status TEXT NOT NULL,
      note TEXT,
      source TEXT,
      source_agent_id TEXT,
      platform_sync TEXT NOT NULL DEFAULT 'offline',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      case_tested INTEGER NOT NULL DEFAULT 0
    );
  `);
  db.prepare(
    `INSERT INTO surfaces (id, origin_key, path_key, location, status, platform_sync, created_at, updated_at, case_tested)
     VALUES (?, ?, ?, ?, ?, 'offline', ?, ?, 0)`,
  ).run(
    "https://old.example:443/gone",
    "https://old.example:443",
    "/gone",
    "https://old.example/gone",
    "deadend",
    "2026-01-01T00:00:00.000Z",
    "2026-01-01T00:00:00.000Z",
  );
  db.prepare(
    `INSERT INTO surfaces (id, origin_key, path_key, location, status, platform_sync, created_at, updated_at, case_tested)
     VALUES (?, ?, ?, ?, ?, 'offline', ?, ?, 0)`,
  ).run(
    "https://old.example:443/roe",
    "https://old.example:443",
    "/roe",
    "https://old.example/roe",
    "skipped_roe",
    "2026-01-01T00:00:00.000Z",
    "2026-01-01T00:00:00.000Z",
  );
  db.close();

  const migStore = new SurfaceSqliteStore(sqlitePath);
  await migStore.open();
  const gone = await migStore.get({ location: "https://old.example/gone" });
  assert.ok(gone);
  assert.equal(gone!.coverage, "skipped");
  assert.equal(gone!.coverage_skip_reason, "deadend");
  assert.equal(gone!.status, "touched", "legacy deadend status collapsed to touched");
  const roe = await migStore.get({ location: "https://old.example/roe" });
  assert.ok(roe);
  assert.equal(roe!.coverage, "skipped");
  assert.equal(roe!.coverage_skip_reason, "roe");
  assert.equal(roe!.status, "touched");
  migStore.close();
  await rm(migDir, { recursive: true, force: true });
}

await rm(dir, { recursive: true, force: true });
console.log("surface-coverage.test.ts: ok");
