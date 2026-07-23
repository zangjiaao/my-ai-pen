/**
 * Dependency boundary: product Node4 must not depend on pi-coding-agent.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const node4Root = join(here, "../..");

async function main() {
  const pkg = JSON.parse(await readFile(join(node4Root, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  assert.equal(
    deps["@earendil-works/pi-coding-agent"],
    undefined,
    "package.json must not list pi-coding-agent",
  );
  assert.ok(deps["@earendil-works/pi-ai"], "pi-ai required");
  assert.ok(deps["@earendil-works/pi-agent-core"], "pi-agent-core required");

  // Spot-check entry runtime modules do not import coding-agent.
  const files = [
    "src/runtime/session-runner.ts",
    "src/runtime/subagent-session.ts",
    "src/runtime/hard-graph-stage-executor.ts",
    "src/runtime/run-node4-agent.ts",
    "src/tools/index.ts",
  ];
  for (const rel of files) {
    const src = await readFile(join(node4Root, rel), "utf8");
    assert.equal(
      /from ["']@earendil-works\/pi-coding-agent["']/.test(src),
      false,
      `${rel} must not import pi-coding-agent`,
    );
  }

  console.log("coding-agent-boundary.test.ts: ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
