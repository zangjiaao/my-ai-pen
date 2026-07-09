import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { loadConfig } from "./config.js";
import { loadDotEnv } from "./env.js";

loadDotEnv();
loadDotEnv("node2/.env");

type ExpectedModule = {
  id: string;
  label: string;
  coverageClasses: string[];
  titlePatterns: RegExp[];
};

const EXPECTED_MODULES: ExpectedModule[] = [
  {
    id: "brute-force",
    label: "Brute Force",
    coverageClasses: ["brute-force"],
    titlePatterns: [/brute\s*force/i],
  },
  {
    id: "command-injection",
    label: "Command Injection",
    coverageClasses: ["command-injection"],
    titlePatterns: [/command\s*injection/i, /\bos\s*command/i],
  },
  {
    id: "csrf",
    label: "CSRF",
    coverageClasses: ["csrf"],
    titlePatterns: [/csrf/i, /cross-site request forgery/i],
  },
  {
    id: "file-inclusion",
    label: "File Inclusion",
    coverageClasses: ["file-inclusion"],
    titlePatterns: [/file inclusion/i, /\blfi\b/i, /local file/i],
  },
  {
    id: "file-upload",
    label: "File Upload",
    coverageClasses: ["file-upload"],
    titlePatterns: [/file upload/i, /unrestricted upload/i, /upload.*rce/i],
  },
  {
    id: "sql-injection",
    label: "SQL Injection",
    coverageClasses: ["sql-injection"],
    titlePatterns: [/sql injection/i],
  },
  {
    id: "blind-sql-injection",
    label: "Blind SQL Injection",
    coverageClasses: ["blind-sql-injection"],
    titlePatterns: [/blind sql/i, /boolean-based sql/i, /boolean.*sql injection/i],
  },
  {
    id: "weak-session-id",
    label: "Weak Session ID",
    coverageClasses: ["weak-session-id"],
    titlePatterns: [/weak.*session/i, /predictable.*session/i, /dvwasession/i],
  },
  {
    id: "xss-dom",
    label: "DOM XSS",
    coverageClasses: ["xss-dom"],
    titlePatterns: [/dom.*xss/i, /dom-based/i],
  },
  {
    id: "xss-reflected",
    label: "Reflected XSS",
    coverageClasses: ["xss-reflected"],
    titlePatterns: [/reflected.*xss/i, /xss.*reflected/i],
  },
  {
    id: "xss-stored",
    label: "Stored XSS",
    coverageClasses: ["xss-stored"],
    titlePatterns: [/stored.*xss/i, /persistent.*xss/i, /guestbook/i],
  },
  {
    id: "insecure-captcha",
    label: "Insecure CAPTCHA",
    coverageClasses: ["insecure-captcha"],
    titlePatterns: [/captcha/i],
  },
  {
    id: "csp-bypass",
    label: "CSP Bypass",
    coverageClasses: ["csp-bypass"],
    titlePatterns: [/csp/i, /content security policy/i],
  },
  {
    id: "javascript-logic",
    label: "JavaScript Logic",
    coverageClasses: ["javascript-logic"],
    titlePatterns: [/javascript/i, /\bjs\b/i],
  },
];

const args = parseArgs(process.argv.slice(2));
const config = loadConfig();

async function main(): Promise<void> {
  const summaryPaths = parseSummaryPaths(args.summary || args.summaries);
  if (!summaryPaths.length) {
    throw new Error("Pass --summary <path>[,<path>...]");
  }

  const reports: ScoredSummary[] = [];
  for (const path of summaryPaths) {
    reports.push(scoreSummary(await readJson(resolve(path)), resolve(path)));
  }

  const report = {
    schema: "node2-dvwa-score-v1",
    generatedAt: new Date().toISOString(),
    expectedModules: EXPECTED_MODULES.map(({ id, label }) => ({ id, label })),
    summaries: reports,
    aggregate: aggregateReports(reports),
  };

  const output = args.output ? resolve(args.output) : defaultOutputPath(summaryPaths);
  await writeFile(output, JSON.stringify(report, null, 2), "utf8");
  printConsole(report, output);
}

