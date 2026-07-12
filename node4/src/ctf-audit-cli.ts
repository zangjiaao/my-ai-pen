/**
 * CLI: audit a Node4 events.jsonl (CTF/pentest) → JSON report on stdout.
 * Usage: npx tsx src/ctf-audit-cli.ts [path/to/events.jsonl]
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { auditCtfEventsJsonl } from "./runtime/ctf-audit.js";

async function main() {
  const arg = process.argv[2];
  const path = resolve(
    arg ||
      process.env.NODE4_CTF_EVENTS ||
      "/tmp/node4-ctf-fullclear-20260712-191826/n4-ctf-fullclear-20260712-191826/events.jsonl",
  );
  const text = await readFile(path, "utf8");
  const report = auditCtfEventsJsonl(text, { sourceLabel: path });
  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
