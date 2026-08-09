/**
 * Package status light — pause (authorize wait) is yellow even when working.
 * Run: npx tsx src/lib/packageStatusLight.test.ts
 */
import assert from "node:assert/strict";
import {
  packageStatusDotClass,
  packageStatusTitle,
  resolvePackageLightStatus,
} from "./packageStatusLight.ts";

{
  // pause must win over working=true (authorize keeps working for Send interrupt)
  assert.ok(
    packageStatusDotClass("pause", true).includes("severity-medium"),
    "pause+working → yellow not blue",
  );
  assert.ok(
    packageStatusDotClass("running", true).includes("status-running"),
    "running still blue",
  );
  assert.equal(packageStatusTitle("pause", true), "等待授权");
  assert.equal(
    resolvePackageLightStatus({ packageStatus: "pause", working: true }),
    "pause",
  );
  assert.equal(
    resolvePackageLightStatus({ packageStatus: "running", working: true }),
    "running",
  );
  console.log("ok: pause yellow over working");
}

console.log("packageStatusLight.test.ts: all ok");
