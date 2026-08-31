/**
 * Spec #547 — Default inventory multi-op clerk (Wave 3 of #543).
 * Catalog names + list/create Hosts/Groups. No token counts, no prompt snapshots.
 * Run: npx tsx src/tools/inventory.test.ts
 */
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPackFromDirSync } from "../experts/load-pack.js";
import { DEFAULT_SEAT_PACK } from "../roles/default.js";
import { ALL_NODE4_TOOL_FACTORIES, toolNamesForPack } from "./index.js";
import { createInventoryTool } from "./inventory.js";
import { isHostCreateAttempt } from "./platform.js";
import type { ToolRuntime } from "../types.js";

const COLLAPSED = [
  "platform_list_assets",
  "platform_get_asset",
  "platform_create_asset",
  "platform_enrich_asset",
  "platform_batch_enrich_assets",
  "platform_list_groups",
  "platform_create_group",
  "platform_assemble_group",
] as const;

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const pentest = loadPackFromDirSync(join(repoRoot, "experts/pentest"));
const ctf = loadPackFromDirSync(join(repoRoot, "experts/ctf"));

assert.equal(typeof ALL_NODE4_TOOL_FACTORIES.inventory, "function", "inventory factory registered");

const defaultNames = toolNamesForPack(DEFAULT_SEAT_PACK);
assert.ok(defaultNames.includes("inventory"), "Default catalog exposes inventory");
for (const name of COLLAPSED) {
  assert.ok(!defaultNames.includes(name), `Default catalog omits ${name}`);
}

assert.ok(!pentest.toolNames.includes("inventory"), "pentest loop omits inventory");
assert.ok(!ctf.toolNames.includes("inventory"), "ctf loop omits inventory");

function toolText(result: unknown): string {
  return String((result as { content?: Array<{ text?: string }> })?.content?.[0]?.text || "");
}

function makeRuntime(): ToolRuntime {
  return {
    task: {
      taskId: "t1",
      conversationId: "c1",
      instruction: "x",
      target: {},
      scope: {},
    },
    workspaceDir: "/tmp",
    piDir: "/tmp",
    platform: { send: async () => {} },
    platformApi: { baseUrl: "http://ledger.test", nodeToken: "tok" },
    todo: {} as any,
    evidence: {} as any,
    findingsDir: "/tmp/f",
    goals: {} as any,
    lifecycle: {},
  } as ToolRuntime;
}

