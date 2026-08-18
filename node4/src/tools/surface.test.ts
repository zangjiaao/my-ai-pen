/**
 * Seam S2: surface tool + SQLite working store (Spec #368 / #370 / #383 D5).
 * External behavior only — not SQL internals as product contract.
 * Run: npx tsx src/tools/surface.test.ts
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SurfaceSqliteStore, SURFACE_WRITE_HARD_CAP } from "../stores/surface-sqlite.js";
import { SurfaceLedgerStore } from "../stores/surface-ledger.js";
import { createSurfaceTool, depositSurfaceLocation } from "./surface.js";
import type { ToolRuntime } from "../types.js";
import type { TaskEnvelope } from "../types.js";

function minimalRuntime(
  taskDir: string,
  opts?: {
    surfaceSqlite?: SurfaceSqliteStore;
    surfaceLedger?: SurfaceLedgerStore;
    workerAudit?: { agentId: string; packageTurnId: string } | null;
    subagentDepth?: number;
  },
): ToolRuntime {
  const task = {
    taskId: "t-surface-370",
    conversationId: "c1",
    instruction: "test",
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
    surfaceSqlite: opts?.surfaceSqlite,
    surfaceLedger: opts?.surfaceLedger,
    lifecycle: {
      subagentDepth: opts?.subagentDepth ?? 0,
      workerAudit: opts?.workerAudit ?? null,
    },
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

const dir = await mkdtemp(join(tmpdir(), "node4-surface-tool-"));
const sqlitePath = SurfaceSqliteStore.pathFromTaskDir(dir);
const store = new SurfaceSqliteStore(sqlitePath);
await store.open();
const legacy = new SurfaceLedgerStore(SurfaceLedgerStore.pathFromTaskDir(dir));
await legacy.ensureDir();
await legacy.load();

const runtime = minimalRuntime(dir, { surfaceSqlite: store, surfaceLedger: legacy });
const tool = createSurfaceTool(runtime);

// --- upsert + get identity normalize ---
{
  const r = await toolJson(tool, {
    op: "upsert",
    location: "https://Host.Example:443/api/Users?x=1",
    methods: ["get"],
    params: ["id"],
    kind: "api",
    note: "from recon",
  });
  assert.ok(r.data, `upsert failed: ${r.error}`);
  assert.equal(r.data!.ok, true);
  assert.equal(r.data!.created, 1);
  assert.equal(r.data!.total, 1);
  assert.equal(r.data!.platform_sync, "offline");
  assert.equal(r.data!.source_agent_id, "main");
  const surfaces = r.data!.surfaces as Array<Record<string, unknown>>;
  assert.equal(surfaces[0]!.origin_key, "https://host.example:443");
  assert.equal(surfaces[0]!.path_key, "/api/users");
  assert.deepEqual(surfaces[0]!.methods, ["GET"]);
  assert.deepEqual(surfaces[0]!.params, ["id"]);
}

// --- merge params/methods on same identity; agent cannot fake TESTED (#411) ---
{
  const r = await toolJson(tool, {
    op: "upsert",
    location: "https://host.example/api/users",
    methods: ["POST"],
    params: ["name"],
    status: "touched",
  });
  assert.ok(r.data);
  assert.equal(r.data!.created, 0);
  assert.equal(r.data!.updated, 1);
  const surfaces = r.data!.surfaces as Array<Record<string, unknown>>;
  assert.deepEqual(surfaces[0]!.methods, ["GET", "POST"]);
  assert.deepEqual(surfaces[0]!.params, ["id", "name"]);
  assert.equal(
    surfaces[0]!.status,
    "seen",
    "agent upsert cannot elevate to touched/TESTED without traffic",
  );
}

// --- upsert cannot set booked ---
{
  const r = await toolJson(tool, {
    op: "upsert",
    location: "https://host.example/api/users",
    status: "booked",
  });
  assert.ok(r.data);
  const surfaces = r.data!.surfaces as Array<Record<string, unknown>>;
  assert.equal(surfaces[0]!.status, "seen", "booked ignored on ordinary upsert");
}

// --- traffic-objective upsert can still mark TESTED (settle path) ---
{
  const r = await store.upsert(
    [
      {
        location: "https://host.example/api/users",
        status: "touched",
        methods: ["GET"],
        case_tested: true,
      },
    ],
    {
      source: "traffic",
      source_agent_id: "main",
      allowTested: true,
      allowCaseTested: true,
    },
  );
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.upserted[0]!.status, "touched", "source=traffic may set TESTED");
    assert.equal(r.upserted[0]!.case_tested, true, "purpose=test settle sets case_tested");
  }

  // Agent cannot invent case_tested on another path
  const fake = await store.upsert(
    [{ location: "https://host.example/login", status: "touched", case_tested: true }],
    { source: "agent" },
  );
  assert.ok(fake.ok);
  if (fake.ok) {
    assert.equal(fake.upserted[0]!.case_tested, false, "agent cannot fake case_tested");
  }
}

// --- list default seen+touched ---
{
  await toolJson(tool, {
    op: "upsert",
    location: "https://host.example/login",
    status: "seen",
  });
  await toolJson(tool, {
    op: "upsert",
    location: "https://host.example/admin",
    status: "deadend",
  });
  const r = await toolJson(tool, { op: "list" });
  assert.ok(r.data);
  assert.equal(r.data!.ok, true);
  assert.equal(r.data!.returned, 2, "default excludes deadend/booked");
  assert.equal(r.data!.total_matching, 2);
  assert.equal(r.data!.has_more, false);
  const list = r.data!.surfaces as Array<Record<string, unknown>>;
  for (const s of list) {
    assert.ok(s.status === "seen" || s.status === "touched");
  }
}

// --- list status=all + has_more pagination ---
{
  const rAll = await toolJson(tool, { op: "list", status: "all" });
  assert.ok(rAll.data);
  assert.equal(rAll.data!.total_matching, 3);

  // page size 1
  const p0 = await toolJson(tool, { op: "list", status: "all", limit: 1, offset: 0 });
  assert.ok(p0.data);
  assert.equal(p0.data!.returned, 1);
  assert.equal(p0.data!.has_more, true);
  assert.equal(p0.data!.total_matching, 3);

  const p2 = await toolJson(tool, { op: "list", status: "all", limit: 1, offset: 2 });
  assert.ok(p2.data);
  assert.equal(p2.data!.returned, 1);
  assert.equal(p2.data!.has_more, false);
}

// --- #383 summary shape (seen/touched/booked counts + samples) ---
{
  const r = await toolJson(tool, { op: "summary" });
  assert.ok(r.data, `summary failed: ${r.error}`);
  assert.equal(r.data!.ok, true);
  assert.equal(r.data!.op, "summary");
  assert.equal(typeof r.data!.total, "number");
  assert.ok((r.data!.total as number) >= 3);
  assert.equal(typeof r.data!.seen, "number");
  assert.equal(typeof r.data!.touched, "number");
  // Spec #413: tested = case_tested count (≥1 purpose=test), not multi-hit-only touched.
  assert.equal(typeof r.data!.tested, "number");
  assert.equal(r.data!.tested, r.data!.case_tested);
  assert.ok((r.data!.tested as number) >= 1, "traffic case_tested counted as tested");
  // Spec #411/#413: new_untested queue = !case_tested (seen_fallback when no is_new)
  assert.equal(typeof r.data!.new_untested, "number");
  assert.equal(
    r.data!.new_untested,
    (r.data!.total as number) - (r.data!.tested as number),
    "untested = total − case_tested (no is_new flags)",
  );
  assert.equal((r.data!.counts as Record<string, number>).new_untested, r.data!.new_untested);
  assert.ok(Array.isArray(r.data!.new_untested_samples));
  assert.equal(r.data!.new_untested_mode, "seen_fallback");
  assert.equal(typeof r.data!.booked, "number");
  assert.equal(typeof r.data!.deadend, "number");
  assert.equal(typeof r.data!.skipped_roe, "number");
  assert.equal(typeof r.data!.actionable, "number");
  assert.equal(
    (r.data!.actionable as number),
    (r.data!.seen as number) + (r.data!.touched as number),
  );
  assert.ok((r.data!.deadend as number) >= 1, "admin deadend counted");
  const counts = r.data!.counts as Record<string, number>;
  assert.ok(counts);
  assert.equal(counts.seen, r.data!.seen);
  assert.equal(counts.touched, r.data!.touched);
  assert.equal(counts.tested, r.data!.tested);
  assert.equal(counts.case_tested, r.data!.tested);
  assert.equal(counts.booked, r.data!.booked);
  assert.equal(counts.deadend, r.data!.deadend);
  assert.equal(counts.skipped_roe, r.data!.skipped_roe);
  assert.ok(Array.isArray(r.data!.sample_paths));
  assert.ok(Array.isArray(r.data!.samples));
  const samples = r.data!.samples as Array<Record<string, unknown>>;
  for (const s of samples) {
    assert.ok(typeof s.location === "string" || typeof s.path_key === "string");
    assert.ok(typeof s.status === "string");
  }
  // Tool description posture: summary is primary; guidance must not require upsert deposit
  assert.ok(typeof r.data!.guidance === "string");
  assert.doesNotMatch(String(r.data!.guidance), /must (?:deposit|upsert|register)/i);
  assert.match(String(r.data!.guidance), /priors.*≠|NEW untested/i, "guidance: priors ≠ coverage / NEW duty");
}

// --- summary empty ledger ---
{
  const emptyDir = await mkdtemp(join(tmpdir(), "node4-surface-sum-empty-"));
  const emptyStore = new SurfaceSqliteStore(SurfaceSqliteStore.pathFromTaskDir(emptyDir));
  await emptyStore.open();
  const emptyRt = minimalRuntime(emptyDir, { surfaceSqlite: emptyStore });
  const emptyTool = createSurfaceTool(emptyRt);
  const r = await toolJson(emptyTool, { op: "summary" });
  assert.ok(r.data);
  assert.equal(r.data!.ok, true);
  assert.equal(r.data!.total, 0);
  assert.equal(r.data!.seen, 0);
  assert.equal(r.data!.touched, 0);
  assert.equal(r.data!.booked, 0);
  assert.equal(r.data!.actionable, 0);
  assert.deepEqual(r.data!.sample_paths, []);
  assert.deepEqual(r.data!.samples, []);
  emptyStore.close();
  await rm(emptyDir, { recursive: true, force: true });
}

// --- get by location ---
{
  const r = await toolJson(tool, {
    op: "get",
    location: "https://host.example/api/users?q=1",
  });
  assert.ok(r.data);
  assert.equal((r.data!.surface as Record<string, unknown>).path_key, "/api/users");
}

// --- Worker source_agent_id on same store ---
{
  const workerRt = minimalRuntime(dir, {
    surfaceSqlite: store,
    surfaceLedger: legacy,
    workerAudit: { agentId: "sub_42", packageTurnId: "pkg_1" },
    subagentDepth: 1,
  });
  const workerTool = createSurfaceTool(workerRt);
  const r = await toolJson(workerTool, {
    op: "upsert",
    location: "ssh://10.0.0.5:22",
    kind: "ssh",
    note: "worker deposit",
  });
  assert.ok(r.data);
  assert.equal(r.data!.source_agent_id, "sub_42");
  assert.equal(r.data!.created, 1);
  const g = await toolJson(tool, { op: "get", location: "ssh://10.0.0.5" });
  assert.ok(g.data);
  assert.equal((g.data!.surface as Record<string, unknown>).origin_key, "ssh://10.0.0.5:22");
  assert.equal((g.data!.surface as Record<string, unknown>).path_key, "");
  assert.equal((g.data!.surface as Record<string, unknown>).source_agent_id, "sub_42");
}

// --- hard-cap reject ---
{
  const capDir = await mkdtemp(join(tmpdir(), "node4-surface-cap-"));
  const capStore = new SurfaceSqliteStore(SurfaceSqliteStore.pathFromTaskDir(capDir));
  await capStore.open();
  // Fill to hard-cap via direct store (faster than tool loop for 2000)
  const bulk: { location: string }[] = [];
  for (let i = 0; i < SURFACE_WRITE_HARD_CAP; i++) {
    bulk.push({ location: `https://cap.test/p/${i}` });
  }
  // batch in chunks of 20
  for (let i = 0; i < bulk.length; i += 20) {
    const chunk = bulk.slice(i, i + 20);
    const res = await capStore.upsert(chunk, { source_agent_id: "main" });
    assert.equal(res.ok, true, `bulk fill failed at ${i}`);
  }
  assert.equal(await capStore.count(), SURFACE_WRITE_HARD_CAP);

  const capRt = minimalRuntime(capDir, { surfaceSqlite: capStore });
  const capTool = createSurfaceTool(capRt);
  const blocked = await toolJson(capTool, {
    op: "upsert",
    location: "https://cap.test/p/overflow",
  });
  assert.ok(blocked.error, "expected hard-cap error");
  assert.match(blocked.error!, /hard-cap/i);

  // Updating existing identity still allowed at cap
  const upd = await toolJson(capTool, {
    op: "upsert",
    location: "https://cap.test/p/0",
    params: ["x"],
  });
  assert.ok(upd.data);
  assert.equal(upd.data!.ok, true);
  assert.equal(upd.data!.updated, 1);
  assert.equal(upd.data!.created, 0);

  capStore.close();
  await rm(capDir, { recursive: true, force: true });
}

// --- legacy JSON one-shot migrate ---
{
  const migDir = await mkdtemp(join(tmpdir(), "node4-surface-mig-"));
  await mkdir(join(migDir, "surfaces"), { recursive: true });
  await writeFile(
    join(migDir, "surfaces", "ledger.json"),
    JSON.stringify({
      version: 1,
      updated_at: new Date().toISOString(),
      surfaces: [
        {
          id: "/vuln/sqli",
          location: "http://127.0.0.1:8080/vuln/sqli",
          path_key: "/vuln/sqli",
          status: "open",
          params: ["id"],
          updated_at: new Date().toISOString(),
        },
        {
          id: "/vuln/xss",
          location: "http://127.0.0.1:8080/vuln/xss",
          path_key: "/vuln/xss",
          status: "probed",
          updated_at: new Date().toISOString(),
        },
      ],
    }),
    "utf8",
  );
  const migStore = new SurfaceSqliteStore(SurfaceSqliteStore.pathFromTaskDir(migDir));
  await migStore.open();
  assert.equal(await migStore.count(), 2);
  // Legacy JSON statuses may remain on migrate until re-write; list default maps open→seen filter.
  const seenOrOpen = await migStore.list({ status: "seen" });
  assert.ok(seenOrOpen.total_matching >= 1, "migrated open/seen rows listable as seen");
  const probed = await migStore.get({ location: "http://127.0.0.1:8080/vuln/xss" });
  assert.ok(probed);
  // Expand-contract: unmigrated legacy "probed" may remain until rewrite; normalize on read path of list.
  assert.ok(
    probed!.status === "probed" || probed!.status === "touched",
    `expected probed or touched, got ${probed!.status}`,
  );
  migStore.close();
  await rm(migDir, { recursive: true, force: true });
}

// --- depositSurfaceLocation helper (fact thin wrapper) ---
{
  const dep = await depositSurfaceLocation(runtime, {
    location: "redis://10.1.2.3:6379",
    note: "exposed redis",
    source_agent_id: "main_serial",
  });
  assert.ok(dep.ok, dep.ok ? "ok" : dep.error);
  assert.equal((dep as { created: number }).created, 1);
  const g = await store.get({ location: "redis://10.1.2.3:6379" });
  assert.ok(g);
  assert.equal(g!.kind, "redis");
}

// --- offline: no platformApi required ---
{
  assert.equal(runtime.platformApi, undefined);
  const r = await toolJson(tool, { op: "list", status: "all", limit: 5 });
  assert.ok(r.data);
  assert.equal(r.data!.ok, true);
}

// --- #371: gates read SQLite working store (no JSON dual-write required) ---
{
  const sum = await store.summary();
  assert.ok(sum.total >= 1, "SQLite working store is gate coverage SoT");
  assert.ok(typeof sum.actionable === "number");
  assert.ok(Array.isArray(sum.open_preview));
  // Legacy JSON may stay empty after dual-write removal — migrate-only path remains on open().
  await legacy.load();
  // No requirement that legacy mirror tool upserts.
}

store.close();
await rm(dir, { recursive: true, force: true });
console.log("surface.test.ts: ok");
