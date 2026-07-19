/**
 * Shared finding card — same visual as conversation RightPanel Findings list.
 * Exclusive kinds: Vuln | Key | Flag (one badge each).
 */
import type { SecurityVulnerability } from "../../lib/securityTypes";

export type FindingKindId = "vuln" | "auth" | "flag";

type FindingLike = Record<string, unknown> | Partial<SecurityVulnerability>;

interface Props {
  finding: FindingLike;
  onOpen?: (finding: Partial<SecurityVulnerability>) => void;
  className?: string;
}

export default function FindingCard({ finding, onOpen, className = "" }: Props) {
  const row = finding as Record<string, unknown>;
  const kind = classifyFindingKind(row);

  return (
    <button
      type="button"
      onClick={() =>
        onOpen?.({
          ...(row as Partial<SecurityVulnerability>),
          finding_kind: kind === "auth" ? "auth" : kind,
          kind: kind === "auth" ? "auth" : kind,
          category: kind === "auth" ? "auth" : kind,
          __surface_kind: kind === "auth" ? "key" : kind,
        } as Partial<SecurityVulnerability>)
      }
      className={`block w-full rounded-md border border-hairline-soft p-2 text-left transition-colors hover:bg-surface-default ${className}`}
    >
      <div className="mb-1 flex min-w-0 items-center gap-1">
        {kind === "vuln" ? (
          <span
            className={`inline-block shrink-0 rounded-md px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase ${severityBadgeClass(row.severity)}`}
          >
            {normalizeFindingSeverity(row.severity)}
          </span>
        ) : kind === "auth" ? (
          (() => {
            const sub = classifyAuthSubtype(row);
            return (
              <span
                className={`inline-block shrink-0 rounded-md px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase ${sub.badgeClass}`}
              >
                {sub.label}
              </span>
            );
          })()
        ) : (
          <span className="inline-block shrink-0 rounded-md bg-status-success/15 px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase text-status-success">
            Flag
          </span>
        )}
        {isMultipleDiscoveries(row) && (
          <span
            className="inline-block shrink-0 rounded-md bg-status-running/12 px-1.5 py-0.5 font-mono text-[10px] font-medium text-status-running"
            title={multipleDiscoveriesTitle(row)}
          >
            多次发现
          </span>
        )}
        <span className="truncate text-sm font-medium">{findingDisplayTitle(row, kind)}</span>
      </div>
      <p className="break-words text-xs text-ink-muted">{findingMetaLine(row, kind)}</p>
    </button>
  );
}

export function normalizeFindingSeverity(value: unknown): "critical" | "high" | "medium" | "low" | "info" {
  const s = String(value || "").trim().toLowerCase();
  if (s === "critical" || s === "crit") return "critical";
  if (s === "high") return "high";
  if (s === "medium" || s === "med" || s === "moderate") return "medium";
  if (s === "low") return "low";
  return "info";
}

export function severityBadgeClass(severity: unknown): string {
  const s = normalizeFindingSeverity(severity);
  if (s === "critical") return "bg-severity-critical-subtle text-severity-critical";
  if (s === "high") return "bg-severity-high-subtle text-severity-high";
  if (s === "medium") return "bg-severity-medium-subtle text-severity-medium";
  if (s === "low") return "bg-severity-low-subtle text-severity-low";
  return "bg-severity-info-subtle text-severity-info";
}

export type FindingKindGroup = {
  id: FindingKindId;
  label: string;
  shortLabel: string;
  hint: string;
  badgeClass: string;
  items: Array<Record<string, unknown>>;
};

function severityRank(severity: unknown): number {
  const s = normalizeFindingSeverity(severity);
  if (s === "critical") return 0;
  if (s === "high") return 1;
  if (s === "medium") return 2;
  if (s === "low") return 3;
  return 4;
}

/** Vuln list: critical → high → medium → low → info. */
export function sortFindingsBySeverity(items: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return [...items].sort((a, b) => {
    const bySev = severityRank(a.severity) - severityRank(b.severity);
    if (bySev !== 0) return bySev;
    return String(a.title || "").localeCompare(String(b.title || ""));
  });
}

