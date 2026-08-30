/**
 * Spec #532 — workset(propose) builds passive candidates (no Host create).
 * Run: npx tsx src/tools/workset.test.ts
 */
import assert from "node:assert/strict";
import { ALL_NODE4_TOOL_FACTORIES } from "./index.js";
import { SUBAGENT_CHILD_TOOL_NAMES } from "../runtime/subagent-session.js";
import { buildPassiveWorksetCandidate, collectWorksetAdoptSelectors, createWorksetTool, filterWorksetForAgent, mergeStashIntoCaseList, normalizeAgentWorksetStatus } from "./workset.js";
import type { ToolRuntime } from "../types.js";

assert.equal(typeof ALL_NODE4_TOOL_FACTORIES.workset, "function");
assert.ok(
  !(SUBAGENT_CHILD_TOOL_NAMES as readonly string[]).includes("workset"),
  "Workers must not park Workset (Main only)",
);

{
  const row = buildPassiveWorksetCandidate({
    host: "cdn.example.com",
    intel_source: "ct",
    attribution: "crt.sh SAN cdn.example.com",
    confidence: "medium",
  });
  assert.ok(!("error" in row));
  if ("error" in row) throw new Error(row.error);
  assert.equal(row.family, "t_host");
  assert.equal(row.in_scope, false);
  assert.equal(row.passive, true);
  assert.equal(row.intel_source, "ct");
  assert.equal(row.scope_decision, "pending");
  assert.match(row.attribution || "", /crt\.sh/);
  assert.equal(row.source, "workset_propose");
}

{
  const missing = buildPassiveWorksetCandidate({ host: "x.example.com" });
  assert.ok("error" in missing);
}

{
  const other = buildPassiveWorksetCandidate({
    host: "1.2.3.4",
    intel_source: "made_up_index",
    attribution: "custom dump line",
  });
  assert.ok(!("error" in other));
  if ("error" in other) throw new Error(other.error);
  assert.equal(other.intel_source, "other");
}

assert.equal(normalizeAgentWorksetStatus("pending"), "proposed");
assert.equal(normalizeAgentWorksetStatus("waiting"), "proposed");
assert.equal(normalizeAgentWorksetStatus("admission"), "proposed");
assert.equal(normalizeAgentWorksetStatus("adopted"), "adopted");

function makeRuntime(): { runtime: ToolRuntime; sent: Record<string, unknown>[] } {
  const sent: Record<string, unknown>[] = [];
  const runtime = {
    task: {
      taskId: "t1",
      conversationId: "c1",
      instruction: "x",
      target: {},
      scope: {},
    },
    workspaceDir: "/tmp",
    piDir: "/tmp",
    platform: {
      send: async (msg: Record<string, unknown>) => {
        sent.push(msg);
      },
    },
    todo: {} as any,
    evidence: {} as any,
    findingsDir: "/tmp/f",
    goals: {} as any,
    lifecycle: {},
  } as ToolRuntime;
  return { runtime, sent };
}

{
  const { runtime, sent } = makeRuntime();
  const tool = createWorksetTool(runtime);
  const bad = await tool.execute!("1", { op: "propose", host: "cdn.example.com" });
  const badText = (bad as any).content?.[0]?.text || JSON.stringify(bad);
  assert.match(badText, /attribution required/);
  assert.equal(sent.length, 0);

  const ok = await tool.execute!("2", {
    op: "propose",
    host: "cdn.example.com",
    intel_source: "ct",
    attribution: "crt.sh SAN",
    confidence: "high",
  });
  const okText = (ok as any).content?.[0]?.text || JSON.stringify(ok);
  assert.match(okText, /"ok":\s*true/);
  assert.match(okText, /Do not create_asset/);
  assert.equal(runtime.lifecycle.worksetProposed?.length, 1);
  assert.equal(runtime.lifecycle.worksetProposed?.[0]?.intel_source, "ct");
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.type, "workset_propose");
  const cands = sent[0]?.workset_candidates as Array<Record<string, unknown>>;
  assert.equal(cands[0]?.passive, true);
  assert.equal(cands[0]?.in_scope, false);

  const listed = await tool.execute!("3", { op: "list" });
  const listText = (listed as any).content?.[0]?.text || JSON.stringify(listed);
  assert.match(listText, /cdn\.example\.com/);
  assert.match(listText, /pending admission/);
}

{
  const caseItems = [
    {
      id: "ws1",
      family: "t_host" as const,
      status: "proposed",
      title: "cdn.example.com",
      host: "cdn.example.com",
      intel_source: "ct",
      attribution: "crt.sh",
    },
  ];
  const stashRow = buildPassiveWorksetCandidate({
    host: "cdn.example.com",
    intel_source: "ct",
    attribution: "crt.sh SAN",
  });
  assert.ok(!("error" in stashRow));
  if ("error" in stashRow) throw new Error(stashRow.error);
  const merged = mergeStashIntoCaseList(caseItems, [stashRow]);
  assert.equal(merged.length, 1, "same host does not double-park");
  const thinCase = [
    { id: "ws-a", family: "t_host" as const, status: "adopted", title: "a.example.com" },
    { id: "ws-b", family: "t_host" as const, status: "proposed", title: "b.example.com" },
  ];
  assert.equal(mergeStashIntoCaseList(thinCase, []).length, 2);
  const extra = buildPassiveWorksetCandidate({
    host: "mail.example.com",
    intel_source: "dns",
    attribution: "A record",
  });
  assert.ok(!("error" in extra));
  if ("error" in extra) throw new Error(extra.error);
  const both = mergeStashIntoCaseList(caseItems, [extra]);
  assert.equal(both.length, 2);
  const filtered = filterWorksetForAgent(both, { family: "t_host", needle: "mail" });
  assert.equal(filtered.total, 1);
  assert.equal(filtered.items[0]!.host, "mail.example.com");
  const pending = filterWorksetForAgent(thinCase, { status: "pending" });
  assert.equal(pending.total, 1);
  assert.equal(pending.items[0]!.id, "ws-b");
}

