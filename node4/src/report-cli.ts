/**
 * CLI: build a findings markdown report from a task findings directory.
 * Usage: npx tsx src/report-cli.ts --findings-dir <path> [--out report.md] [--target url]
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { buildFindingsReportMarkdown, loadFindingsFromDir } from "./reports/build-findings-report.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i < 0 || i + 1 >= process.argv.length) return undefined;
  return process.argv[i + 1];
}

async function main(): Promise<void> {
  const findingsDir = resolve(arg("--findings-dir") || arg("-f") || "");
  if (!findingsDir || findingsDir === resolve("")) {
    console.error("usage: report-cli --findings-dir <dir> [--out report.md] [--target url] [--scope s] [--engagement e]");
    process.exit(2);
  }
  const findings = await loadFindingsFromDir(
    findingsDir,
    (p) => readFile(p, "utf8"),
    (p) => readdir(p),
  );
  const md = buildFindingsReportMarkdown({
    title: arg("--title") || "Penetration Test Report",
    target: arg("--target"),
    scope: arg("--scope") || arg("--target"),
    engagement: arg("--engagement") || "pentest",
    findings,
  });
  const outPath = resolve(arg("--out") || arg("-o") || "findings-report.md");
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, md, "utf8");
  console.log(JSON.stringify({ ok: true, out: outPath, findings: findings.length }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