/** Same exclusive groups as conversation RightPanel Findings. */
export function groupFindingsByKind(findings: Array<Record<string, unknown>>): FindingKindGroup[] {
  const buckets: Record<FindingKindId, Array<Record<string, unknown>>> = { vuln: [], auth: [], flag: [] };
  for (const finding of findings) {
    buckets[classifyFindingKind(finding)].push(finding);
  }
  return [
    {
      id: "vuln",
      label: "Vuln",
      shortLabel: "Vuln",
      hint: "by severity",
      badgeClass: "bg-severity-high-subtle text-severity-high",
      items: sortFindingsBySeverity(buckets.vuln),
    },
    {
      id: "auth",
      label: "Key",
      shortLabel: "Key",
      hint: "password · jwt · apikey · …",
      badgeClass: "bg-status-running/10 text-status-running",
      items: buckets.auth,
    },
    {
      id: "flag",
      label: "Flags",
      shortLabel: "Flag",
      hint: "CTF / challenge tokens",
      badgeClass: "bg-status-success/15 text-status-success",
      items: buckets.flag,
    },
  ];
}

/** Compact risk chips for asset table: HIGH 12 · PASSWORD 1 · FLAG 2 */
export type RiskChip = {
  key: string;
  label: string;
  count: number;
  badgeClass: string;
};

export function buildRiskChips(findings: Array<Record<string, unknown>>): RiskChip[] {
  const sevOrder = ["critical", "high", "medium", "low", "info"] as const;
  const sevCounts: Record<string, number> = {};
  const authCounts: Record<string, { count: number; badgeClass: string }> = {};
  let flagCount = 0;

  for (const finding of findings) {
    const kind = classifyFindingKind(finding);
    if (kind === "vuln") {
      const s = normalizeFindingSeverity(finding.severity);
      sevCounts[s] = (sevCounts[s] || 0) + 1;
    } else if (kind === "auth") {
      const sub = classifyAuthSubtype(finding);
      const prev = authCounts[sub.label] || { count: 0, badgeClass: sub.badgeClass };
      prev.count += 1;
      prev.badgeClass = sub.badgeClass;
      authCounts[sub.label] = prev;
    } else {
      flagCount += 1;
    }
  }

  const chips: RiskChip[] = [];
  for (const s of sevOrder) {
    const n = sevCounts[s] || 0;
    if (!n) continue;
    chips.push({
      key: `sev-${s}`,
      label: s.toUpperCase(),
      count: n,
      badgeClass: severityBadgeClass(s),
    });
  }
  // Stable subtype order similar to classify priority.
  const authOrder = ["PASSWORD", "JWT", "APIKEY", "SESSION", "TOKEN", "SECRET", "KEY"];
  const seenAuth = new Set<string>();
  for (const label of authOrder) {
    const entry = authCounts[label];
    if (!entry) continue;
    seenAuth.add(label);
    chips.push({
      key: `auth-${label}`,
      label,
      count: entry.count,
      badgeClass: entry.badgeClass,
    });
  }
  for (const [label, entry] of Object.entries(authCounts)) {
    if (seenAuth.has(label)) continue;
    chips.push({
      key: `auth-${label}`,
      label,
      count: entry.count,
      badgeClass: entry.badgeClass,
    });
  }
  if (flagCount > 0) {
    chips.push({
      key: "flag",
      label: "FLAG",
      count: flagCount,
      badgeClass: "bg-status-success/15 text-status-success",
    });
  }
  return chips;
}

function isMultipleDiscoveries(finding: Record<string, unknown>): boolean {
  if (finding.multiple_discoveries === true) return true;
  const n = Number(finding.rediscovery_count ?? 0);
  if (Number.isFinite(n) && n > 0) return true;
  const d = Number(finding.discovery_count ?? 0);
  return Number.isFinite(d) && d > 1;
}

function multipleDiscoveriesTitle(finding: Record<string, unknown>): string {
  const n = Number(finding.rediscovery_count ?? 0);
  if (Number.isFinite(n) && n > 0) return `再次确认 ${n} 次（首次之后仍未修复）`;
  return "此前已在台账中发现过，本次为再次确认";
}

function findingTextBlob(finding: Record<string, unknown>): string {
  return [
    finding.title,
    finding.description,
    finding.impact,
    finding.poc,
    finding.reproduction,
    finding.location,
    finding.flag_value,
  ]
    .map((v) => String(v || ""))
    .join("\n");
}

function extractFlagFromFinding(finding: Record<string, unknown>): string | undefined {
  const direct = String(finding.flag_value || "").trim();
  if (direct) return direct;
  const blob = [finding.title, finding.description, finding.poc, finding.reproduction, finding.impact]
    .map((v) => String(v || ""))
    .join("\n");
  const m = blob.match(/flag\{[^{}\n]{2,120}\}/i) || blob.match(/FLAG\{[^{}\n]{2,120}\}/);
  return m ? m[0] : undefined;
}

