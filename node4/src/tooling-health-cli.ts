/**
 * Standalone pen-sandbox tooling health doctor (observability only).
 *
 * Usage:
 *   npx tsx src/tooling-health-cli.ts
 *   npm run doctor:pen-tools
 *
 * Exit code is always 0 when the probe runs (including degraded tooling).
 * Exit 2 only for unexpected probe crashes (not "tools missing").
 */
import {
  formatToolingHealthReport,
  probeToolingHealth,
} from "./runtime/tooling-health.js";

function main(): void {
  const json = process.argv.includes("--json");
  // Skip slow container binary probe when --fast (image/shim/host only).
  const fast = process.argv.includes("--fast");
  try {
    const report = probeToolingHealth({
      checkContainerBinaries: !fast,
    });
    if (json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatToolingHealthReport(report));
    }
    // Non-blocking: missing tools are degraded fields, not process failure.
    process.exit(0);
  } catch (err) {
    console.error("tooling-health probe crashed (unexpected):", err);
    process.exit(2);
  }
}

main();
