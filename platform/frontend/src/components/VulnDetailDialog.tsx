import { useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { authFetch } from "../lib/api";
import { evidenceCardPreview, type EvidenceLike } from "../lib/evidenceDisplay";
import { asString, type SecurityEvidence, type SecurityVulnerability } from "../lib/securityTypes";

interface Props {
  open: boolean;
  vulnerabilityId?: string | null;
  initial?: Partial<SecurityVulnerability> | null;
  /** Current conversation / session display name when available. */
  sessionName?: string | null;
  onClose: () => void;
  onUpdated?: (vulnerability: SecurityVulnerability) => void;
  onRetestCreated?: (conversationId: string) => void;
  onOpenEvidence?: (evidence: Partial<SecurityEvidence>) => void;
}

type RetestResponse = {
  conversation_id: string;
  started: boolean;
  target: Record<string, unknown>;
  scope: Record<string, unknown>;
  instruction: string;
  message: string;
};

const ACTIVE_CONVERSATION_KEY = "active_conversation_id";

const SEVERITY_CLASSES: Record<string, string> = {
  critical: "bg-severity-critical-subtle text-severity-critical",
  high: "bg-severity-high-subtle text-severity-high",
  medium: "bg-severity-medium-subtle text-severity-medium",
  low: "bg-severity-low-subtle text-severity-low",
  info: "bg-canvas-inset text-ink-secondary",
};

export default function VulnDetailDialog({
  open,
  vulnerabilityId,
  initial,
  sessionName,
  onClose,
  onRetestCreated,
  onOpenEvidence,
}: Props) {
  const navigate = useNavigate();
  const [detail, setDetail] = useState<SecurityVulnerability | null>(null);
  const [loading, setLoading] = useState(false);
  const [retesting, setRetesting] = useState(false);
  const [savingStatus, setSavingStatus] = useState(false);
  const [error, setError] = useState("");

  const id = vulnerabilityId || initial?.id || initial?.vulnerability_id || null;

  const LIFECYCLE_LABELS: Record<string, string> = {
    to_fix: "待修复",
    fixing: "修复中",
    fixed: "已修复",
  };

  const normalizeLifecycle = (status?: string | null): string => {
    const s = String(status || "").toLowerCase();
    if (
      ["to_fix", "pending", "confirmed", "open", "candidate", "ignored", "accepted", "false_positive", "risk_accepted"].includes(
        s,
      )
    ) {
      return "to_fix";
    }
    if (["fixing", "reported", "in_progress", "retest"].includes(s)) return "fixing";
    if (["fixed", "closed"].includes(s)) return "fixed";
    return s || "to_fix";
  };

  useEffect(() => {
    if (!open) return;
    setError("");
    setDetail(normalizeInitial(initial));
    // Session findings use synthetic ids (finding:...) — no platform vuln record to fetch.
    if (!id || String(id).startsWith("finding:")) return;
    setLoading(true);
    authFetch<SecurityVulnerability>(`/api/vulnerabilities/${id}`)
      .then(setDetail)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load vulnerability"))
      .finally(() => setLoading(false));
  }, [open, id, initial]);

  const vulnerability = detail || normalizeInitial(initial);

  if (!open) return null;

  const startRetest = async () => {
    if (!id) return;
    try {
      setError("");
      setRetesting(true);
      const result = await authFetch<RetestResponse>(`/api/vulnerabilities/${id}/retest`, { method: "POST" });
      localStorage.setItem(ACTIVE_CONVERSATION_KEY, result.conversation_id);
      onRetestCreated?.(result.conversation_id);
      onClose();
      navigate("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "复测启动失败");
    } finally {
      setRetesting(false);
    }
  };

  const updateStatus = async (next: string) => {
    if (!id) return;
    setSavingStatus(true);
    setError("");
    try {
      const updated = await authFetch<SecurityVulnerability>(`/api/vulnerabilities/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next }),
      });
      setDetail(updated);
      onUpdated?.(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "状态更新失败");
    } finally {
      setSavingStatus(false);
    }
  };

  const findingKind = resolveDetailKind(vulnerability, initial);
  const flagToken = extractDetailFlagToken(vulnerability, initial);
  const keySub = detailAuthSubtype(vulnerability, initial);
  const headline =
    findingKind === "flag"
      ? flagToken || asString(vulnerability?.title, "Captured flag")
      : asString(vulnerability?.title, findingKind === "key" ? "Credential" : "Untitled vulnerability");
  const badgeLabel =
    findingKind === "vuln"
      ? normalizeSeverity(vulnerability?.severity)
      : findingKind === "flag"
        ? "Flag"
        : keySub.label;
  const badgeClass =
    findingKind === "vuln"
      ? SEVERITY_CLASSES[normalizeSeverity(vulnerability?.severity)] || SEVERITY_CLASSES.info
      : findingKind === "flag"
        ? "bg-status-success/15 text-status-success"
        : keySub.badgeClass;

  const sessionLabel = asString(
    sessionName
      || (initial as { conversation_title?: string } | null)?.conversation_title
      || (vulnerability as { conversation_title?: string } | null)?.conversation_title
      || (vulnerability?.conversation_id ? shortSessionId(vulnerability.conversation_id) : ""),
    "—",
  );
  const agentName = asString(vulnerability?.agent_name || vulnerability?.agent_id, "—");
  const discoveredAt = formatDetailTime(vulnerability?.discovered_at || vulnerability?.timestamp);

  const method = vulnerability?.method ? String(vulnerability.method).toUpperCase() : "";
  // Prefer Surface-tree aligned path (set when finding is hung on the panel).
  const surfaceFromPanel = String(
    (vulnerability as { __surface_display?: string } | null)?.__surface_display
      || (initial as { __surface_display?: string } | null)?.__surface_display
      || "",
  ).trim();
  const surfaceFromUrl = (() => {
    const raw = String(vulnerability?.endpoint || vulnerability?.location || vulnerability?.url || "").trim();
    if (!raw) return "";
    try {
      if (/^https?:\/\//i.test(raw)) {
        const token = raw.match(/^https?:\/\/\S+/i)?.[0] || raw;
        const u = new URL(token);
        const origin = `${u.hostname}${u.port ? `:${u.port}` : ""}`;
        let path = u.pathname || "/";
        if (path.length > 1) path = path.replace(/\/+$/, "");
        return path === "/" ? origin : `${origin}${path}`;
      }
    } catch {
      /* ignore */
    }
    if (raw.startsWith("/")) return raw.split(/[?#]/)[0] || raw;
    return raw;
  })();
  const surfaceLine = surfaceFromPanel || [method, surfaceFromUrl].filter(Boolean).join(" ") || "—";

  const descriptionRaw = String(
    vulnerability?.description || vulnerability?.impact || "",
  ).trim();
  const { narrative: descriptionNarrative, proof: proofFromDescription } =
    splitDescriptionAndProof(descriptionRaw);
  const pocText = String(vulnerability?.poc || "").trim();
  const description = descriptionRaw || pocText;
  const highlightTokens = collectHighlightTokens(findingKind, flagToken, description, vulnerability);

  const timelineEvents = buildDetailTimeline(vulnerability);
  const evidenceItems = vulnerability?.evidence?.length
    ? vulnerability.evidence
    : (vulnerability?.evidence_ids || []).map((evidenceId) => ({
        id: evidenceId,
        evidence_id: evidenceId,
        type: "evidence",
        summary: evidenceId,
      }));
  const canMutate = Boolean(id && !String(id).startsWith("finding:"));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4" onClick={onClose}>
      <div
        className="max-h-[88vh] w-full max-w-3xl overflow-y-auto rounded-lg border border-hairline-soft bg-canvas p-6 shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        {/* 1. Name + badge */}
        <div className="mb-4 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className={`inline-block shrink-0 rounded-md px-2.5 py-0.5 font-mono text-[11px] font-medium uppercase ${badgeClass}`}>
                {badgeLabel}
              </span>
              <h2 className={`min-w-0 break-words text-xl font-semibold ${findingKind === "flag" ? "font-mono" : ""}`}>
                {headline}
              </h2>
            </div>
            {loading && <p className="mt-1 text-xs text-ink-muted">Loading...</p>}
          </div>
          <div className="flex flex-shrink-0 gap-2">
            {canMutate && findingKind === "vuln" && (
              <button
                onClick={() => void startRetest()}
                disabled={retesting}
                className="rounded-md bg-ink px-3 py-1.5 text-xs text-white disabled:opacity-60"
              >
                {retesting ? "启动中…" : "复测"}
              </button>
            )}
            <button
              onClick={onClose}
              className="rounded-md border border-hairline px-3 py-1.5 text-xs hover:bg-surface-default"
            >
              关闭
            </button>
          </div>
        </div>

        {/* Lifecycle status */}
        {canMutate && (
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <span className="text-xs text-ink-muted">处理状态</span>
            {(["to_fix", "fixing", "fixed"] as const).map((st) => {
              const current = normalizeLifecycle(vulnerability?.status);
              const allowed =
                (vulnerability as { allowed_next_statuses?: string[] } | null)?.allowed_next_statuses ||
                [];
              const canSelect = st === current || allowed.includes(st) || allowed.length === 0;
              return (
                <button
                  key={st}
                  type="button"
                  disabled={savingStatus || !canSelect}
                  onClick={() => {
                    if (st !== current) void updateStatus(st);
                  }}
                  className={`rounded-md border px-2.5 py-1 text-[11px] font-medium disabled:opacity-40 ${
                    st === current
                      ? "border-ink bg-ink text-white"
                      : "border-hairline text-ink-secondary hover:bg-surface-default"
                  }`}
                >
                  {LIFECYCLE_LABELS[st]}
                </button>
              );
            })}
          </div>
        )}

        {error && !String(error).toLowerCase().includes("not found") && (
          <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
        )}

        {/* 2. Session · Agent · Discovered */}
        <section className="grid gap-3 sm:grid-cols-3">
          <Info label="Session" value={sessionLabel} />
          <Info label="Agent" value={agentName} />
          <Info label="Discovered" value={discoveredAt} />
        </section>

        {/* 3. Description — highlight FLAG / KEY material */}
        <section className="mt-5">
          <h3 className="mb-2 text-xs font-semibold uppercase text-ink-secondary">Description</h3>
          {findingKind === "flag" && flagToken && (
            <div className="mb-3 rounded-md border border-status-success/30 bg-status-success/10 px-3 py-2.5">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-status-success">Flag</p>
              <p className="mt-1 break-all font-mono text-sm font-semibold text-ink">{flagToken}</p>
            </div>
          )}
          {findingKind === "key" && highlightTokens.keySnippet && (
            <div className="mb-3 rounded-md border border-status-running/25 bg-status-running/10 px-3 py-2.5">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-status-running">{keySub.label}</p>
              <p className="mt-1 break-all font-mono text-sm font-medium text-ink">{highlightTokens.keySnippet}</p>
            </div>
          )}
          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-ink-secondary">
            {descriptionNarrative
              ? renderHighlightedDescription(descriptionNarrative, findingKind, flagToken)
              : "—"}
          </p>
        </section>

        {/* 3b. PoC — reproduction + observed result (proof of existence) */}
        {pocText && (
          <section className="mt-5">
            <h3 className="mb-2 text-xs font-semibold uppercase text-ink-secondary">Proof of concept</h3>
            <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md bg-canvas-inset p-3 font-mono text-xs leading-relaxed text-ink-secondary">
              {pocText}
            </pre>
          </section>
        )}

        {/* 3c. Captured proof excerpts from linked evidence */}
        {proofFromDescription && (
          <section className="mt-5">
            <h3 className="mb-2 text-xs font-semibold uppercase text-ink-secondary">Captured proof</h3>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border border-hairline-soft bg-canvas p-3 font-mono text-xs leading-relaxed text-ink">
              {proofFromDescription}
            </pre>
          </section>
        )}

        {/* 4. Attack surface — same identity as right-panel Surface tree node */}
        <section className="mt-5">
          <h3 className="mb-2 text-xs font-semibold uppercase text-ink-secondary">Attack surface</h3>
          <p className="break-all font-mono text-sm leading-relaxed text-ink-secondary">{surfaceLine}</p>
        </section>

        {/* 5. Evidence */}
        <section className="mt-5">
          <h3 className="mb-2 text-xs font-semibold uppercase text-ink-secondary">Evidence</h3>
          <div className="space-y-2">
            {evidenceItems.map((item, index) => {
              const preview = evidenceCardPreview(item as EvidenceLike);
              const thin = !item.summary || preview.detail === "Evidence" || preview.title === item.evidence_id;
              return (
                <button
                  key={item.id || item.evidence_id || index}
                  type="button"
                  onClick={() => onOpenEvidence?.(item)}
                  className="block w-full rounded-md border border-hairline-soft p-3 text-left transition-colors hover:bg-surface-default"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="shrink-0 rounded-md bg-canvas-inset px-2 py-0.5 font-mono text-[10px] font-medium uppercase text-ink-secondary">
                      {preview.badge}
                    </span>
                    <span className="min-w-0 truncate text-sm font-medium text-ink">{preview.title}</span>
                  </div>
                  <p className="mt-1.5 line-clamp-2 break-words text-xs text-ink-muted">
                    {thin
                      ? "Reference recorded (raw request not captured yet)"
                      : preview.detail}
                  </p>
                </button>
              );
            })}
            {!evidenceItems.length && (
              <div className="rounded-md bg-canvas-inset p-3 text-xs text-ink-muted">
                No evidence linked. Agents should attach HTTP/tool evidence when confirming findings.
              </div>
            )}
          </div>
        </section>

        {/* 6. Timeline axis — dots and rail centered in a fixed column */}
        <section className="mt-5">
          <h3 className="mb-3 text-xs font-semibold uppercase text-ink-secondary">Timeline</h3>
          {timelineEvents.length ? (
            <div>
              {timelineEvents.map((event, index) => {
                const isLast = index === timelineEvents.length - 1;
                return (
                  <div key={index} className="flex gap-3">
                    <div className="flex w-3 shrink-0 flex-col items-center">
                      <span
                        aria-hidden
                        className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full bg-ink-muted"
                      />
                      {!isLast && (
                        <span aria-hidden className="mt-1 w-px flex-1 min-h-[1.25rem] bg-hairline" />
                      )}
                    </div>
                    <div className={`min-w-0 ${isLast ? "pb-0" : "pb-4"}`}>
                      <p className="text-sm font-medium leading-snug text-ink">{event.label}</p>
                      <p className="mt-0.5 font-mono text-[11px] text-ink-muted">{event.at}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-sm text-ink-muted">No timeline events</p>
          )}
        </section>
      </div>
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-canvas-inset p-2.5">
      <div className="text-xs text-ink-muted">{label}</div>
      <div className="mt-1 break-all font-mono text-xs text-ink">{value || "—"}</div>
    </div>
  );
}

/** Split agent narrative from appended [Proof] block written by platform persist. */
function splitDescriptionAndProof(raw: string): { narrative: string; proof: string } {
  const text = String(raw || "").trim();
  if (!text) return { narrative: "", proof: "" };
  const marker = "\n\n[Proof]\n";
  const idx = text.indexOf(marker);
  if (idx >= 0) {
    return {
      narrative: text.slice(0, idx).trim(),
      proof: text.slice(idx + marker.length).trim(),
    };
  }
  if (text.startsWith("[Proof]\n")) {
    return { narrative: "", proof: text.slice("[Proof]\n".length).trim() };
  }
  return { narrative: text, proof: "" };
}

function formatDetailTime(value: unknown): string {
  const raw = String(value || "").trim();
  if (!raw) return "—";
  return raw.slice(0, 19).replace("T", " ");
}

function shortSessionId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

function collectHighlightTokens(
  kind: DetailKind,
  flagToken: string,
  description: string,
  vulnerability: SecurityVulnerability | null,
): { keySnippet?: string } {
  if (kind !== "key") return {};
  const blob = [description, vulnerability?.poc, vulnerability?.title].map((v) => String(v || "")).join("\n");
  // JWT
  const jwt = blob.match(/eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/);
  if (jwt) return { keySnippet: jwt[0].length > 96 ? `${jwt[0].slice(0, 93)}…` : jwt[0] };
  // key=value or password-like short secrets
  const kv = blob.match(
    /\b(?:password|passwd|pwd|api[_-]?key|secret|token|bearer)\s*[:=]\s*([^\s,;"']{4,120})/i,
  );
  if (kv) return { keySnippet: `${kv[0].slice(0, 120)}` };
  // quoted secret
  const quoted = blob.match(/["']([A-Za-z0-9_\-./+=]{12,80})["']/);
  if (quoted) return { keySnippet: quoted[1] };
  if (description.length > 0 && description.length <= 160) return { keySnippet: description };
  return {};
}

function renderHighlightedDescription(
  text: string,
  kind: DetailKind,
  flagToken: string,
): ReactNode {
  if (kind === "flag" && flagToken) {
    const parts = text.split(flagToken);
    if (parts.length === 1) return text;
    return parts.flatMap((part, i) =>
      i === 0
        ? [part]
        : [
            <mark key={`f-${i}`} className="rounded bg-status-success/20 px-1 font-mono font-semibold text-ink">
              {flagToken}
            </mark>,
            part,
          ],
    );
  }
  // Highlight flag{...} anywhere
  const nodes: ReactNode[] = [];
  const re = /flag\{[^{}\n]{2,120}\}/gi;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    nodes.push(
      <mark key={`fl-${i++}`} className="rounded bg-status-success/20 px-1 font-mono font-semibold text-ink">
        {m[0]}
      </mark>,
    );
    last = m.index + m[0].length;
  }
  if (last === 0) return text;
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

type DetailKind = "vuln" | "flag" | "key";

type FindingExtras = {
  finding_kind?: string | null;
  kind?: string | null;
  category?: string | null;
  flag_value?: string | null;
  url?: string | null;
  target?: string | null;
  impact?: string | null;
  reproduction?: string | null;
  evidence_id?: string | null;
  __surface_kind?: string | null;
};

function resolveDetailKind(
  vulnerability: SecurityVulnerability | null,
  initial?: Partial<SecurityVulnerability> | null,
): DetailKind {
  const raw = { ...(initial || {}), ...(vulnerability || {}) } as FindingExtras & Partial<SecurityVulnerability>;
  // Prefer explicit surface-click kind so FLAG chip opens Flag detail even if record primary kind is vuln.
  const explicit = String(raw.__surface_kind || raw.finding_kind || raw.kind || raw.category || "")
    .trim()
    .toLowerCase();
  if (["flag", "flags", "ctf"].includes(explicit)) return "flag";
  if (["auth", "key", "credential", "credentials", "secret", "secrets", "password", "apikey", "api_key", "aksk"].includes(explicit)) {
    return "key";
  }
  if (["vuln", "vulnerability", "vulns"].includes(explicit)) return "vuln";
  if (extractDetailFlagToken(vulnerability, initial)) return "flag";
  return "vuln";
}

function extractDetailFlagToken(
  vulnerability: SecurityVulnerability | null,
  initial?: Partial<SecurityVulnerability> | null,
): string {
  const raw = { ...(initial || {}), ...(vulnerability || {}) } as FindingExtras & Partial<SecurityVulnerability>;
  const direct = String(raw.flag_value || "").trim();
  if (direct) return direct;
  const blob = [raw.title, raw.description, raw.poc, raw.poc_description, raw.impact, raw.reproduction, raw.location]
    .map((v) => String(v || ""))
    .join("\n");
  const m = blob.match(/flag\{[^{}\n]{2,120}\}/i) || blob.match(/FLAG\{[^{}\n]{2,120}\}/);
  return m ? m[0] : "";
}

function detailAuthSubtype(
  vulnerability: SecurityVulnerability | null,
  initial?: Partial<SecurityVulnerability> | null,
): { label: string; badgeClass: string } {
  const raw = { ...(initial || {}), ...(vulnerability || {}) } as FindingExtras & Partial<SecurityVulnerability>;
  const blob = [raw.title, raw.description, raw.poc, raw.impact, raw.location, raw.flag_value]
    .map((v) => String(v || ""))
    .join("\n")
    .toLowerCase();
  if (/\bjwt\b|\beyj[a-z0-9_-]+\./i.test(blob)) return { label: "JWT", badgeClass: "bg-status-running/12 text-status-running" };
  if (/\b(api[_-]?key|access[_-]?key|akia[0-9a-z]{12,}|ak\/sk)\b/i.test(blob)) return { label: "APIKEY", badgeClass: "bg-[#ecfeff] text-[#0e7490]" };
  if (/\b(password|passwd|pwd|密码)\b/i.test(blob)) return { label: "PASSWORD", badgeClass: "bg-[#f5f3ff] text-[#6d28d9]" };
  if (/\b(session[_-]?id|phpsessid|jsessionid)\b/i.test(blob)) return { label: "SESSION", badgeClass: "bg-[#f0fdfa] text-[#0f766e]" };
  if (/\b(bearer\s+|oauth|refresh[_-]?token|access[_-]?token)\b/i.test(blob)) return { label: "TOKEN", badgeClass: "bg-[#eef2ff] text-[#4338ca]" };
  if (/\b(private[_-]?key|secret|credential)\b/i.test(blob)) return { label: "SECRET", badgeClass: "bg-[#f8fafc] text-[#475569]" };
  return { label: "KEY", badgeClass: "bg-status-running/10 text-status-running" };
}

function buildDetailTimeline(
  vulnerability: SecurityVulnerability | null,
): Array<{ at: string; label: string }> {
  if (!vulnerability) return [];
  const events: Array<{ at: string; label: string }> = [];
  const discovered = vulnerability.discovered_at || vulnerability.timestamp;
  if (discovered) {
    events.push({ at: String(discovered).slice(0, 19).replace("T", " "), label: "Discovered" });
  }
  for (const event of vulnerability.status_timeline || []) {
    events.push({
      at: asString(event.at).slice(0, 19).replace("T", " ") || "—",
      label: asString(event.label || event.status, "Status update"),
    });
  }
  const updated = vulnerability.updated_at;
  if (updated && String(updated) !== String(discovered)) {
    events.push({ at: String(updated).slice(0, 19).replace("T", " "), label: "Updated" });
  }
  // Dedupe identical at+label
  const seen = new Set<string>();
  return events.filter((e) => {
    const k = `${e.at}|${e.label}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function normalizeInitial(initial?: Partial<SecurityVulnerability> | null): SecurityVulnerability | null {
  if (!initial) return null;
  const raw = initial as Partial<SecurityVulnerability> & FindingExtras;
  const location = initial.location || raw.url || raw.target || initial.affected_asset || initial.poc;
  const description = initial.description || raw.impact;
  const poc = initial.poc || raw.reproduction || location;
  const evidenceIds = initial.evidence_ids?.length
    ? initial.evidence_ids
    : raw.evidence_id
      ? [raw.evidence_id]
      : [];
  const kind = resolveDetailKind(null, initial);
  return {
    id: String(initial.id || initial.vulnerability_id || ""),
    vulnerability_id: initial.vulnerability_id,
    strix_vulnerability_id: initial.strix_vulnerability_id,
    conversation_id: initial.conversation_id,
    node_id: initial.node_id,
    title: asString(initial.title, kind === "flag" ? "Captured flag" : kind === "key" ? "Credential / key" : "Untitled vulnerability"),
    severity: normalizeSeverity(initial.severity),
    cvss: initial.cvss,
    cvss_breakdown: initial.cvss_breakdown,
    cve_id: initial.cve_id,
    cwe: initial.cwe,
    asset_id: initial.asset_id,
    asset: initial.asset,
    affected_asset: initial.affected_asset || raw.url || raw.target || undefined,
    target: initial.target || raw.target || raw.url || undefined,
    location: location || undefined,
    endpoint: initial.endpoint,
    method: initial.method,
    confidence: asString(initial.confidence, "medium"),
    status: asString(initial.status, "confirmed"),
    description,
    impact: initial.impact || raw.impact,
    technical_analysis: initial.technical_analysis,
    poc,
    poc_description: initial.poc_description,
    poc_script_code: initial.poc_script_code,
    remediation: initial.remediation,
    remediation_steps: initial.remediation_steps,
    agent_id: initial.agent_id,
    agent_name: initial.agent_name,
    timestamp: initial.timestamp,
    evidence_ids: evidenceIds,
    evidence: initial.evidence || [],
    status_timeline: initial.status_timeline || [],
    discovered_at: initial.discovered_at,
    updated_at: initial.updated_at,
    // Preserve kind metadata for dialog mode (not on base type; cast via spread consumers).
    ...( {
      finding_kind: raw.__surface_kind || raw.finding_kind || raw.kind || raw.category,
      flag_value: raw.flag_value || extractDetailFlagToken(null, initial) || undefined,
      reproduction: raw.reproduction,
      __surface_kind: raw.__surface_kind,
    } as object),
  } as SecurityVulnerability;
}

function normalizeSeverity(value: unknown): string {
  const severity = String(value || "info").toLowerCase();
  return ["critical", "high", "medium", "low", "info"].includes(severity) ? severity : "info";
}
