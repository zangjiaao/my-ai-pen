import { useEffect, useState } from "react";
import { authFetch } from "../lib/api";
import { asString, type SecurityEvidence } from "../lib/securityTypes";
import { parseEvidenceView, type EvidenceLike, type ParsedEvidenceView } from "../lib/evidenceDisplay";

interface Props {
  open: boolean;
  evidenceId?: string | null;
  initial?: Partial<SecurityEvidence> | null;
  onClose: () => void;
}

export default function EvidenceDetailDialog({ open, evidenceId, initial, onClose }: Props) {
  const [detail, setDetail] = useState<SecurityEvidence | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const id = evidenceId || initial?.evidence_id || initial?.id || null;

  useEffect(() => {
    if (!open) return;
    setError("");
    setDetail(normalizeInitial(initial));
    if (!id) return;
    setLoading(true);
    authFetch<SecurityEvidence>(`/api/evidence/${id}`)
      .then(setDetail)
      .catch((err) => {
        // Keep initial payload when API has no row (session-local evidence).
        if (!normalizeInitial(initial)) {
          setError(err instanceof Error ? err.message : "Failed to load evidence");
        }
      })
      .finally(() => setLoading(false));
  }, [open, id, initial]);

  if (!open) return null;
  const evidence = detail || normalizeInitial(initial);
  const view = parseEvidenceView((evidence || {}) as EvidenceLike);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4" onClick={onClose}>
      <div
        className="max-h-[88vh] w-full max-w-3xl overflow-y-auto rounded-lg border border-hairline-soft bg-canvas p-6 shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="mb-1 text-xs font-medium uppercase tracking-wide text-ink-muted">Evidence</p>
            <h2 className="break-words text-xl font-semibold">{view.title}</h2>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
              <span className={`rounded-md px-2 py-0.5 font-mono text-[11px] font-medium uppercase ${badgeClassForKind(view.kind)}`}>
                {view.badge}
              </span>
              {view.toolName && (
                <span className="rounded-md bg-canvas-inset px-2 py-0.5 text-ink-secondary">{view.toolName}</span>
              )}
              {evidence?.created_at && (
                <span className="text-ink-muted">{String(evidence.created_at).slice(0, 19).replace("T", " ")}</span>
              )}
              {loading && <span className="text-ink-muted">Loading...</span>}
            </div>
          </div>
          <button onClick={onClose} className="rounded-md border border-hairline px-3 py-1.5 text-xs hover:bg-surface-default">
            Close
          </button>
        </div>

        {error && <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

        {view.kind === "http" && view.http ? (
          <HttpEvidenceBody http={view.http} />
        ) : (
          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase text-ink-secondary">
              {view.kind === "scan" ? "Scan result" : view.kind === "browser" ? "Page observation" : "Tool output"}
            </h3>
            <pre className="max-h-[28rem] overflow-auto whitespace-pre-wrap break-words rounded-md bg-canvas-inset p-3 font-mono text-xs leading-relaxed text-ink-secondary">
              {view.bodyPreview || view.subtitle || "—"}
            </pre>
          </section>
        )}

        {evidence?.evidence_id && (
          <p className="mt-4 font-mono text-[10px] text-ink-muted">{evidence.evidence_id}</p>
        )}
      </div>
    </div>
  );
}

function HttpEvidenceBody({ http }: { http: NonNullable<ParsedEvidenceView["http"]> }) {
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Info label="Method" value={http.method || "—"} />
        <Info label="Status" value={http.status || "—"} />
        <Info label="URL" value={http.url || "—"} />
      </div>
      {(http.requestHeaders || http.requestBody) && (
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase text-ink-secondary">Request</h3>
          {http.requestHeaders && (
            <pre className="mb-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-canvas-inset p-3 font-mono text-xs text-ink-secondary">
              {http.requestHeaders}
            </pre>
          )}
          {http.requestBody && (
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-canvas-inset p-3 font-mono text-xs text-ink-secondary">
              {http.requestBody}
            </pre>
          )}
        </section>
      )}
      {(http.responseHeaders || http.responseBody || http.status) && (
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase text-ink-secondary">Response</h3>
          {http.responseHeaders && (
            <pre className="mb-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-canvas-inset p-3 font-mono text-xs text-ink-secondary">
              {http.responseHeaders}
            </pre>
          )}
          {http.responseBody && (
            <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md bg-canvas-inset p-3 font-mono text-xs text-ink-secondary">
              {http.responseBody}
            </pre>
          )}
          {!http.responseHeaders && !http.responseBody && http.status && (
            <p className="text-sm text-ink-secondary">HTTP {http.status}</p>
          )}
        </section>
      )}
    </div>
  );
}

function badgeClassForKind(kind: ParsedEvidenceView["kind"]): string {
  if (kind === "http") return "bg-status-running/12 text-status-running";
  if (kind === "scan") return "bg-[#f5f3ff] text-[#6d28d9]";
  if (kind === "browser") return "bg-[#f0fdfa] text-[#0f766e]";
  return "bg-canvas-inset text-ink-secondary";
}

function normalizeInitial(initial?: Partial<SecurityEvidence> | null): SecurityEvidence | null {
  if (!initial) return null;
  return {
    id: String(initial.id || initial.evidence_id || ""),
    evidence_id: String(initial.evidence_id || initial.id || ""),
    conversation_id: initial.conversation_id,
    node_id: initial.node_id,
    type: asString(initial.type, "evidence"),
    source_tool: initial.source_tool,
    tool_run_id: initial.tool_run_id,
    raw_ref: initial.raw_ref,
    summary: initial.summary,
    hash: initial.hash,
    properties: initial.properties || {},
    created_at: initial.created_at,
  };
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-canvas-inset p-2.5">
      <div className="text-xs text-ink-muted">{label}</div>
      <div className="mt-1 break-all font-mono text-xs text-ink">{value || "—"}</div>
    </div>
  );
}
