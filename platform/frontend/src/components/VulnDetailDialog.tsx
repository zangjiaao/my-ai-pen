import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { authFetch } from "../lib/api";
import { asString, shortId, type SecurityEvidence, type SecurityVulnerability } from "../lib/securityTypes";

interface Props {
  open: boolean;
  vulnerabilityId?: string | null;
  initial?: Partial<SecurityVulnerability> | null;
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

const NEXT_STATUS: Record<string, string[]> = {
  pending: ["confirmed", "accepted", "false_positive"],
  confirmed: ["reported", "fixed", "accepted", "false_positive", "pending"],
  reported: ["fixed", "accepted", "confirmed"],
  fixed: ["confirmed", "reported"],
  accepted: ["confirmed", "fixed"],
  false_positive: ["pending", "confirmed"],
};

export default function VulnDetailDialog({ open, vulnerabilityId, initial, onClose, onUpdated, onRetestCreated, onOpenEvidence }: Props) {
  const navigate = useNavigate();
  const [detail, setDetail] = useState<SecurityVulnerability | null>(null);
  const [loading, setLoading] = useState(false);
  const [retesting, setRetesting] = useState(false);
  const [error, setError] = useState("");

  const id = vulnerabilityId || initial?.id || initial?.vulnerability_id || null;

  useEffect(() => {
    if (!open) return;
    setError("");
    setDetail(normalizeInitial(initial));
    if (!id) return;
    setLoading(true);
    authFetch<SecurityVulnerability>(`/api/vulnerabilities/${id}`)
      .then(setDetail)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load vulnerability"))
      .finally(() => setLoading(false));
  }, [open, id, initial]);

  const vulnerability = detail || normalizeInitial(initial);
  const statusOptions = useMemo(() => NEXT_STATUS[vulnerability?.status || ""] || [], [vulnerability?.status]);

  if (!open) return null;

  const updateStatus = async (nextStatus: string) => {
    if (!id) return;
    try {
      setError("");
      const updated = await authFetch<SecurityVulnerability>(`/api/vulnerabilities/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: nextStatus }),
      });
      setDetail(updated);
      onUpdated?.(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Status update failed");
    }
  };

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
      setError(err instanceof Error ? err.message : "Retest failed");
    } finally {
      setRetesting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4" onClick={onClose}>
      <div className="max-h-[88vh] w-full max-w-3xl overflow-y-auto rounded-lg border border-hairline-soft bg-canvas p-6 shadow-xl" onClick={(event) => event.stopPropagation()}>
        <div className="mb-4 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="break-words text-xl font-semibold">{asString(vulnerability?.title, "Vulnerability detail")}</h2>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <SeverityBadge severity={asString(vulnerability?.severity, "info")} />
              <span className="rounded-md bg-canvas-inset px-2 py-0.5 text-xs text-ink-secondary">{asString(vulnerability?.status, "pending")}</span>
              {loading && <span className="text-xs text-ink-muted">Loading...</span>}
            </div>
          </div>
          <div className="flex flex-shrink-0 gap-2">
            {id && <button onClick={() => void startRetest()} disabled={retesting} className="rounded-md bg-ink px-3 py-1.5 text-xs text-white disabled:opacity-60">{retesting ? "Starting..." : "Retest"}</button>}
            <button onClick={onClose} className="rounded-md border border-hairline px-3 py-1.5 text-xs hover:bg-surface-default">Close</button>
          </div>
        </div>

        {error && <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

        <div className="grid gap-3 md:grid-cols-4">
          <Info label="Session" value={shortId(vulnerability?.conversation_id)} />
          <Info label="Node" value={shortId(vulnerability?.node_id)} />
          <Info label="Confidence" value={asString(vulnerability?.confidence)} />
          <Info label="CVSS" value={vulnerability?.cvss == null ? "-" : String(vulnerability.cvss)} />
          <Info label="Discovered" value={vulnerability?.discovered_at?.slice(0, 19) || "-"} />
          <Info label="Updated" value={vulnerability?.updated_at?.slice(0, 19) || "-"} />
        </div>

        <section className="mt-5">
          <h3 className="mb-2 text-xs font-semibold uppercase text-ink-secondary">Affected Asset</h3>
          {vulnerability?.asset ? (
            <div className="rounded-md bg-canvas-inset p-3 text-sm">
              <div className="font-medium">{vulnerability.asset.name}</div>
              <div className="break-all font-mono text-xs text-ink-muted">{vulnerability.asset.address}</div>
              <div className="mt-1 text-xs text-ink-muted">{vulnerability.asset.type}</div>
            </div>
          ) : (
            <p className="break-all text-sm text-ink-secondary">{asString(vulnerability?.affected_asset || vulnerability?.asset_id)}</p>
          )}
        </section>

        <div className="mt-5 space-y-4 text-sm">
          <TextBlock title="Location" value={vulnerability?.location || vulnerability?.poc} />
          <TextBlock title="Description / Impact" value={vulnerability?.description} />
          <TextBlock title="Reproduction / POC" value={vulnerability?.poc || vulnerability?.location} code />
          <TextBlock title="Remediation" value={vulnerability?.remediation} />
        </div>

        <section className="mt-5">
          <h3 className="mb-2 text-xs font-semibold uppercase text-ink-secondary">Evidence</h3>
          <div className="space-y-2">
            {vulnerability?.evidence?.map((item) => (
              <button key={item.id || item.evidence_id} type="button" onClick={() => onOpenEvidence?.(item)} className="block w-full rounded-md border border-hairline-soft p-2 text-left transition-colors hover:bg-surface-default">
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="font-mono text-ink-secondary">{item.evidence_id}</span>
                  <span className="text-ink-muted">{item.source_tool || item.type}</span>
                </div>
                <p className="mt-1 max-h-28 overflow-auto whitespace-pre-wrap break-words text-xs text-ink-secondary">{item.summary || item.raw_ref || item.hash || "-"}</p>
                <EvidenceMetadata item={item} />
              </button>
            ))}
            {!vulnerability?.evidence?.length && (
              vulnerability?.evidence_ids?.length ? (
                <div className="space-y-2">
                  {vulnerability.evidence_ids.map((evidenceId) => (
                    <button
                      key={evidenceId}
                      type="button"
                      onClick={() => onOpenEvidence?.({ evidence_id: evidenceId, id: evidenceId, type: "evidence" })}
                      className="block w-full rounded-md border border-hairline-soft p-2 text-left font-mono text-xs text-ink-secondary transition-colors hover:bg-surface-default"
                    >
                      {evidenceId}
                    </button>
                  ))}
                </div>
              ) : (
                <div className="rounded-md bg-canvas-inset p-3 text-xs text-ink-muted">No evidence references</div>
              )
            )}
          </div>
        </section>


        <section className="mt-5">
          <h3 className="mb-2 text-xs font-semibold uppercase text-ink-secondary">Status Timeline</h3>
          <div className="space-y-2">
            {(vulnerability?.status_timeline || []).map((event, index) => (
              <div key={index} className="rounded-md border border-hairline-soft p-2 text-xs">
                <div className="font-medium">{asString(event.label || event.status)}</div>
                <div className="mt-1 font-mono text-ink-muted">{asString(event.at)}</div>
              </div>
            ))}
            {!vulnerability?.status_timeline?.length && <p className="text-sm text-ink-muted">No status events recorded</p>}
          </div>
        </section>
        <section className="mt-5">
          <h3 className="mb-2 text-xs font-semibold uppercase text-ink-secondary">Lifecycle</h3>
          <div className="flex flex-wrap gap-2">
            {id && statusOptions.map((status) => (
              <button key={status} onClick={() => void updateStatus(status)} className="rounded-md border border-hairline px-3 py-1.5 text-xs hover:bg-surface-default">{status}</button>
            ))}
            {!id && <span className="text-xs text-ink-muted">Persisted vulnerability id is not available for status changes.</span>}
          </div>
        </section>
      </div>
    </div>
  );
}

function normalizeInitial(initial?: Partial<SecurityVulnerability> | null): SecurityVulnerability | null {
  if (!initial) return null;
  const raw = initial as Partial<SecurityVulnerability> & {
    url?: string | null;
    target?: string | null;
    impact?: string | null;
    reproduction?: string | null;
    evidence_id?: string | null;
  };
  const location = initial.location || raw.url || raw.target || initial.affected_asset || initial.poc;
  const description = initial.description || raw.impact;
  const poc = initial.poc || raw.reproduction || location;
  const evidenceIds = initial.evidence_ids?.length
    ? initial.evidence_ids
    : raw.evidence_id
      ? [raw.evidence_id]
      : [];
  return {
    id: String(initial.id || initial.vulnerability_id || ""),
    vulnerability_id: initial.vulnerability_id,
    conversation_id: initial.conversation_id,
    node_id: initial.node_id,
    title: asString(initial.title, "Untitled vulnerability"),
    severity: normalizeSeverity(initial.severity),
    asset_id: initial.asset_id,
    asset: initial.asset,
    affected_asset: initial.affected_asset || raw.url || raw.target || undefined,
    location: location || undefined,
    confidence: asString(initial.confidence, "medium"),
    status: asString(initial.status, "pending"),
    description,
    poc,
    remediation: initial.remediation,
    evidence_ids: evidenceIds,
    evidence: initial.evidence || [],
    status_timeline: initial.status_timeline || [],
    discovered_at: initial.discovered_at,
    updated_at: initial.updated_at,
  };
}

function EvidenceMetadata({ item }: { item: NonNullable<SecurityVulnerability["evidence"]>[number] }) {
  const props = item.properties || {};
  const entries = [
    ["raw", item.raw_ref],
    ["hash", item.hash],
    ["method", props.method],
    ["url", props.url],
    ["status", props.status_code || props.status],
    ["placeholder", props.placeholder === true ? "yes" : ""],
  ].filter(([, value]) => value !== undefined && value !== null && value !== "");
  if (!entries.length) return null;
  return (
    <div className="mt-2 grid gap-1 rounded-md bg-canvas-inset p-2 font-mono text-[11px] text-ink-muted">
      {entries.map(([key, value]) => (
        <div key={String(key)} className="grid grid-cols-[72px_minmax(0,1fr)] gap-2">
          <span className="uppercase text-ink-muted">{String(key)}</span>
          <span className="break-all text-ink-secondary">{asString(value)}</span>
        </div>
      ))}
    </div>
  );
}

function SeverityBadge({ severity }: { severity: string }) {
  const normalized = normalizeSeverity(severity);
  return <span className={`rounded-md px-2.5 py-0.5 font-mono text-[11px] font-medium uppercase ${SEVERITY_CLASSES[normalized] || SEVERITY_CLASSES.info}`}>{normalized}</span>;
}

function normalizeSeverity(value: unknown): string {
  const severity = String(value || "info").toLowerCase();
  return ["critical", "high", "medium", "low", "info"].includes(severity) ? severity : "info";
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-canvas-inset p-2">
      <div className="text-xs text-ink-muted">{label}</div>
      <div className="mt-1 truncate font-mono text-xs">{value || "-"}</div>
    </div>
  );
}

function TextBlock({ title, value, code = false }: { title: string; value?: string | null; code?: boolean }) {
  return (
    <section>
      <h3 className="mb-1 text-xs font-semibold uppercase text-ink-secondary">{title}</h3>
      {code ? (
        <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-words rounded-md bg-canvas-inset p-3 font-mono text-xs">{value || "-"}</pre>
      ) : (
        <p className="whitespace-pre-wrap break-words text-ink-secondary">{value || "-"}</p>
      )}
    </section>
  );
}
