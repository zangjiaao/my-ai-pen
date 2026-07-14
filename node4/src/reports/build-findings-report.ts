/**
 * Pure transform: confirmed finding records (+ optional evidence map) → markdown report.
 * No invented CVEs; sections derive only from provided data.
 */

export type FindingLike = {
  title?: string;
  name?: string;
  severity?: string;
  status?: string;
  description?: string;
  detail?: string;
  summary?: string;
  poc?: string;
  proof?: string;
  reproduction?: string;
  remediation?: string;
  location?: string;
  url?: string;
  endpoint?: string;
  module?: string;
  cwe?: string;
  cve_id?: string;
  cve?: string;
  evidence_ids?: string[];
  evidenceIds?: string[];
};

export type EvidenceLike = {
  id?: string;
  evidence_id?: string;
  summary?: string;
  type?: string;
  raw_ref?: string;
};

export type ReportInput = {
  title?: string;
  target?: string;
  scope?: string;
  engagement?: string;
  methodNote?: string;
  generatedAt?: string;
  findings: FindingLike[];
  evidenceById?: Record<string, EvidenceLike | string>;
};

const SEV_ORDER = ["critical", "high", "medium", "low", "info", "unknown"];

function findingTitle(f: FindingLike): string {
  return String(f.title || f.name || "Untitled finding").trim() || "Untitled finding";
}

function findingSeverity(f: FindingLike): string {
  const s = String(f.severity || "unknown").trim().toLowerCase();
  return s || "unknown";
}

function evidenceIdsOf(f: FindingLike): string[] {
  const raw = f.evidence_ids ?? f.evidenceIds ?? [];
  return Array.isArray(raw) ? raw.map(String).filter(Boolean) : [];
}

function sortFindings(findings: FindingLike[]): FindingLike[] {
  return [...findings].sort((a, b) => {
    const ia = SEV_ORDER.indexOf(findingSeverity(a));
    const ib = SEV_ORDER.indexOf(findingSeverity(b));
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || findingTitle(a).localeCompare(findingTitle(b));
  });
}

function countBySeverity(findings: FindingLike[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const f of findings) {
    const s = findingSeverity(f);
    counts[s] = (counts[s] || 0) + 1;
  }
  return counts;
}

function locationOf(f: FindingLike): string {
  return String(f.location || f.url || f.endpoint || f.module || "").trim();
}

function descriptionOf(f: FindingLike): string {
  return String(f.description || f.detail || f.summary || "").trim();
}

function pocOf(f: FindingLike): string {
  return String(f.poc || f.proof || f.reproduction || "").trim();
}

/**
 * Build a structured penetration-style markdown report from findings.
 */
export function buildFindingsReportMarkdown(input: ReportInput): string {
  const findings = Array.isArray(input.findings) ? input.findings : [];
  const sorted = sortFindings(findings);
  const counts = countBySeverity(sorted);
  const generatedAt = input.generatedAt || new Date().toISOString();
  const title = input.title || "Penetration Test Report";

  const lines: string[] = [
    `# ${title}`,
    "",
    "## 1. Executive summary",
    "",
    `- Generated at: \`${generatedAt}\``,
    `- Target: \`${input.target || "-"}\``,
    `- Scope: \`${input.scope || input.target || "-"}\``,
    `- Engagement: \`${input.engagement || "pentest"}\``,
    `- Findings booked: **${sorted.length}**`,
  ];

  const sevParts = SEV_ORDER.filter((s) => counts[s]).map((s) => `${s}: ${counts[s]}`);
  if (sevParts.length) lines.push(`- By severity: ${sevParts.join(", ")}`);
  lines.push("");
  if (sorted.length) {
    lines.push("Top issues (by severity order):");
    for (const f of sorted.slice(0, 8)) {
      lines.push(`- **[${findingSeverity(f)}]** ${findingTitle(f)}`);
    }
    lines.push("");
  } else {
    lines.push("_No confirmed findings were provided for this report._", "");
  }

  lines.push(
    "## 2. Scope and method",
    "",
    input.methodNote?.trim() ||
      "Authorized assessment within the stated scope. Issues below are derived only from booked findings with evidence references supplied to the report builder. No vulnerability classes were invented beyond the input set.",
    "",
    "## 3. Findings",
    "",
  );

  if (!sorted.length) {
    lines.push("_None._", "");
  } else {
    sorted.forEach((f, i) => {
      const n = i + 1;
      const loc = locationOf(f);
      const desc = descriptionOf(f);
      const poc = pocOf(f);
      const rem = String(f.remediation || "").trim();
      const eids = evidenceIdsOf(f);
      const cve = String(f.cve_id || f.cve || "").trim();
      const cwe = String(f.cwe || "").trim();

      lines.push(`### 3.${n} ${findingTitle(f)}`, "");
      lines.push(`- Severity: \`${findingSeverity(f)}\``);
      if (f.status) lines.push(`- Status: \`${f.status}\``);
      if (loc) lines.push(`- Location: \`${loc}\``);
      if (cwe) lines.push(`- CWE: \`${cwe}\``);
      if (cve) lines.push(`- CVE: \`${cve}\``);
      else lines.push("- CVE: _(none in source data)_");
      lines.push("");
      lines.push("**Description**", "");
      lines.push(desc || "_No description provided in finding record._", "");
      lines.push("**Reproduction / PoC**", "");
      lines.push(poc || "_No PoC text in finding record; see evidence ids._", "");
      lines.push("**Remediation**", "");
      lines.push(rem || "_No remediation text in finding record._", "");
      if (eids.length) {
        lines.push("**Evidence ids**", "");
        for (const id of eids) {
          const ev = input.evidenceById?.[id];
          if (ev == null) {
            lines.push(`- \`${id}\``);
          } else if (typeof ev === "string") {
            lines.push(`- \`${id}\`: ${ev.slice(0, 240)}`);
          } else {
            const sum = String(ev.summary || ev.type || "").trim();
            lines.push(`- \`${id}\`${sum ? `: ${sum.slice(0, 240)}` : ""}`);
          }
        }
        lines.push("");
      }
    });
  }

  lines.push("## 4. Remediation roadmap", "");
  const critHigh = sorted.filter((f) => ["critical", "high"].includes(findingSeverity(f)));
  const med = sorted.filter((f) => findingSeverity(f) === "medium");
  const low = sorted.filter((f) => ["low", "info", "unknown"].includes(findingSeverity(f)));
  lines.push("- **P0 (critical/high):** " + (critHigh.map(findingTitle).join("; ") || "_none_"));
  lines.push("- **P1 (medium):** " + (med.map(findingTitle).join("; ") || "_none_"));
  lines.push("- **P2 (low/info):** " + (low.map(findingTitle).join("; ") || "_none_"));
  lines.push("");

  lines.push("## 5. Appendix — finding titles", "");
  if (!sorted.length) {
    lines.push("_Empty._");
  } else {
    sorted.forEach((f, i) => {
      lines.push(`${i + 1}. [${findingSeverity(f)}] ${findingTitle(f)}`);
    });
  }
  lines.push("");

  return lines.join("\n");
}

/** Load finding JSON files from a directory (node task `findings/`). */
export async function loadFindingsFromDir(
  dir: string,
  readFile: (path: string) => Promise<string>,
  readdir: (path: string) => Promise<string[]>,
): Promise<FindingLike[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: FindingLike[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const raw = await readFile(`${dir.replace(/\/$/, "")}/${name}`);
      const o = JSON.parse(raw) as FindingLike;
      if (o && (o.title || o.name)) out.push(o);
    } catch {
      /* skip bad files */
    }
  }
  return out;
}
