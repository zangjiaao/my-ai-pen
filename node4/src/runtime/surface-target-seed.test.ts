/**
 * Spec #368 D8 / issue #381 — TARGET/scope seed at task start.
 * Seed without prior traffic; dual-write optional mock.
 * Run: npx tsx src/runtime/surface-target-seed.test.ts  (from node4/)
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SurfaceSqliteStore } from "../stores/surface-sqlite.js";
import type { PlatformMessage, PlatformSink, TaskEnvelope, ToolRuntime } from "../types.js";
import {
  collectTargetSeedLocations,
  seedSurfacesFromTargetAtTaskStart,
  tryParseWebSeedLocation,
} from "./surface-target-seed.js";
import {
  resetSurfacePlatformSyncTracking,
  waitSurfacePlatformSyncs,
} from "./surface-platform-sync.js";

// --- pure: tryParseWebSeedLocation ---
{
  const a = tryParseWebSeedLocation("https://Host.Example:8443/app/login");
  assert.ok(a);
  assert.equal(a!.origin_key, "https://host.example:8443");
  assert.equal(a!.path_key, "/");
  assert.equal(a!.location, "https://host.example:8443/");
}

{
  const b = tryParseWebSeedLocation("http://dvwa");
  assert.ok(b);
  assert.equal(b!.origin_key, "http://dvwa:80");
  assert.equal(b!.path_key, "/");
}

{
  // Bare host only with coerceBare
  assert.equal(tryParseWebSeedLocation("example.com"), null);
  const c = tryParseWebSeedLocation("example.com", { coerceBare: true });
  assert.ok(c);
  assert.equal(c!.origin_key, "http://example.com:80");
  assert.equal(c!.path_key, "/");
}

{
  // Non-HTTP / wildcards skipped
  assert.equal(tryParseWebSeedLocation("ssh://10.0.0.1:22"), null);
  assert.equal(tryParseWebSeedLocation("https://*.example.com"), null);
  assert.equal(tryParseWebSeedLocation(""), null);
  assert.equal(tryParseWebSeedLocation("not a host", { coerceBare: true }), null);
}

// --- pure: collect from scope.allow only (envelope target is not a product object) ---
{
  const locs = collectTargetSeedLocations({
    target: { type: "url", value: "https://app.example.com/login" },
    scope: {
      allow: [
        "https://app.example.com",
        "https://api.example.com:8443/v1",
        "ssh://db.example.com:22",
        "*.evil.com",
        "bare-host.example",
      ],
    },
  });
  const origins = locs.map((l) => l.origin_key).sort();
  // api + app from scope; target-only origin is not seeded; bare-host not coerced for scope
  assert.deepEqual(origins, [
    "https://api.example.com:8443",
    "https://app.example.com:443",
  ]);
  for (const l of locs) {
    assert.equal(l.path_key, "/");
    assert.ok(l.location.endsWith("/"));
  }
}

{
  // Envelope task.target alone does not seed
  const locs = collectTargetSeedLocations({
    target: { type: "url", value: "dvwa.local" },
  });
  assert.equal(locs.length, 0);
}

{
  // No web material → empty
  assert.deepEqual(collectTargetSeedLocations({}), []);
  assert.deepEqual(
    collectTargetSeedLocations({
      target: { type: "host", value: "redis://10.0.0.1" },
      scope: { allow: ["10.0.0.1"] },
    }),
    [],
  );
}

function fakePlatform(
  behavior?: (msg: PlatformMessage) => Promise<void> | void,
): PlatformSink & { messages: PlatformMessage[] } {
  const messages: PlatformMessage[] = [];
  return {
    messages,
    async send(message: PlatformMessage) {
      if (behavior) await behavior(message);
      messages.push(message);
    },
  };
}

function runtimeFor(
  taskDir: string,
  store: SurfaceSqliteStore,
  platform: PlatformSink,
  task: Partial<TaskEnvelope> & { taskId: string; conversationId: string },
  opts?: { platformApi?: boolean },
): ToolRuntime {
  return {
    task: {
      instruction: "test",
      target: {},
      scope: {},
      ...task,
    } as TaskEnvelope,
    workspaceDir: taskDir,
    piDir: taskDir,
    platform,
    platformApi:
      opts?.platformApi === false
        ? undefined
        : { baseUrl: "http://platform.test", nodeToken: "tok" },
    todo: {} as ToolRuntime["todo"],
    evidence: {} as ToolRuntime["evidence"],
    findingsDir: join(taskDir, "findings"),
    goals: {} as ToolRuntime["goals"],
    surfaceSqlite: store,
    lifecycle: { subagentDepth: 0 },
  };
}

// --- seed without prior traffic (offline) ---
{
  const dir = await mkdtemp(join(tmpdir(), "node4-s381-offline-"));
  const store = new SurfaceSqliteStore(SurfaceSqliteStore.pathFromTaskDir(dir));
  await store.open();
  assert.equal(await store.count(), 0, "empty ledger before seed");

  const platform = fakePlatform();
  const rt = runtimeFor(
    dir,
    store,
    platform,
    {
      taskId: "t-381",
      conversationId: "conv-381",
      target: { type: "url", value: "https://juice.local:3000/rest" },
      scope: { allow: ["https://juice.local:3000/rest", "https://api.juice.local"] },
    },
    { platformApi: false },
  );

  const result = await seedSurfacesFromTargetAtTaskStart(rt);
  assert.equal(result.seeded, 2);
  assert.equal(result.created, 2);
  assert.equal(result.updated, 0);
  assert.equal(result.platform_sync, "offline");
  assert.equal(await store.count(), 2);

  const all = await store.all();
  for (const row of all) {
    assert.equal(row.status, "seen");
    assert.equal(row.source, "target_seed");
    assert.equal(row.path_key, "/");
    assert.equal(row.platform_sync, "offline");
    assert.equal(row.kind, "url");
  }
  const origins = all.map((r) => r.origin_key).sort();
  assert.deepEqual(origins, [
    "https://api.juice.local:443",
    "https://juice.local:3000",
  ]);

  // No Platform messages when offline
  assert.equal(platform.messages.length, 0);

  // Idempotent re-seed does not downgrade or duplicate
  const again = await seedSurfacesFromTargetAtTaskStart(rt);
  assert.equal(await store.count(), 2);
  assert.equal(again.created, 0);
  assert.equal(again.updated, 2);
  for (const row of await store.all()) {
    assert.equal(row.status, "seen");
    assert.equal(row.source, "target_seed");
  }

  store.close();
  await rm(dir, { recursive: true, force: true });
}

// --- online dual-write mock ---
{
  resetSurfacePlatformSyncTracking();
  const dir = await mkdtemp(join(tmpdir(), "node4-s381-online-"));
  const store = new SurfaceSqliteStore(SurfaceSqliteStore.pathFromTaskDir(dir));
  await store.open();
  const platform = fakePlatform();
  const rt = runtimeFor(
    dir,
    store,
    platform,
    {
      taskId: "t-381-on",
      conversationId: "conv-381-on",
      target: { type: "url", value: "http://dvwa:80/" },
      scope: { allow: ["http://dvwa:80/"] },
    },
    { platformApi: true },
  );

  const result = await seedSurfacesFromTargetAtTaskStart(rt);
  assert.equal(result.seeded, 1);
  assert.equal(result.created, 1);
  assert.equal(result.platform_sync, "pending");
  // Row may already be ok if dual-write finished before the next await (race-safe).
  const mid = await store.all();
  assert.ok(mid[0]!.platform_sync === "pending" || mid[0]!.platform_sync === "ok");
  assert.equal(mid[0]!.status, "seen");
  assert.equal(mid[0]!.source, "target_seed");

  await waitSurfacePlatformSyncs();
  const after = await store.all();
  assert.equal(after[0]!.platform_sync, "ok");
  const upserts = platform.messages.filter((m) => m.type === "surface_upsert");
  assert.equal(upserts.length, 1);
  const surfaces = (upserts[0] as { surfaces?: Array<Record<string, unknown>> }).surfaces;
  assert.ok(Array.isArray(surfaces) && surfaces.length === 1);
  assert.equal(surfaces![0]!.status, "seen");
  assert.equal(surfaces![0]!.source, "target_seed");
  assert.equal(surfaces![0]!.path_key, "/");
  assert.equal(surfaces![0]!.origin_key, "http://dvwa:80");

  store.close();
  await rm(dir, { recursive: true, force: true });
  resetSurfacePlatformSyncTracking();
}

// --- empty target/scope: no rows ---
{
  const dir = await mkdtemp(join(tmpdir(), "node4-s381-empty-"));
  const store = new SurfaceSqliteStore(SurfaceSqliteStore.pathFromTaskDir(dir));
  await store.open();
  const rt = runtimeFor(
    dir,
    store,
    fakePlatform(),
    { taskId: "t-empty", conversationId: "c-empty", target: {}, scope: {} },
    { platformApi: false },
  );
  const result = await seedSurfacesFromTargetAtTaskStart(rt);
  assert.equal(result.seeded, 0);
  assert.equal(await store.count(), 0);
  store.close();
  await rm(dir, { recursive: true, force: true });
}

console.log("surface-target-seed.test.ts: ok");
