/**
 * Package status light — paused (authorize wait) is yellow even when working.
 * Run: npx tsx src/lib/packageStatusLight.test.ts
 */
import assert from "node:assert/strict";
import {
  packageStatusDotClass,
  packageStatusTitle,
  resolvePackageLightStatus,
} from "./packageStatusLight.ts";

{
  // paused must win over working=true (authorize keeps working for Send interrupt)
  assert.ok(
    packageStatusDotClass("paused", true).includes("severity-high"),
    "paused+working → High yellow not running blue",
  );
  assert.ok(
    packageStatusDotClass("pause", true).includes("severity-high"),
    "alias pause also High yellow",
  );
  assert.ok(
    packageStatusDotClass("running", true).includes("status-running"),
    "running still blue",
  );
  assert.equal(packageStatusTitle("paused", true), "等待授权");
  // Spec #455: package light is segment status, not Case death.
  assert.equal(packageStatusTitle("failed"), "本段错误");
  assert.equal(packageStatusTitle("canceled"), "本段已中止");
  assert.equal(
    resolvePackageLightStatus({ packageStatus: "paused", working: true }),
    "paused",
  );
  assert.equal(
    resolvePackageLightStatus({ packageStatus: "running", working: true }),
    "running",
  );
  assert.equal(
    resolvePackageLightStatus({ packageStatus: "incomplete", working: true }),
    "incomplete",
    "incomplete park must not become running/blue when working is sticky",
  );
  assert.ok(
    packageStatusDotClass("incomplete", true).includes("severity-high"),
    "incomplete+working → High yellow",
  );
  assert.equal(packageStatusTitle("incomplete", true), "等待/暂停");
  console.log("ok: paused yellow over working");
}

console.log("packageStatusLight.test.ts: all ok");
