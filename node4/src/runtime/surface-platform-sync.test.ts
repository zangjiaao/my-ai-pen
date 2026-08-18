/**
 * Seam S3: online dual-write (Spec #368 / issue #374).
 * Local SQLite ok does not wait on Platform; platform_sync pending → ok|error + retry.
 * Run: npx tsx src/runtime/surface-platform-sync.test.ts  (from node4/)
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SurfaceSqliteStore } from "../stores/surface-sqlite.js";
import type { PlatformMessage, PlatformSink, TaskEnvelope, ToolRuntime } from "../types.js";
import { createSurfaceTool } from "../tools/surface.js";
import {
  buildSurfaceUpsertMessage,
  enqueueSurfacePlatformSync,
  isSurfacePlatformOnline,
  resetSurfacePlatformSyncTracking,
  runSurfacePlatformSync,
  surfaceRowToPlatformPayload,
  waitSurfacePlatformSyncs,
} from "./surface-platform-sync.js";

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
  opts?: { platformApi?: boolean; conversationId?: string },
): ToolRuntime {
  const task = {
    taskId: "t-374",
    conversationId: opts?.conversationId ?? "conv-374",
    instruction: "test",
  } as TaskEnvelope;
  return {
    task,
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

async function toolJson(tool: ReturnType<typeof createSurfaceTool>, params: Record<string, unknown>) {
  const out = await tool.execute("call-1", params);
  const text =
    out.content?.[0] && "text" in out.content[0] ? String((out.content[0] as { text: string }).text) : "";
  if (text.startsWith("error:")) return { error: text, raw: out };
  return { data: JSON.parse(text) as Record<string, unknown>, raw: out };
}

// --- pure: online detection ---
{
  const dir = await mkdtemp(join(tmpdir(), "node4-s374-online-"));
  const store = new SurfaceSqliteStore(SurfaceSqliteStore.pathFromTaskDir(dir));
  await store.open();
  const onlineRt = runtimeFor(dir, store, fakePlatform(), { platformApi: true });
  assert.equal(isSurfacePlatformOnline(onlineRt), true);
  const offlineRt = runtimeFor(dir, store, fakePlatform(), { platformApi: false });
  assert.equal(isSurfacePlatformOnline(offlineRt), false);
  const noConv = runtimeFor(dir, store, fakePlatform(), {
    platformApi: true,
    conversationId: "  ",
  });
  // blank conversationId after trim → offline
  noConv.task.conversationId = "   ";
  assert.equal(isSurfacePlatformOnline(noConv), false);
  store.close();
  await rm(dir, { recursive: true, force: true });
}

// --- pure: message shape matches Platform extract_surfaces_from_upsert_message ---
{
  const row = {
    id: "https://ex:443|/a",
    origin_key: "https://ex:443",
    path_key: "/a",
    location: "https://ex/a",
    methods: ["GET"],
    params: ["id"],
    status: "open" as const,
    source: "agent",
    source_agent_id: "main",
    platform_sync: "pending" as const,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
  const payload = surfaceRowToPlatformPayload(row);
  assert.equal(payload.platform_sync, undefined, "platform_sync is Node-side only");
  assert.equal(payload.origin_key, "https://ex:443");
  assert.equal(payload.path_key, "/a");
  const msg = buildSurfaceUpsertMessage({
    conversationId: "conv-a",
    taskId: "t1",
    surfaces: [row],
  });
  assert.equal(msg.type, "surface_upsert");
  assert.equal(msg.conversation_id, "conv-a");
  assert.equal(msg.task_id, "t1");
  assert.ok(Array.isArray(msg.surfaces));
  assert.equal((msg.surfaces as unknown[]).length, 1);
}

// --- offline: no platform publish ---
{
  resetSurfacePlatformSyncTracking();
  const dir = await mkdtemp(join(tmpdir(), "node4-s374-off-"));
  const store = new SurfaceSqliteStore(SurfaceSqliteStore.pathFromTaskDir(dir));
  await store.open();
  const platform = fakePlatform();
  const rt = runtimeFor(dir, store, platform, { platformApi: false });
  const tool = createSurfaceTool(rt);
  const r = await toolJson(tool, {
    op: "upsert",
    location: "https://offline.example/login",
  });
  assert.ok(r.data, r.error);
  assert.equal(r.data!.ok, true);
  assert.equal(r.data!.platform_sync, "offline");
  await waitSurfacePlatformSyncs();
  assert.equal(platform.messages.length, 0, "offline must not publish surface_upsert");
  const row = await store.get({ location: "https://offline.example/login" });
  assert.ok(row);
  assert.equal(row!.platform_sync, "offline");
  store.close();
  await rm(dir, { recursive: true, force: true });
}

// --- online success: pending → ok; Case identities in WS frame ---
{
  resetSurfacePlatformSyncTracking();
  const dir = await mkdtemp(join(tmpdir(), "node4-s374-ok-"));
  const store = new SurfaceSqliteStore(SurfaceSqliteStore.pathFromTaskDir(dir));
  await store.open();
  const platform = fakePlatform();
  const rt = runtimeFor(dir, store, platform, { platformApi: true });
  const tool = createSurfaceTool(rt);
  const r = await toolJson(tool, {
    op: "upsert",
    location: "https://Host.Example:443/api/Users?x=1",
    methods: ["GET"],
    params: ["id"],
  });
  assert.ok(r.data, r.error);
  assert.equal(r.data!.ok, true);
  // Tool response reflects local commit state (pending); async may already have settled to ok.
  assert.equal(r.data!.platform_sync, "pending");
  const mid = await store.get({ location: "https://host.example/api/users" });
  assert.ok(mid);
  assert.ok(
    mid!.platform_sync === "pending" || mid!.platform_sync === "ok",
    `expected pending|ok after local commit, got ${mid!.platform_sync}`,
  );

  await waitSurfacePlatformSyncs();
  assert.equal(platform.messages.length, 1);
  const msg = platform.messages[0]!;
  assert.equal(msg.type, "surface_upsert");
  assert.equal(msg.conversation_id, "conv-374");
  const surfaces = msg.surfaces as Array<Record<string, unknown>>;
  assert.equal(surfaces.length, 1);
  assert.equal(surfaces[0]!.origin_key, "https://host.example:443");
  assert.equal(surfaces[0]!.path_key, "/api/users");
  assert.deepEqual(surfaces[0]!.methods, ["GET"]);
  assert.deepEqual(surfaces[0]!.params, ["id"]);
  assert.equal(surfaces[0]!.platform_sync, undefined);

  const done = await store.get({ location: "https://host.example/api/users" });
  assert.ok(done);
  assert.equal(done!.platform_sync, "ok");
  store.close();
  await rm(dir, { recursive: true, force: true });
}

// --- slow Platform: tool ok before send completes ---
{
  resetSurfacePlatformSyncTracking();
  const dir = await mkdtemp(join(tmpdir(), "node4-s374-slow-"));
  const store = new SurfaceSqliteStore(SurfaceSqliteStore.pathFromTaskDir(dir));
  await store.open();
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const platform = fakePlatform(async () => {
    await gate;
  });
  const rt = runtimeFor(dir, store, platform, { platformApi: true });
  const tool = createSurfaceTool(rt);

  const started = Date.now();
  const r = await toolJson(tool, {
    op: "upsert",
    location: "https://slow.example/path",
  });
  const elapsed = Date.now() - started;
  assert.ok(r.data, r.error);
  assert.equal(r.data!.ok, true);
  assert.equal(r.data!.platform_sync, "pending");
  assert.ok(elapsed < 200, `tool must not wait on slow Platform (elapsed=${elapsed}ms)`);
  assert.equal(platform.messages.length, 0, "send still gated");

  release();
  await waitSurfacePlatformSyncs();
  assert.equal(platform.messages.length, 1);
  const row = await store.get({ location: "https://slow.example/path" });
  assert.equal(row!.platform_sync, "ok");
  store.close();
  await rm(dir, { recursive: true, force: true });
}

// --- fail then retry recovery: pending → error → ok ---
{
  resetSurfacePlatformSyncTracking();
  const dir = await mkdtemp(join(tmpdir(), "node4-s374-retry-"));
  const store = new SurfaceSqliteStore(SurfaceSqliteStore.pathFromTaskDir(dir));
  await store.open();
  let attempts = 0;
  const platform = fakePlatform(async () => {
    attempts += 1;
    if (attempts < 3) throw new Error(`transient-${attempts}`);
  });
  const rt = runtimeFor(dir, store, platform, { platformApi: true });
  const res = await store.upsert(
    [{ location: "https://retry.example/x", methods: ["POST"] }],
    { source_agent_id: "main", platformOnline: true },
  );
  assert.equal(res.ok, true);
  if (!res.ok) throw new Error("upsert failed");
  assert.equal(res.platform_sync, "pending");

  const syncStates: string[] = [];
  // Run with tiny backoff; observe final ok and 3 attempts
  await runSurfacePlatformSync(rt, res.upserted, {
    maxAttempts: 3,
    baseDelayMs: 5,
    sleep: async () => {
      const row = await store.get({ location: "https://retry.example/x" });
      if (row) syncStates.push(row.platform_sync);
    },
  });
  assert.equal(attempts, 3);
  const final = await store.get({ location: "https://retry.example/x" });
  assert.equal(final!.platform_sync, "ok");
  // At least one error observed mid-retry (before sleep after failed attempt)
  assert.ok(syncStates.includes("error") || platform.messages.length === 1);
  assert.equal(platform.messages.length, 1);
  store.close();
  await rm(dir, { recursive: true, force: true });
}

// --- permanent failure ends as error ---
{
  resetSurfacePlatformSyncTracking();
  const dir = await mkdtemp(join(tmpdir(), "node4-s374-err-"));
  const store = new SurfaceSqliteStore(SurfaceSqliteStore.pathFromTaskDir(dir));
  await store.open();
  const platform = fakePlatform(async () => {
    throw new Error("platform down");
  });
  const rt = runtimeFor(dir, store, platform, { platformApi: true });
  const res = await store.upsert([{ location: "https://err.example/y" }], {
    source_agent_id: "main",
    platformOnline: true,
  });
  assert.equal(res.ok, true);
  if (!res.ok) throw new Error("upsert failed");
  await runSurfacePlatformSync(rt, res.upserted, {
    maxAttempts: 2,
    baseDelayMs: 1,
    sleep: async () => {},
  });
  const row = await store.get({ location: "https://err.example/y" });
  assert.equal(row!.platform_sync, "error");
  assert.equal(platform.messages.length, 0);
  store.close();
  await rm(dir, { recursive: true, force: true });
}

// --- deposit helper online enqueues (via wait) ---
{
  resetSurfacePlatformSyncTracking();
  const dir = await mkdtemp(join(tmpdir(), "node4-s374-dep-"));
  const store = new SurfaceSqliteStore(SurfaceSqliteStore.pathFromTaskDir(dir));
  await store.open();
  const platform = fakePlatform();
  const rt = runtimeFor(dir, store, platform, { platformApi: true });
  const { depositSurfaceLocation } = await import("../tools/surface.js");
  const dep = await depositSurfaceLocation(rt, {
    location: "redis://10.0.0.9:6379",
    note: "redis",
  });
  assert.ok(dep.ok);
  assert.equal((dep as { platform_sync: string }).platform_sync, "pending");
  await waitSurfacePlatformSyncs();
  assert.equal(platform.messages.length, 1);
  assert.equal(platform.messages[0]!.type, "surface_upsert");
  const row = await store.get({ location: "redis://10.0.0.9:6379" });
  assert.equal(row!.platform_sync, "ok");
  assert.equal(row!.origin_key, "redis://10.0.0.9:6379");
  store.close();
  await rm(dir, { recursive: true, force: true });
}

// --- enqueue no-op when offline ---
{
  resetSurfacePlatformSyncTracking();
  const dir = await mkdtemp(join(tmpdir(), "node4-s374-enq-"));
  const store = new SurfaceSqliteStore(SurfaceSqliteStore.pathFromTaskDir(dir));
  await store.open();
  const platform = fakePlatform();
  const rt = runtimeFor(dir, store, platform, { platformApi: false });
  const res = await store.upsert([{ location: "https://x.test/z" }], {
    platformOnline: false,
  });
  assert.equal(res.ok, true);
  if (!res.ok) throw new Error("upsert failed");
  await enqueueSurfacePlatformSync(rt, res.upserted);
  await waitSurfacePlatformSyncs();
  assert.equal(platform.messages.length, 0);
  store.close();
  await rm(dir, { recursive: true, force: true });
}

console.log("surface-platform-sync.test.ts: ok");
