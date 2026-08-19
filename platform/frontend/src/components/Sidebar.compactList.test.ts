/**
 * Spec #490: compact Sidebar lists every Case (no numeric cap).
 * Run: npx tsx src/components/Sidebar.compactList.test.ts  (from platform/frontend)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "Sidebar.tsx"), "utf8");

assert.equal(
  /conversations\.slice\(\s*0\s*,\s*8\s*\)/.test(src),
  false,
  "compact Sidebar must not cap Cases at 8",
);

const compactBlock = src.match(
  /compact \? \(\s*<div className="flex flex-col items-center[\s\S]*?conversations\.map\(\(c\) =>/,
);
assert.ok(
  compactBlock,
  "compact Case rail must map the full conversations array",
);

console.log("ok: compact Sidebar lists all Cases");
