/**
 * CLI: list / install / uninstall expert packs on this Node.
 * Usage: npx tsx src/expert-cli.ts <list|install|uninstall> [packId]
 */
import {
  installExpert,
  uninstallExpert,
  listExpertsStatus,
} from "./experts/index.js";

const [cmd, packId] = process.argv.slice(2);

async function main(): Promise<void> {
  if (!cmd || cmd === "list" || cmd === "status") {
    const st = listExpertsStatus();
    console.log(JSON.stringify(st, null, 2));
    return;
  }
  if (cmd === "install") {
    if (!packId) {
      console.error("usage: expert-cli install <packId>");
      process.exit(2);
    }
    const r = installExpert(packId);
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.ok ? 0 : 1);
  }
  if (cmd === "uninstall") {
    if (!packId) {
      console.error("usage: expert-cli uninstall <packId>");
      process.exit(2);
    }
    const r = uninstallExpert(packId);
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.ok ? 0 : 1);
  }
  console.error("usage: expert-cli <list|install|uninstall> [packId]");
  process.exit(2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