{
  const { runtime } = makeRuntime();
  runtime.task.caseContext = {
    next_work: {
      workset_open_count: 1,
      workset_open: [
        { id: "from-case", family: "t_host", title: "parked.lab", status: "proposed", host: "parked.lab" },
      ],
    },
  };
  const sameHost = buildPassiveWorksetCandidate({
    host: "parked.lab",
    intel_source: "ct",
    attribution: "crt.sh SAN parked.lab",
  });
  assert.ok(!("error" in sameHost));
  if ("error" in sameHost) throw new Error(sameHost.error);
  runtime.lifecycle.worksetProposed = [sameHost];
  const tool = createWorksetTool(runtime);
  const listed = await tool.execute!("1", { op: "list" });
  const listText = (listed as any).content?.[0]?.text || JSON.stringify(listed);
  assert.match(listText, /from-case|parked\.lab/);
  const parsed = JSON.parse(listText);
  assert.equal(parsed.items?.length, 1, "fallback host must alias-dedupe this-burst propose");
}

{
  const { runtime } = makeRuntime();
  const tool = createWorksetTool(runtime);
  const missingMode = await tool.execute!("s0", { op: "set_intake", group_name: "example公司" });
  const missingModeText = (missingMode as any).content?.[0]?.text || JSON.stringify(missingMode);
  assert.match(missingModeText, /mode=enroll_group or mode=ask/);
  const missing = await tool.execute!("s1", { op: "set_intake", mode: "enroll_group" });
  const missingText = (missing as any).content?.[0]?.text || JSON.stringify(missing);
  assert.match(missingText, /group_id or group_name/);
  const noApi = await tool.execute!("s2", {
    op: "set_intake",
    mode: "enroll_group",
    group_name: "example公司",
  });
  const noApiText = (noApi as any).content?.[0]?.text || JSON.stringify(noApi);
  assert.match(noApiText, /asset-intake persist failed|ok":\s*false/);
}

{
  const { runtime } = makeRuntime();
  runtime.lifecycle.hardGraphRun = { stageId: "surface" } as any;
  const tool = createWorksetTool(runtime);
  const blocked = await tool.execute!("g1", {
    op: "set_intake",
    mode: "enroll_group",
    group_name: "example公司",
  });
  const blockedText = (blocked as any).content?.[0]?.text || JSON.stringify(blocked);
  assert.match(blockedText, /not available during a Graph stage/);
}

{
  const sel = collectWorksetAdoptSelectors({
    hosts: "www.example.com, api.example.com",
    item_ids: "ws_1",
  });
  assert.deepEqual(sel.hosts, ["www.example.com", "api.example.com"]);
  assert.deepEqual(sel.item_ids, ["ws_1"]);
  const empty = collectWorksetAdoptSelectors({ op: "adopt", question: "纳入 www" });
  assert.deepEqual(empty.hosts, []);
  assert.deepEqual(empty.item_ids, []);
}

{
  const { runtime } = makeRuntime();
  const tool = createWorksetTool(runtime);
  const missing = await tool.execute!("a0", { op: "adopt" });
  const missingText = (missing as any).content?.[0]?.text || JSON.stringify(missing);
  assert.match(missingText, /hosts \(names the user chose\)/);
}

function jsonFetch(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;
}

{
  const { runtime } = makeRuntime();
  runtime.platformApi = { baseUrl: "http://ledger.test", nodeToken: "tok" } as any;
  const origFetch = globalThis.fetch;
  globalThis.fetch = jsonFetch({
    ok: true,
    adopted_t_host_ids: ["ws_www"],
    scope: { allow: ["www.example.com"], asset_ids: ["aid-1"] },
    admission_ambiguous: [],
  });
  try {
    const tool = createWorksetTool(runtime);
    const out = await tool.execute!("a1", { op: "adopt", hosts: "www.example.com" });
    const text = (out as any).content?.[0]?.text || JSON.stringify(out);
    assert.match(text, /"ok":\s*true/);
    assert.match(text, /ws_www/);
    assert.deepEqual((runtime.task as { scope?: { allow?: string[] } }).scope?.allow, ["www.example.com"]);
  } finally {
    globalThis.fetch = origFetch;
  }
}

{
  const { runtime } = makeRuntime();
  runtime.platformApi = { baseUrl: "http://ledger.test", nodeToken: "tok" } as any;
  const origFetch = globalThis.fetch;
  globalThis.fetch = jsonFetch({
    ok: false,
    adopted_t_host_ids: [],
    live_adopted_t_host_ids: ["ws_www"],
    scope: { allow: ["www.example.com"] },
    admission_ambiguous: [],
  });
  try {
    const tool = createWorksetTool(runtime);
    const out = await tool.execute!("a2", { op: "adopt", hosts: "www.example.com" });
    const text = (out as any).content?.[0]?.text || JSON.stringify(out);
    assert.match(text, /Live adopted Hosts remain/);
    assert.doesNotMatch(text, /Do not claim Hosts were admitted/);
  } finally {
    globalThis.fetch = origFetch;
  }
}

console.log("workset.test.ts: ok");
