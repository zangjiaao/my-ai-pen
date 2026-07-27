/**
 * Spec #139 NC-Closeout.
 * Run: npx tsx src/runtime/engagement-closeout.test.ts
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FindingStore } from "./finding-store.js";
import { buildEngagementCloseout, writeEngagementCloseout } from "./engagement-closeout.js";
import type { TaskEnvelope } from "../types.js";

const store = new FindingStore();
store.upsert({
  title: "RCE",
  location: "http://t/exec",
  severity: "critical",
  proof_excerpt: "uid=0 root shell from upload",
  prior: true,
});
const { id } = store.upsert({
  title: "XSS",
  location: "http://t/xss",
  severity: "medium",
  proof_excerpt: "script reflected in response body enough",
});
store.enqueueFeedback([id]);
store.applyMechanicalL0Feedback([id]);

const task = {
  conversationId: "c1",
  taskId: "t1",
  instruction: "test",
  target: { value: "http://t" },
  scope: { allow: ["http://t"] },
  agentLanguage: "en",
} as TaskEnvelope;

const closeout = buildEngagementCloseout({
  task,
  graphId: "app_assessment",
  terminal: "completed",
  stages: [{ stageId: "surface", stageIndex: 1, attempts: 1, outcome: "passed", errors: [] }],
  store,
  priorSeed: { prior_n: 1, empty_prior: false, ids: [], snapshot: [] },
  unbookable: [{ finding_id: id, reason: "validate_book_incomplete" }],
  l1ByStage: { surface: { last: { decision: "pass", gaps: [] } } },
});
assert.equal(closeout.terminal, "completed");
assert.equal(closeout.process_complete, true);
assert.equal(closeout.residual_class, undefined, "completed with unbookable is not residual_class blocked");
assert.ok(closeout.findings.by_severity.critical || closeout.findings.by_severity.medium);
assert.ok(closeout.residual_risk);
assert.equal(closeout.priors.prior_n, 1);

const dir = await mkdtemp(join(tmpdir(), "closeout-"));
const sent: unknown[] = [];
await writeEngagementCloseout({
  taskDir: dir,
  platform: { send: async (m) => { sent.push(m); } },
  task,
  closeout,
});
const raw = await readFile(join(dir, "hard-graph", "engagement-closeout.json"), "utf8");
const parsed = JSON.parse(raw);
assert.equal(parsed.graphId, "app_assessment");
assert.equal((sent[0] as { type: string }).type, "engagement_closeout");

console.log("engagement-closeout.test.ts: ok");
