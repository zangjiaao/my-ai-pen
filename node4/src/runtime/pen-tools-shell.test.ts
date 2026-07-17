/**
 * Run: npx tsx src/runtime/pen-tools-shell.test.ts
 * Docker + pen-tools (or pentest-sandbox) image required for container cases.
 */
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dockerImageExists,
  isShellInPenToolsEnabled,
  resolvePenToolsImage,
  runShellInPenTools,
} from "./pen-tools-shell.js";
import { runShell } from "../tools/shell.js";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

const saved = { ...process.env };
const dir = mkdtempSync(join(tmpdir(), "pen-shell-"));

try {
  writeFileSync(join(dir, "marker.txt"), "ok\n");

  process.env.NODE4_SHELL_IN_PEN_TOOLS = "0";
  assert(isShellInPenToolsEnabled() === false, "explicit off");

  const hasImage =
    dockerImageExists("pen-tools:dev") ||
    dockerImageExists("pentest-sandbox:latest") ||
    dockerImageExists("pen-tools:0.1.0");

  if (!hasImage) {
    console.log("SKIP container tests — no pen-tools image");
    console.log("RESULT: PASS — flags only (no image)");
    process.exit(0);
  }

  process.env.NODE4_SHELL_IN_PEN_TOOLS = "1";
  assert(isShellInPenToolsEnabled() === true, "explicit on");
  const img = resolvePenToolsImage();
  assert(img.length > 0, "resolve image");

  const r = await runShellInPenTools("cat marker.txt && which nuclei && nuclei -version 2>&1 | head -2", dir, 180_000);
  assert(r.exitCode === 0, `container shell exit=${r.exitCode} stderr=${r.stderr.slice(0, 200)}`);
  assert(r.stdout.includes("ok"), "mounted workspace readable");
  assert(/nuclei/i.test(r.stdout), "nuclei in container");

  // runShell routes to container when enabled
  const r2 = await runShell("echo shell-route && test -f marker.txt", dir, 60_000);
  assert(r2.exitCode === 0 && r2.stdout.includes("shell-route"), "runShell container path");

  console.log(JSON.stringify({ ok: true, image: img, nucleiSnippet: r.stdout.slice(0, 200) }, null, 2));
  console.log("RESULT: PASS — pen-tools-shell S4");
} finally {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // container may leave root-owned cache under taskDir; ignore cleanup noise
  }
  for (const k of Object.keys(process.env)) {
    if (!(k in saved)) delete process.env[k];
  }
  Object.assign(process.env, saved);
}