type ScoredSummary = {
  source: string;
  runId: string;
  scanMode: string;
  results: ScoredResult[];
};

type ScoredResult = {
  level: string;
  taskId: string;
  seconds: number;
  terminalStatus: string;
  finishStatus?: string;
  expected: number;
  confirmedVulnerabilities: number;
  reported: number;
  observed: number;
  confirmedVulnRate: number;
  reportedRate: number;
  observedRate: number;
  /** observed modules that became confirmed / observed modules */
  observedToConfirmedRate: number;
  confirmedVulnModules: string[];
  reportedModules: string[];
  observedModules: string[];
  missingConfirmedVulns: string[];
  missingReported: string[];
  observedButUnconfirmed: string[];
  missList: string[];
  findings: Array<{ title: string; severity?: string; location?: string; modules: string[]; confirmedVulnerability: boolean }>;
  conversion?: {
    observedCount: number;
    confirmedCount: number;
    observedToConfirmedRate: number;
    missList: string[];
  };
};

function scoreSummary(summary: any, source: string): ScoredSummary {
  const results = Array.isArray(summary?.results) ? summary.results : [];
  return {
    source,
    runId: String(summary?.runId || basename(source)),
    scanMode: String(summary?.scanMode || ""),
    results: results.map(scoreResult),
  };
}

function scoreResult(result: any): ScoredResult {
  const findings = Array.isArray(result?.findings) ? result.findings : [];
  const scoredFindings = findings.map((finding: any) => ({
    title: String(finding.title || ""),
    severity: typeof finding.severity === "string" ? finding.severity : undefined,
    location: typeof finding.location === "string" ? finding.location : undefined,
    modules: classifyFinding(finding),
    confirmedVulnerability: isConfirmedVulnerability(finding),
  }));
  const reportedModules = unique(scoredFindings.flatMap((finding: { modules: string[] }) => finding.modules));
  const confirmedVulnModules = unique(
    scoredFindings
      .filter((finding: { confirmedVulnerability: boolean }) => finding.confirmedVulnerability)
      .flatMap((finding: { modules: string[] }) => finding.modules),
  );
  const observedModules = unique([...reportedModules, ...coverageModules(result?.coverage)]);
  const expectedIds = EXPECTED_MODULES.map((item) => item.id);
  const missingConfirmedVulns = expectedIds.filter((id) => !confirmedVulnModules.includes(id));
  const missingReported = expectedIds.filter((id) => !reportedModules.includes(id));
  const observedButUnconfirmed = observedModules.filter((id) => !confirmedVulnModules.includes(id));
  const observedToConfirmedRate = percent(confirmedVulnModules.length, observedModules.length);
  const missList = observedButUnconfirmed.length ? observedButUnconfirmed : missingConfirmedVulns;

  return {
    level: String(result?.level || ""),
    taskId: String(result?.taskId || ""),
    seconds: Number(result?.seconds || 0),
    terminalStatus: String(result?.terminalStatus || ""),
    finishStatus: typeof result?.finishStatus === "string" ? result.finishStatus : undefined,
    expected: expectedIds.length,
    confirmedVulnerabilities: confirmedVulnModules.length,
    reported: reportedModules.length,
    observed: observedModules.length,
    confirmedVulnRate: percent(confirmedVulnModules.length, expectedIds.length),
    reportedRate: percent(reportedModules.length, expectedIds.length),
    observedRate: percent(observedModules.length, expectedIds.length),
    observedToConfirmedRate,
    confirmedVulnModules,
    reportedModules,
    observedModules,
    missingConfirmedVulns,
    missingReported,
    observedButUnconfirmed,
    missList,
    findings: scoredFindings,
    conversion: {
      observedCount: observedModules.length,
      confirmedCount: confirmedVulnModules.length,
      observedToConfirmedRate,
      missList,
    },
  };
}

function isConfirmedVulnerability(finding: any): boolean {
  const title = String(finding?.title || "");
  const severity = String(finding?.severity || "").toLowerCase();
  if (severity === "info" || severity === "informational") return false;
  if (/\b(blocked|negative|mitigated|not exploitable|not vulnerable|missing)\b/i.test(title)) return false;
  return true;
}

