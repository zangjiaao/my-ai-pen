/**
 * Hypothesis tool Main-only + mode gate (Spec #274).
 * Run: npx tsx src/tools/hypothesis.test.ts
 */
import assert from "node:assert/strict";
import { createHypothesisTool } from "./hypothesis.js";
import { createProcessQualityState } from "../runtime/package-honesty-host.js";
import type { ToolRuntime } from "../types.js";

function makeRuntime(opts: {
  depth?: number;
  hypMode?: boolean;
}): ToolRuntime {
  const pq = createProcessQualityState();
  return {
    task: {
      taskId: "t",
      conversationId: "c",
      instruction: "x",
      target: {},
      scope: {},
    },
    workspaceDir: "/tmp",
    piDir: "/tmp",
    platform: { send: async () => {} },
    todo: {} as any,
    evidence: {} as any,
    findingsDir: "/tmp/f",
    goals: {} as any,
    lifecycle: {
      subagentDepth: opts.depth ?? 0,
      processQuality: pq,
      hardGraphRun: {
        plan: {} as any,
        usage: {} as any,
        panel: {} as any,
        stageId: "class_probe",
        hypothesisWorkMode: opts.hypMode === true,
      },
    },
  } as ToolRuntime;
}

// Sub cannot write
{
  const tool = createHypothesisTool(makeRuntime({ depth: 1, hypMode: true }));
  const r = await tool.execute!("1", { op: "list" });
  const text = JSON.stringify(r);
  assert.match(text, /subagent must not/i);
}

// Mode off blocks upsert
{
  const tool = createHypothesisTool(makeRuntime({ hypMode: false }));
  const r = await tool.execute!("1", {
    op: "upsert",
    statement: "s",
    signal: "sig",
    prove_if: "p",
    disprove_if: "d",
  });
  assert.match(JSON.stringify(r), /hypothesis_work_mode/i);
}

// Mode on: upsert + commit + seed boundary
{
  const rt = makeRuntime({ hypMode: true });
  const tool = createHypothesisTool(rt);
  const up = await tool.execute!("1", {
    op: "upsert",
    statement: "SQLi",
    signal: "err",
    prove_if: "delay",
    disprove_if: "clean",
    payload: { title: "SQLi", location: "http://t/login", severity: "high", proof_excerpt: "x".repeat(30) },
  });
  const upText = (up as any).content?.[0]?.text || JSON.stringify(up);
  assert.match(upText, /"ok":\s*true/);
  const idMatch = /"id":\s*"(hyp-[^"]+)"/.exec(upText);
  assert.ok(idMatch);
  const id = idMatch![1]!;
  const commit = await tool.execute!("2", { op: "commit", id, status: "confirmed" });
  const commitText = (commit as any).content?.[0]?.text || JSON.stringify(commit);
  assert.match(commitText, /Confirmed ≠ booked|confirmed/);
  const seed = await tool.execute!("3", { op: "seed_store", id });
  const seedText = (seed as any).content?.[0]?.text || JSON.stringify(seed);
  assert.match(seedText, /finding_id/);
  assert.match(seedText, /feedback_ok|confirm/);
  // Killed never seed
  const k = await tool.execute!("4", {
    op: "upsert",
    statement: "XSS",
    signal: "r",
    prove_if: "p",
    disprove_if: "d",
  });
  const kText = (k as any).content?.[0]?.text || JSON.stringify(k);
  const kid = /"id":\s*"(hyp-[^"]+)"/.exec(kText)![1]!;
  await tool.execute!("5", { op: "commit", id: kid, status: "killed", revisit_if: "later" });
  const badSeed = await tool.execute!("6", { op: "seed_store", id: kid });
  const badText = (badSeed as any).content?.[0]?.text || JSON.stringify(badSeed);
  assert.match(badText, /only confirmed|error/i);
}

console.log("hypothesis.test.ts: ok");
