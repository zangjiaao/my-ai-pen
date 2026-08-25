/**
 * Seam S2: Traffic complete → Surface settle (Spec #368 / #380 / #412).
 * Pure plan + integration with fake SQLite store / dual-write.
 * Run: npx tsx src/runtime/surface-settle.test.ts  (from node4/)
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SurfaceSqliteStore } from "../stores/surface-sqlite.js";
import type { PlatformMessage, PlatformSink, TaskEnvelope, ToolRuntime } from "../types.js";
import {
  emitHttpComplete,
  emitHttpPending,
  type TrafficExchange,
} from "./traffic-collect.js";
import {
  extractUrlParamNames,
  hasGarbageToolPath,
  isCollapsedOsProbePath,
  isHttpHttpsScheme,
  isOriginInEngagementScope,
  isStaticSurfacePath,
  isTrafficSettlePhase,
  planTrafficSurfaceSettle,
  settleTrafficToSurface,
  STATIC_PATH_SUFFIX_DENYLIST,
  trafficSettleScopeFromTask,
} from "./surface-settle.js";
import {
  resetSurfacePlatformSyncTracking,
  waitSurfacePlatformSyncs,
} from "./surface-platform-sync.js";

// ---------------------------------------------------------------------------
// Pure: denylist / phase / scheme
// ---------------------------------------------------------------------------

{
  assert.equal(isStaticSurfacePath("/assets/app.js"), true);
  assert.equal(isStaticSurfacePath("/static/main.CSS"), true);
  assert.equal(isStaticSurfacePath("/bundle.js.map"), true);
  assert.equal(isStaticSurfacePath("/img/logo.PNG"), true);
  assert.equal(isStaticSurfacePath("/fonts/roboto.woff2"), true);
  assert.equal(isStaticSurfacePath("/api/users"), false);
  assert.equal(isStaticSurfacePath("/"), false);
  assert.equal(isStaticSurfacePath("/index.html"), false);
  assert.equal(isStaticSurfacePath("/api/download.js/meta"), false);
  assert.ok(STATIC_PATH_SUFFIX_DENYLIST.includes(".js"));
}

{
  assert.equal(isHttpHttpsScheme("http"), true);
  assert.equal(isHttpHttpsScheme("HTTPS"), true);
  assert.equal(isHttpHttpsScheme("ssh"), false);
  assert.equal(isHttpHttpsScheme("wss"), false);
}

{
  assert.equal(isTrafficSettlePhase("completed"), true);
  assert.equal(isTrafficSettlePhase("failed"), true);
  assert.equal(isTrafficSettlePhase("pending"), false);
  assert.equal(isTrafficSettlePhase(null), false);
}

{
  assert.deepEqual(extractUrlParamNames("https://h/x?id=1&name=a&id=2"), ["id", "name"]);
  assert.deepEqual(extractUrlParamNames("https://h/x"), []);
}

// ---------------------------------------------------------------------------
// Pure: planTrafficSurfaceSettle
// ---------------------------------------------------------------------------

{
  const pending = planTrafficSurfaceSettle(
    { url: "https://example.com/api", method: "GET", phase: "pending" },
    null,
  );
  assert.equal(pending.settle, false);
  if (!pending.settle) assert.equal(pending.reason, "phase_not_terminal");
}

{
  const skip = planTrafficSurfaceSettle(
    { url: "https://example.com/static/app.js", method: "GET", phase: "completed" },
    null,
  );
  assert.equal(skip.settle, false);
  if (!skip.settle) assert.equal(skip.reason, "static_denylist");
}

{
  const skip = planTrafficSurfaceSettle(
    { url: "ssh://10.0.0.1:22", method: "GET", phase: "completed" },
    null,
  );
  assert.equal(skip.settle, false);
  if (!skip.settle) assert.equal(skip.reason, "non_http_scheme");
}

{
  const first = planTrafficSurfaceSettle(
    {
      url: "https://Example.com/api/Users?id=1&x=2",
      method: "get",
      phase: "completed",
    },
    null,
  );
  assert.equal(first.settle, true);
  if (!first.settle) throw new Error("expected settle");
  assert.equal(first.origin_key, "https://example.com:443");
  assert.equal(first.path_key, "/api/users");
  assert.equal(first.status, "seen");
  assert.deepEqual(first.methods, ["GET"]);
  assert.deepEqual(first.params, ["id", "x"]);
  assert.equal(first.source, "traffic");
  assert.ok(first.location.includes("/api/users"));
}

{
  const second = planTrafficSurfaceSettle(
    {
      url: "https://example.com/api/users",
      method: "POST",
      phase: "completed",
    },
    { status: "seen", methods: ["GET"] },
  );
  assert.equal(second.settle, true);
  if (!second.settle) throw new Error("expected settle");
  assert.equal(second.status, "touched");
  assert.deepEqual(second.methods, ["GET", "POST"]);
}

{
  // 401/403/500 still settle (status_code not used to filter)
  const forbidden = planTrafficSurfaceSettle(
    { url: "https://example.com/admin", method: "GET", phase: "completed" },
    null,
  );
  assert.equal(forbidden.settle, true);
  if (!forbidden.settle) throw new Error("expected settle");
  assert.equal(forbidden.status, "seen");
}

{
  const failed = planTrafficSurfaceSettle(
    { url: "https://example.com/slow", method: "GET", phase: "failed" },
    null,
  );
  assert.equal(failed.settle, true);
}

// ---------------------------------------------------------------------------
// Pure: L2 noise filter — garbage path / scope / collapsed OS probe (#412)
// ---------------------------------------------------------------------------

{
  assert.equal(hasGarbageToolPath("/ftp/${pdf}"), true);
  assert.equal(hasGarbageToolPath("/ftp/{{file}}"), true);
  assert.equal(hasGarbageToolPath("/ftp/report.pdf"), false);
  assert.equal(hasGarbageToolPath("/api/users"), false);
}

{
  const skipDollar = planTrafficSurfaceSettle(
    { url: "https://target.example/ftp/${pdf}", method: "GET", phase: "completed" },
    null,
  );
  assert.equal(skipDollar.settle, false);
  if (!skipDollar.settle) assert.equal(skipDollar.reason, "garbage_path");

  const skipMustache = planTrafficSurfaceSettle(
    { url: "https://target.example/rest/{{id}}", method: "GET", phase: "completed" },
    null,
  );
  assert.equal(skipMustache.settle, false);
  if (!skipMustache.settle) assert.equal(skipMustache.reason, "garbage_path");
}

{
  // No scope context → origin gate off (backward compatible)
  const open = planTrafficSurfaceSettle(
    { url: "https://www.w3.org/TR/html", method: "GET", phase: "completed" },
    null,
  );
  assert.equal(open.settle, true);

  // Empty allowedHosts → gate off
  const emptyScope = planTrafficSurfaceSettle(
    { url: "https://www.w3.org/TR/html", method: "GET", phase: "completed" },
    null,
    { allowedHosts: new Set() },
  );
  assert.equal(emptyScope.settle, true);

  const scope = { allowedHosts: new Set(["target.example", "host.docker.internal"]) };

  const inScope = planTrafficSurfaceSettle(
    { url: "https://target.example/api/users", method: "GET", phase: "completed" },
    null,
    scope,
  );
  assert.equal(inScope.settle, true);
  if (!inScope.settle) throw new Error("expected in-scope settle");
  assert.equal(inScope.origin_key, "https://target.example:443");

  const oos = planTrafficSurfaceSettle(
    { url: "https://www.w3.org/TR/html", method: "GET", phase: "completed" },
    null,
    scope,
  );
  assert.equal(oos.settle, false);
  if (!oos.settle) assert.equal(oos.reason, "out_of_scope");

  const fakeHost = planTrafficSurfaceSettle(
    { url: "http://nonexistent-host:9999/", method: "GET", phase: "completed" },
    null,
    scope,
  );
  assert.equal(fakeHost.settle, false);
  if (!fakeHost.settle) assert.equal(fakeHost.reason, "out_of_scope");

  // Alias host listed in allow still settles
  const alias = planTrafficSurfaceSettle(
    { url: "http://host.docker.internal:3000/login", method: "GET", phase: "completed" },
    null,
    scope,
  );
  assert.equal(alias.settle, true);
}

{
  // trafficSettleScopeFromTask mirrors TARGET + scope.allow
  const ctx = trafficSettleScopeFromTask({
    target: { type: "url", value: "https://app.example.com/login" },
    scope: { allow: ["http://host.docker.internal:8080", "127.0.0.1"] },
  });
  assert.ok(ctx.allowedHosts instanceof Set);
  const hosts = ctx.allowedHosts as Set<string>;
  assert.ok(hosts.has("app.example.com"));
  assert.ok(hosts.has("host.docker.internal"));
  assert.ok(hosts.has("127.0.0.1"));
  assert.equal(isOriginInEngagementScope("app.example.com", ctx), true);
  assert.equal(isOriginInEngagementScope("www.w3.org", ctx), false);
}

{
  const scoped = trafficSettleScopeFromTask({
    target: { type: "url", value: "http://host.docker.internal:3000" },
    scope: { allow: ["http://host.docker.internal:3000"] },
  });
  const origins = scoped.allowedOrigins as Set<string>;
  assert.ok(origins.has("host.docker.internal:3000"), "explicit :3000 origin recorded");
  const onPort = planTrafficSurfaceSettle(
    { url: "http://host.docker.internal:3000/rest/user", method: "GET", phase: "completed" },
    null,
    scoped,
  );
  assert.equal(onPort.settle, true);
  const sibling = planTrafficSurfaceSettle(
    { url: "http://host.docker.internal:8080/", method: "GET", phase: "completed" },
    null,
    scoped,
  );
  assert.equal(sibling.settle, false);
  if (!sibling.settle) assert.equal(sibling.reason, "out_of_scope");
}

{
  // Collapsed OS probe: traversal in raw URL + normalized OS path → skip
  assert.equal(
    isCollapsedOsProbePath("/etc/passwd", "https://t.example/foo/../../../etc/passwd"),
    true,
  );
  assert.equal(
    isCollapsedOsProbePath("/windows/win.ini", "https://t.example/a/../../windows/win.ini"),
    true,
  );
  // No traversal in URL → real business path may settle even if name matches
  assert.equal(isCollapsedOsProbePath("/etc/passwd", "https://t.example/etc/passwd"), false);

  const probe = planTrafficSurfaceSettle(
    {
      url: "https://target.example/assets/../../../etc/passwd",
      method: "GET",
      phase: "completed",
    },
    null,
    { allowedHosts: new Set(["target.example"]) },
  );
  assert.equal(probe.settle, false);
  if (!probe.settle) assert.equal(probe.reason, "collapsed_os_probe");

  // Legitimate path without traversal still settles
  const legit = planTrafficSurfaceSettle(
    { url: "https://target.example/etc/passwd", method: "GET", phase: "completed" },
    null,
    { allowedHosts: new Set(["target.example"]) },
  );
  assert.equal(legit.settle, true);

  // Static denylist still wins / remains
  const staticStill = planTrafficSurfaceSettle(
    { url: "https://target.example/static/app.js", method: "GET", phase: "completed" },
    null,
    { allowedHosts: new Set(["target.example"]) },
  );
  assert.equal(staticStill.settle, false);
  if (!staticStill.settle) assert.equal(staticStill.reason, "static_denylist");
}

// ---------------------------------------------------------------------------
// Integration: fake store — first seen, second touched, denylist, dual-write
// ---------------------------------------------------------------------------

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
  store: SurfaceSqliteStore | undefined,
  platform: PlatformSink,
  opts?: {
    platformApi?: boolean;
    conversationId?: string;
    target?: Record<string, unknown>;
    scope?: Record<string, unknown>;
  },
): ToolRuntime {
  const task = {
    taskId: "t-380",
    conversationId: opts?.conversationId ?? "conv-380",
    instruction: "test",
    target: opts?.target ?? {},
    scope: opts?.scope ?? {},
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

function completedExchange(partial: Partial<TrafficExchange> & { url: string }): TrafficExchange {
  return {
    type: "traffic_exchange",
    exchange_id: partial.exchange_id || `tx_test_${Math.random().toString(36).slice(2, 10)}`,
    conversation_id: partial.conversation_id || "conv-380",
    task_id: partial.task_id || "t-380",
    sequence: partial.sequence ?? 1,
    source: partial.source || "http",
    phase: partial.phase || "completed",
    method: partial.method || "GET",
    url: partial.url,
    status_code: partial.status_code ?? 200,
    started_at: partial.started_at || new Date().toISOString(),
    completed_at: partial.completed_at || new Date().toISOString(),
    purpose: partial.purpose,
    browser_resource_class: partial.browser_resource_class,
  };
}

{
  const dir = await mkdtemp(join(tmpdir(), "node4-s380-store-"));
  const store = new SurfaceSqliteStore(SurfaceSqliteStore.pathFromTaskDir(dir));
  await store.open();
  const platform = fakePlatform();
  const rt = runtimeFor(dir, store, platform, { platformApi: true });
  resetSurfacePlatformSyncTracking();

  const first = await settleTrafficToSurface(
    rt,
    completedExchange({
      url: "https://target.example/vuln/sqli?id=1",
      method: "GET",
      status_code: 200,
    }),
  );
  assert.equal(first.ok, true);
  if (!first.ok || first.skipped) throw new Error(`expected apply: ${JSON.stringify(first)}`);
  assert.equal(first.created, 1);
  assert.equal(first.updated, 0);
  // Spec #518: purpose=test still elevates touched; does not write coverage.
  assert.equal(first.row?.status, "touched");
  assert.equal(first.row?.coverage, "untested");
  assert.equal(first.row?.origin_key, "https://target.example:443");
  assert.equal(first.row?.path_key, "/vuln/sqli");
  assert.equal(first.row?.source, "traffic");
  assert.deepEqual(first.row?.methods, ["GET"]);
  assert.ok(first.row?.params?.includes("id"));

  const second = await settleTrafficToSurface(
    rt,
    completedExchange({
      url: "https://target.example/vuln/sqli",
      method: "POST",
      status_code: 403,
    }),
  );
  assert.equal(second.ok, true);
  if (!second.ok || second.skipped) throw new Error(`expected apply: ${JSON.stringify(second)}`);
  assert.equal(second.created, 0);
  assert.equal(second.updated, 1);
  assert.equal(second.row?.status, "touched");
  assert.equal(second.row?.coverage, "untested");
  assert.deepEqual(second.row?.methods, ["GET", "POST"]);

  // Third hit stays touched (no downgrade)
  const third = await settleTrafficToSurface(
    rt,
    completedExchange({
      url: "https://target.example/vuln/sqli",
      method: "GET",
      status_code: 500,
    }),
  );
  assert.equal(third.ok, true);
  if (!third.ok || third.skipped) throw new Error("expected third apply");
  assert.equal(third.row?.status, "touched");

  // Static asset never becomes a row
  const staticHit = await settleTrafficToSurface(
    rt,
    completedExchange({
      url: "https://target.example/static/app.js",
      method: "GET",
    }),
  );
  assert.equal(staticHit.ok, true);
  if (!staticHit.ok) throw new Error("expected skip ok");
  assert.equal(staticHit.skipped, true);
  if (staticHit.skipped) assert.equal(staticHit.reason, "static_denylist");
  const jsRow = await store.get({ location: "https://target.example/static/app.js" });
  assert.equal(jsRow, null);

  // Dual-write enqueued
  await waitSurfacePlatformSyncs();
  assert.ok(platform.messages.length >= 1);
  const last = platform.messages[platform.messages.length - 1]!;
  assert.equal(last.type, "surface_upsert");
  const surfaces = (last as { surfaces?: unknown[] }).surfaces;
  assert.ok(Array.isArray(surfaces) && surfaces.length >= 1);

  store.close();
  await rm(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Integration: emitHttpComplete path settles into store
// ---------------------------------------------------------------------------

{
  const dir = await mkdtemp(join(tmpdir(), "node4-s380-http-"));
  const store = new SurfaceSqliteStore(SurfaceSqliteStore.pathFromTaskDir(dir));
  await store.open();
  const platform = fakePlatform();
  const rt = runtimeFor(dir, store, platform, { platformApi: false });

  const pending = await emitHttpPending(rt, {
    method: "GET",
    url: "http://127.0.0.1:8080/login",
  });
  // Pending must not create surface
  assert.equal(await store.count(), 0);

  await emitHttpComplete(rt, pending, {
    statusCode: 401,
    responseBody: "auth required",
  });
  assert.equal(await store.count(), 1);
  const row = await store.get({ location: "http://127.0.0.1:8080/login" });
  assert.ok(row);
  // Spec #518: http GET purpose=test → touched; coverage stays untested until mark.
  assert.equal(row?.status, "touched");
  assert.equal(row?.coverage, "untested");
  assert.equal(row?.source, "traffic");
  assert.deepEqual(row?.methods, ["GET"]);

  // Second complete on same path via new exchange → still tested; methods merge
  const pending2 = await emitHttpPending(rt, {
    method: "POST",
    url: "http://127.0.0.1:8080/login",
  });
  await emitHttpComplete(rt, pending2, { statusCode: 200, responseBody: "ok" });
  const row2 = await store.get({ location: "http://127.0.0.1:8080/login" });
  assert.equal(row2?.status, "touched");
  assert.equal(row2?.coverage, "untested");
  assert.deepEqual(row2?.methods, ["GET", "POST"]);

  store.close();
  await rm(dir, { recursive: true, force: true });
}

// No store → soft skip
{
  const dir = await mkdtemp(join(tmpdir(), "node4-s380-nostore-"));
  const platform = fakePlatform();
  const rt = runtimeFor(dir, undefined, platform, { platformApi: false });
  const r = await settleTrafficToSurface(
    rt,
    completedExchange({ url: "https://example.com/", method: "GET" }),
  );
  assert.equal(r.ok, true);
  if (!r.ok) throw new Error("expected ok");
  assert.equal(r.skipped, true);
  if (r.skipped) assert.equal(r.reason, "no_surface_store");
  await rm(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Integration: scope gate + garbage path via settleTrafficToSurface (#412)
// ---------------------------------------------------------------------------

{
  const dir = await mkdtemp(join(tmpdir(), "node4-s412-scope-"));
  const store = new SurfaceSqliteStore(SurfaceSqliteStore.pathFromTaskDir(dir));
  await store.open();
  const platform = fakePlatform();
  const rt = runtimeFor(dir, store, platform, {
    platformApi: false,
    target: { type: "url", value: "https://target.example/" },
    scope: { allow: ["https://target.example"] },
  });

  // In-scope TARGET traffic still settles
  const ok = await settleTrafficToSurface(
    rt,
    completedExchange({ url: "https://target.example/vuln/sqli?id=1", method: "GET" }),
  );
  assert.equal(ok.ok, true);
  if (!ok.ok || ok.skipped) throw new Error(`expected apply: ${JSON.stringify(ok)}`);
  assert.equal(ok.row?.path_key, "/vuln/sqli");

  // Out-of-scope origin does not create a Surface row (Traffic would still record)
  const oos = await settleTrafficToSurface(
    rt,
    completedExchange({ url: "https://www.w3.org/TR/html", method: "GET" }),
  );
  assert.equal(oos.ok, true);
  if (!oos.ok) throw new Error("expected skip ok");
  assert.equal(oos.skipped, true);
  if (oos.skipped) assert.equal(oos.reason, "out_of_scope");
  assert.equal(await store.get({ location: "https://www.w3.org/TR/html" }), null);

  // Garbage path does not settle
  const garbage = await settleTrafficToSurface(
    rt,
    completedExchange({ url: "https://target.example/ftp/${pdf}", method: "GET" }),
  );
  assert.equal(garbage.ok, true);
  if (!garbage.ok) throw new Error("expected skip ok");
  assert.equal(garbage.skipped, true);
  if (garbage.skipped) assert.equal(garbage.reason, "garbage_path");
  assert.equal(await store.count(), 1); // only the in-scope sqli row

  // Collapsed OS probe does not settle
  const probe = await settleTrafficToSurface(
    rt,
    completedExchange({
      url: "https://target.example/x/../../../etc/passwd",
      method: "GET",
    }),
  );
  assert.equal(probe.ok, true);
  if (!probe.ok) throw new Error("expected skip ok");
  assert.equal(probe.skipped, true);
  if (probe.skipped) assert.equal(probe.reason, "collapsed_os_probe");

  store.close();
  await rm(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Pure + integration: purpose + case_tested (#413)
// ---------------------------------------------------------------------------

{
  // shell/http single GET purpose=test → case_tested plan
  const plan = planTrafficSurfaceSettle(
    {
      url: "https://lab.example/api",
      method: "GET",
      phase: "completed",
      source: "shell",
    },
    null,
  );
  assert.equal(plan.settle, true);
  if (!plan.settle) throw new Error("expected settle");
  assert.equal(plan.purpose, "test");
  assert.equal(plan.case_tested, true);
  assert.equal(plan.status, "touched", "single test request → touched");
}

{
  // browser browse does not set case_tested
  const browse = planTrafficSurfaceSettle(
    {
      url: "https://lab.example/",
      method: "GET",
      phase: "completed",
      source: "browser",
      purpose: "browse",
    },
    null,
  );
  assert.equal(browse.settle, true);
  if (!browse.settle) throw new Error("expected settle");
  assert.equal(browse.purpose, "browse");
  assert.equal(browse.case_tested, false);
  assert.equal(browse.status, "seen");

  // Multi-hit browse elevates Graph status but not case_tested
  const browse2 = planTrafficSurfaceSettle(
    {
      url: "https://lab.example/",
      method: "GET",
      phase: "completed",
      source: "browser",
      purpose: "browse",
    },
    { status: "seen", methods: ["GET"] },
  );
  assert.equal(browse2.settle, true);
  if (!browse2.settle) throw new Error("expected settle");
  assert.equal(browse2.case_tested, false);
  assert.equal(browse2.status, "touched");
}

{
  // Explicit purpose override
  const forced = planTrafficSurfaceSettle(
    {
      url: "https://lab.example/x",
      method: "GET",
      phase: "completed",
      source: "browser",
      purpose: "test",
    },
    null,
  );
  assert.equal(forced.settle, true);
  if (!forced.settle) throw new Error("expected settle");
  assert.equal(forced.case_tested, true);
}

{
  const dir = await mkdtemp(join(tmpdir(), "node4-s413-purpose-"));
  const store = new SurfaceSqliteStore(SurfaceSqliteStore.pathFromTaskDir(dir));
  await store.open();
  const platform = fakePlatform();
  const rt = runtimeFor(dir, store, platform, { platformApi: true });
  resetSurfacePlatformSyncTracking();

  // Browse-only traffic: settle without case_tested
  const browse = await settleTrafficToSurface(
    rt,
    completedExchange({
      url: "https://lab.example/home",
      method: "GET",
      source: "browser",
      purpose: "browse",
    }),
  );
  assert.equal(browse.ok, true);
  if (!browse.ok || browse.skipped) throw new Error(JSON.stringify(browse));
  assert.equal(browse.row?.coverage, "untested");
  assert.equal(browse.row?.status, "seen");

  // Agent upsert cannot write coverage
  const fake = await store.upsert(
    [{ location: "https://lab.example/home", status: "touched", case_tested: true }],
    { source: "agent" },
  );
  assert.equal(fake.ok, true);
  if (!fake.ok) throw new Error("upsert");
  assert.equal(fake.upserted[0]?.coverage, "untested", "agent cannot set coverage");
  assert.equal(fake.upserted[0]?.status, "seen", "agent cannot elevate touched without traffic allow");

  // One shell test → touched; coverage still untested
  const testHit = await settleTrafficToSurface(
    rt,
    completedExchange({
      url: "https://lab.example/home",
      method: "GET",
      source: "shell",
      purpose: "test",
    }),
  );
  assert.equal(testHit.ok, true);
  if (!testHit.ok || testHit.skipped) throw new Error(JSON.stringify(testHit));
  assert.equal(testHit.row?.coverage, "untested");
  assert.equal(testHit.row?.status, "touched");

  // Dual-write includes coverage work-state (not purpose-derived TESTED)
  await waitSurfacePlatformSyncs();
  const upserts = platform.messages.filter((m) => m.type === "surface_upsert");
  assert.ok(upserts.length >= 1);
  const lastSurfaces = (upserts[upserts.length - 1] as { surfaces?: Array<Record<string, unknown>> })
    .surfaces;
  assert.ok(Array.isArray(lastSurfaces) && lastSurfaces.length >= 1);
  const payload = lastSurfaces.find((s) => String(s.path_key || "") === "/home") || lastSurfaces[0];
  assert.equal(payload?.coverage, "untested", "dual-write coverage");

  store.close();
  await rm(dir, { recursive: true, force: true });
}

console.log("surface-settle.test.ts: ok");