function classifyFinding(finding: any): string[] {
  const haystack = `${finding?.title || ""} ${finding?.location || ""}`.toLowerCase();
  const modules: string[] = [];
  for (const expected of EXPECTED_MODULES) {
    if (expected.titlePatterns.some((pattern) => pattern.test(haystack))) modules.push(expected.id);
  }
  if (modules.includes("blind-sql-injection")) {
    return unique(modules.filter((id) => id !== "sql-injection"));
  }
  return unique(modules);
}

function coverageModules(coverage: any): string[] {
  const byClass = coverage?.byClass && typeof coverage.byClass === "object" ? coverage.byClass : {};
  return EXPECTED_MODULES
    .filter((expected) => expected.coverageClasses.some((key) => Number(byClass[key] || 0) > 0))
    .map((expected) => expected.id);
}

function aggregateReports(reports: ScoredSummary[]): Record<string, unknown> {
  const results = reports.flatMap((summary) => summary.results);
  return {
    runs: results.length,
    averageConfirmedVulnRate: average(results.map((result) => result.confirmedVulnRate)),
    averageReportedRate: average(results.map((result) => result.reportedRate)),
    averageObservedRate: average(results.map((result) => result.observedRate)),
    averageObservedToConfirmedRate: average(results.map((result) => result.observedToConfirmedRate)),
    byLevel: Object.fromEntries(
      ["low", "medium", "high"].map((level) => {
        const rows = results.filter((result) => result.level === level);
        return [
          level,
          {
            runs: rows.length,
            bestConfirmedVulnRate: rows.length ? Math.max(...rows.map((row) => row.confirmedVulnRate)) : 0,
            bestReportedRate: rows.length ? Math.max(...rows.map((row) => row.reportedRate)) : 0,
            bestObservedRate: rows.length ? Math.max(...rows.map((row) => row.observedRate)) : 0,
            bestObservedToConfirmedRate: rows.length ? Math.max(...rows.map((row) => row.observedToConfirmedRate)) : 0,
            latestConfirmedVulnRate: rows.at(-1)?.confirmedVulnRate || 0,
            latestReportedRate: rows.at(-1)?.reportedRate || 0,
            latestObservedRate: rows.at(-1)?.observedRate || 0,
            latestObservedToConfirmedRate: rows.at(-1)?.observedToConfirmedRate || 0,
            latestMissList: rows.at(-1)?.missList || [],
          },
        ];
      }),
    ),
  };
}

function printConsole(report: any, output: string): void {
  console.log(`[node2-dvwa-benchmark-score] ${output}`);
  for (const summary of report.summaries as ScoredSummary[]) {
    for (const result of summary.results) {
      console.log(
        `${result.level}: confirmedVulns=${result.confirmedVulnerabilities}/${result.expected} (${result.confirmedVulnRate}%) reported=${result.reported}/${result.expected} (${result.reportedRate}%) observed=${result.observed}/${result.expected} (${result.observedRate}%) observed→confirmed=${result.observedToConfirmedRate}% missingVulns=${result.missingConfirmedVulns.join(", ") || "none"} missList=${result.missList.join(", ") || "none"}`,
      );
    }
  }
}

async function readJson(path: string): Promise<any> {
  return JSON.parse(await readFile(path, "utf8"));
}

function parseSummaryPaths(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function defaultOutputPath(paths: string[]): string {
  const suffix = paths.length === 1 ? basename(paths[0]!, ".json") : `dvwa-score-${Date.now()}`;
  return resolve(config.workspaceDir, `${suffix}-score.json`);
}

function percent(value: number, total: number): number {
  if (!total) return 0;
  return Math.round((value / total) * 1000) / 10;
}

function average(values: number[]): number {
  if (!values.length) return 0;
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]!;
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      index += 1;
    } else {
      out[key] = "true";
    }
  }
  return out;
}

try {
  await main();
  process.exit(0);
} catch (error) {
  console.error(error);
  process.exit(1);
}
