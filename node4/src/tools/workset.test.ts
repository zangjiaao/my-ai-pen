/**
 * Spec #532 — workset(propose) builds passive candidates (no Host create).
 * Run: npx tsx src/tools/workset.test.ts
 */
import assert from "node:assert/strict";
import { ALL_NODE4_TOOL_FACTORIES } from "./index.js";
import { SUBAGENT_CHILD_TOOL_NAMES } from "../runtime/subagent-session.js";
import { buildPassiveWorksetCandidate, createWorksetTool, filterWorksetForAgent, mergeStashIntoCaseList } from "./workset.js";
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
}

{
  const { runtime } = makeRuntime();
  runtime.task.caseContext = {
    next_work: {
      workset_open_count: 1,
      workset_open: [{ id: "from-case", family: "t_host", title: "parked.lab", status: "proposed" }],
    },
  };
  const tool = createWorksetTool(runtime);
  const listed = await tool.execute!("1", { op: "list" });
  const listText = (listed as any).content?.[0]?.text || JSON.stringify(listed);
  assert.match(listText, /from-case|parked\.lab/);
}

console.log("workset.test.ts: ok");
