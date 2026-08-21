/**
 * Batch package inherit: packages[].target optional, same as scope/already_done.
 * Run: npx tsx src/tools/subagent-package.test.ts
 */
import assert from "node:assert/strict";
import { packageItemSchema, resolvePackageInput } from "./subagent-package.js";

const required = packageItemSchema.required ?? [];
assert.ok(!required.includes("target"), "packages[].target is not schema-required (batch inherits top-level)");
assert.ok(!required.includes("scope"), "packages[].scope stays optional");
assert.ok(!required.includes("already_done"), "packages[].already_done stays optional");
assert.ok(required.includes("this_turn_goal"), "this_turn_goal stays per-package");
assert.ok(required.includes("success_criteria"), "success_criteria stays per-package");

const inherited = resolvePackageInput(
  {
    target: "ping-test",
    scope: "no network",
    already_done: "none",
  },
  {
    this_turn_goal: "reply ping1",
    success_criteria: "text contains ping1",
  },
  0,
);
assert.ok("pkg" in inherited, "top-level target/scope/already_done satisfy the handoff");
if ("pkg" in inherited) {
  assert.equal(inherited.pkg.target, "ping-test");
  assert.equal(inherited.pkg.this_turn_goal, "reply ping1");
}

const override = resolvePackageInput(
  { target: "http://a/", scope: "a only", already_done: "recon" },
  {
    target: "http://b/",
    this_turn_goal: "probe b",
    success_criteria: "status",
  },
  1,
);
assert.ok("pkg" in override);
if ("pkg" in override) assert.equal(override.pkg.target, "http://b/");

const missing = resolvePackageInput(
  { scope: "no network", already_done: "none" },
  { this_turn_goal: "reply ping1", success_criteria: "ping1" },
  0,
);
assert.ok("error" in missing, "no package target and no top-level target still fails");
if ("error" in missing) {
  assert.match(missing.error, /incomplete handoff/);
  assert.match(missing.error, /target/);
}

console.log("subagent-package.test.ts: ok");
