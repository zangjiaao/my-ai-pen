/**
 * Smoke: shell PATH includes pen-tools so nuclei shim resolves (Docker required).
 * Run: npx tsx src/runtime/pen-tools-shell-smoke.ts
 */
import { runShell } from "../tools/shell.js";
import { resolvePenToolsBinDir } from "./pen-tools-path.js";

const bin = resolvePenToolsBinDir();
if (!bin) {
  console.error("FAIL: pen-tools bin not resolved (set NODE4_PEN_TOOLS_BIN or run from repo)");
  process.exit(1);
}

const r = await runShell("command -v nuclei && nuclei -version 2>&1 | head -5", process.cwd(), 180_000);
console.log(
  JSON.stringify(
    {
      bin,
      exitCode: r.exitCode,
      stdout: r.stdout.slice(0, 500),
      stderr: r.stderr.slice(0, 300),
    },
    null,
    2,
  ),
);
if (r.exitCode !== 0 || !String(r.stdout).includes("nuclei")) {
  console.error("RESULT: FAIL — shell did not resolve nuclei via pen-tools PATH");
  process.exit(1);
}
console.log("RESULT: PASS — shell sees nuclei via pen-tools PATH");