function hasFlagInFinding(finding: Record<string, unknown>): boolean {
  return Boolean(extractFlagFromFinding(finding));
}

function hasAuthInFinding(finding: Record<string, unknown>): boolean {
  const blob = findingTextBlob(finding);
  return (
    /\b(api[_-]?key|access[_-]?key|secret[_-]?key|aws[_-]?secret|private[_-]?key|akia[0-9a-z]{12,})\b/i.test(blob) ||
    /\b(password|passwd|pwd|credential|credentials)\b/i.test(blob) ||
    /\b(ak\/sk|accesskeyid|secretaccesskey)\b/i.test(blob) ||
    /\b(jwt|bearer\s+[a-z0-9._\-]+|session[_-]?id|cookie)\b/i.test(blob) ||
    /(密钥|口令|凭证|凭据)/.test(blob)
  );
}

/**
 * Attack-class signals for Vuln.
 * Note: flag{…} in PoC is loot proof, not a reason to classify as Flag.
 * Note: "challenge / level" alone is NOT enough — CTF titles often use both.
 */
function hasVulnSignalsInFinding(finding: Record<string, unknown>): boolean {
  if (finding.cwe && String(finding.cwe).trim()) return true;
  const text = findingTextBlob(finding);
  return (
    /\b(sql\s*injection|sqli|xss|cross[- ]site|rce|remote\s*code|command\s*injection|ssrf|lfi|rfi|xxe|ssti|idor|path\s*traversal|file\s*upload|deserializ|unserializ|pop\s*chain|csrf|open\s*redirect|auth(?:entication|orization)?\s*(?:bypass|flaw)|login\s*bypass|privilege\s*escalat|vertical\s*privileg|insecure|vulnerability|injection|webshell|htaccess|eval\s*\(|cmd\.php|code\.php)\b/i.test(
      text,
    ) ||
    /(漏洞|注入|越权|反序列化|命令执行|代码执行|文件上传|目录穿越|未授权|绕过|权限提升|任意文件|XSS|SSRF|RCE)/i.test(
      text,
    )
  );
}

/** Credential / secret is the primary object (Key family: PASSWORD, APIKEY, …). */
function isPrimaryKeyFinding(finding: Record<string, unknown>): boolean {
  const title = String(finding.title || "");
  // Explicit secret-leak framing in title.
  if (
    /(api\s*密钥|api[_ -]?key|access[_ -]?key|secret|密钥泄露|密码泄露|凭证泄露|公开.*密钥|hardcoded\s*(password|secret|key)|leaked\s*(password|secret|key|credential)|exposed\s*(password|secret|key)|swagger.*密钥|密钥.*swagger)/i.test(
      title,
    )
  ) {
    return true;
  }
  // Body is mostly credential material without attack-class wording.
  if (hasAuthInFinding(finding) && !hasVulnSignalsInFinding(finding)) return true;
  return false;
}

/** Finding *is* a Flag object (exclusive kind), not a Vuln that merely proved with flag{…}. */
function isPrimaryFlagFinding(finding: Record<string, unknown>): boolean {
  const title = String(finding.title || "").trim();
  if (!title) return false;
  if (/^flag\{[^{}\n]{2,120}\}$/i.test(title) || /^FLAG\{[^{}\n]{2,120}\}$/.test(title)) return true;
  // Agent/product convention: "Flag · …" / "Flag: …" is the Flag object card even when the
  // challenge name embeds "XSS"/"SQLi" (those words describe the challenge, not a Vuln kind).
  if (/^flag\s*[·•:：\-–—]/i.test(title) || /^flag\s+/i.test(title)) return true;
  if (/^(captured\s+)?flag\b/i.test(title) && !hasVulnSignalsInFinding(finding)) return true;
  // Title focuses on flag capture/value without exploit class.
  if (
    /\bflag\s*(capture|value|token|retrieved|retrieval)?\b/i.test(title) &&
    !hasVulnSignalsInFinding({ title, description: "", poc: "", impact: "" })
  ) {
    // Allow if description only adds the token.
    if (!hasVulnSignalsInFinding(finding)) return true;
  }
  // Agent explicit kind already handled; loot-only body with no attack class:
  if (hasFlagInFinding(finding) && !hasVulnSignalsInFinding(finding) && !isPrimaryKeyFinding(finding)) {
    // Prefer Flag only when title is flag-centric, not a random challenge name.
    if (/\bflag\b/i.test(title) || /^flag\{/i.test(title)) return true;
  }
  return false;
}

function normalizeExplicitKind(finding: Record<string, unknown>): FindingKindId | undefined {
  const explicit = String(finding.finding_kind || finding.kind || finding.category || "")
    .trim()
    .toLowerCase();
  if (["vuln", "vulnerability", "vulns"].includes(explicit)) return "vuln";
  if (
    ["auth", "credential", "credentials", "secret", "secrets", "password", "apikey", "api_key", "aksk", "key"].includes(
      explicit,
    )
  ) {
    return "auth";
  }
  if (["flag", "flags"].includes(explicit)) return "flag";
  return undefined;
}

/**
 * Exclusive kinds — independent finding objects:
 *   vuln  → 技术漏洞 (badge shows severity HIGH/…)
 *   auth  → Key 族 (badge shows PASSWORD / JWT / APIKEY / …)
 *   flag  → Flag 对象 (badge shows FLAG)
 *
 * CTF 里「利用漏洞拿到 flag{…}」仍是 Vuln；只有 flag 本体才是 Flag。
 */
export function classifyFindingKind(finding: Record<string, unknown>): FindingKindId {
  const explicit = normalizeExplicitKind(finding);
  if (explicit) return explicit;

  // Order: pure Flag / pure Key first, then attack-class Vuln, else Vuln default.
  if (isPrimaryFlagFinding(finding)) return "flag";
  if (isPrimaryKeyFinding(finding)) return "auth";
  if (hasVulnSignalsInFinding(finding)) return "vuln";
  return "vuln";
}

/** Shorten list titles: collapse long flag{…} tokens so tables don't blow out. */
export function displayFindingTitle(title: unknown, maxLen = 72): string {
  let text = String(title || "").replace(/\s+/g, " ").trim();
  if (!text) return "—";
  text = text.replace(/flag\{[^{}\n]{8,}\}/gi, (m) => {
    if (m.length <= 16) return m;
    return `${m.slice(0, 12)}…}`;
  });
  if (text.length > maxLen) return `${text.slice(0, maxLen - 1)}…`;
  return text;
}

export function classifyAuthSubtype(finding: Record<string, unknown>): { label: string; badgeClass: string } {
  const blob = findingTextBlob(finding).toLowerCase();
  if (/\bjwt\b|\bjson\s*web\s*token\b|\beyj[a-z0-9_-]+\.[a-z0-9_-]+/i.test(blob)) {
    return { label: "JWT", badgeClass: "bg-status-running/12 text-status-running" };
  }
  if (
    /\b(api[_-]?key|access[_-]?key|secret[_-]?key|akia[0-9a-z]{12,}|accesskeyid|secretaccesskey|ak\/sk)\b/i.test(blob)
  ) {
    return { label: "APIKEY", badgeClass: "bg-[#ecfeff] text-[#0e7490]" };
  }
  if (/\b(password|passwd|pwd|口令|密码)\b/i.test(blob)) {
    return { label: "PASSWORD", badgeClass: "bg-[#f5f3ff] text-[#6d28d9]" };
  }
  if (/\b(session[_-]?id|session[_-]?token|phpsessid|jsessionid)\b/i.test(blob)) {
    return { label: "SESSION", badgeClass: "bg-[#f0fdfa] text-[#0f766e]" };
  }
  if (/\b(bearer\s+[a-z0-9._\-]{8,}|oauth|refresh[_-]?token|access[_-]?token)\b/i.test(blob)) {
    return { label: "TOKEN", badgeClass: "bg-[#eef2ff] text-[#4338ca]" };
  }
  if (/\b(private[_-]?key|secret|credential|credentials)\b/i.test(blob)) {
    return { label: "SECRET", badgeClass: "bg-[#f8fafc] text-[#475569]" };
  }
  return { label: "KEY", badgeClass: "bg-status-running/10 text-status-running" };
}

function findingDisplayTitle(finding: Record<string, unknown>, kind: FindingKindId): string {
  if (kind === "flag") {
    const flag = extractFlagFromFinding(finding);
    if (flag) return flag;
  }
  return String(finding.title || "Untitled finding");
}

function findingMetaLine(finding: Record<string, unknown>, kind?: FindingKindId): string {
  const desc = String(finding.description || finding.impact || "").replace(/\s+/g, " ").trim();
  if (desc) return desc.length > 160 ? `${desc.slice(0, 157)}…` : desc;
  if (kind === "flag") {
    const flag = extractFlagFromFinding(finding);
    if (flag) return flag;
  }
  const port = String(finding.port || "").trim();
  const loc = String(finding.location || finding.endpoint || finding.url || "").trim();
  if (port && loc) return `:${port} · ${loc}`;
  if (port) return `端口 ${port}`;
  return loc || "";
}