function mockFetch(handler: (req: { method: string; url: string; body?: unknown }) => unknown) {
  const orig = globalThis.fetch;
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = String(init?.method || "GET").toUpperCase();
    let body: unknown;
    if (init?.body) {
      try {
        body = JSON.parse(String(init.body));
      } catch {
        body = init.body;
      }
    }
    const req = { method, url, body };
    calls.push(req);
    return new Response(JSON.stringify(handler(req)), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return {
    calls,
    restore() {
      globalThis.fetch = orig;
    },
  };
}

{
  const runtime = makeRuntime();
  const tool = createInventoryTool(runtime);
  const noReason = await tool.execute!("1", { op: "create", kind: "host", address: "10.0.0.1" });
  assert.match(toolText(noReason), /reason required/);
}

{
  const runtime = makeRuntime();
  const tool = createInventoryTool(runtime);
  const smuggle = await tool.execute!("2", { op: "enrich", kind: "host", address: "evil.example", ports: [80] });
  assert.match(toolText(smuggle), /host create denied/);
  assert.equal(isHostCreateAttempt("enrich_asset", { address: "evil.example" }), true);
}

{
  const runtime = makeRuntime();
  const mock = mockFetch((req) => {
    if (req.url.includes("/ledger/assets") && req.method === "GET") {
      return { ok: true, count: 1, assets: [{ id: "h1", address: "10.0.0.1" }] };
    }
    if (req.url.includes("/ledger/assets") && req.method === "POST") {
      return { ok: true, asset: { id: "h2", address: "10.0.0.2" } };
    }
    if (req.url.includes("/ledger/groups") && req.method === "GET") {
      return { ok: true, count: 1, groups: [{ id: "g1", name: "Acme" }] };
    }
    if (req.url.includes("/ledger/groups") && req.method === "POST") {
      return { ok: true, group: { id: "g2", name: "NewCo" } };
    }
    return { ok: false, error: `unexpected ${req.method} ${req.url}` };
  });
  try {
    const tool = createInventoryTool(runtime);
    const listedHosts = await tool.execute!("3", { op: "list", kind: "host" });
    assert.match(toolText(listedHosts), /10\.0\.0\.1/);
    assert.ok(
      mock.calls.some((c) => c.method === "GET" && c.url.includes("/api/node/ledger/assets")),
      "list host hits ledger assets",
    );

    const createdHost = await tool.execute!("4", {
      op: "create",
      kind: "host",
      reason: "user asked to add 10.0.0.2",
      address: "10.0.0.2",
    });
    assert.match(toolText(createdHost), /10\.0\.0\.2/);
    assert.ok(
      mock.calls.some(
        (c) =>
          c.method === "POST" &&
          c.url.includes("/api/node/ledger/assets") &&
          !c.url.includes("enrich") &&
          (c.body as { reason?: string })?.reason,
      ),
      "create host posts ledger assets with reason",
    );

    const listedGroups = await tool.execute!("5", { op: "list", kind: "group" });
    assert.match(toolText(listedGroups), /Acme/);
    assert.ok(
      mock.calls.some((c) => c.method === "GET" && c.url.includes("/api/node/ledger/groups")),
      "list group hits ledger groups",
    );

    const createdGroup = await tool.execute!("6", {
      op: "create",
      kind: "group",
      reason: "user asked to add NewCo",
      name: "NewCo",
    });
    assert.match(toolText(createdGroup), /NewCo/);
    assert.ok(
      mock.calls.some(
        (c) =>
          c.method === "POST" &&
          c.url.includes("/api/node/ledger/groups") &&
          !c.url.includes("assemble") &&
          (c.body as { reason?: string })?.reason,
      ),
      "create group posts ledger groups with reason",
    );
  } finally {
    mock.restore();
  }
}

{
  const groupId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeee0001";
  const runtime = makeRuntime();
  const mock = mockFetch((req) => {
    if (req.method === "GET" && req.url.includes(`/ledger/groups/${groupId}`)) {
      return { ok: true, group: { id: groupId, name: "Acme" } };
    }
    if (req.method === "GET" && /\/ledger\/groups(\?|$)/.test(req.url)) {
      return { ok: true, count: 0, groups: [] };
    }
    if (req.method === "POST" && req.url.includes("/ledger/assets/") && req.url.includes("/enrich")) {
      return { ok: true, asset_id: "h1", ports: [80] };
    }
    if (req.method === "POST" && req.url.includes("/ledger/assets/batch-enrich")) {
      return { ok: true, asset_ids: ["h1"] };
    }
    return { ok: false, error: `unexpected ${req.method} ${req.url}` };
  });
  try {
    const tool = createInventoryTool(runtime);
    const got = await tool.execute!("7", { op: "get", kind: "group", group_id: groupId });
    assert.match(toolText(got), /Acme/);
    assert.ok(
      mock.calls.some(
        (c) => c.method === "GET" && c.url.includes(`/api/node/ledger/groups/${groupId}`),
      ),
      "get(group) fetches Group by id, not name search",
    );
    assert.ok(
      !mock.calls.some(
        (c) =>
          c.method === "GET" &&
          c.url.includes("/api/node/ledger/groups") &&
          c.url.includes(`q=${groupId}`),
      ),
      "get(group) must not pass Group id as q= name search",
    );

    const enriched = await tool.execute!("8", {
      op: "enrich",
      kind: "host",
      asset_ids: ["h1"],
      ports: [80],
    });
    assert.ok(!/^error:/i.test(toolText(enriched).trim()), `single asset_ids enrich: ${toolText(enriched).slice(0, 200)}`);
    const enrichCall = mock.calls.find(
      (c) =>
        c.method === "POST" &&
        (c.url.includes("/ledger/assets/h1/enrich") || c.url.includes("/ledger/assets/batch-enrich")),
    );
    assert.ok(enrichCall, "single asset_ids hits enrich or batch-enrich with that Host");
    if (enrichCall?.url.includes("batch-enrich")) {
      const ids = (enrichCall.body as { asset_ids?: string[] })?.asset_ids || [];
      assert.ok(ids.includes("h1"), "batch-enrich body carries the single asset_ids entry");
    }
  } finally {
    mock.restore();
  }
}

console.log("inventory.test.ts ok");
