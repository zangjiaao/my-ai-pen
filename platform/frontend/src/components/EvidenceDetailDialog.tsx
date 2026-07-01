import { useEffect, useState } from "react";
import { authFetch } from "../lib/api";
import { asString, shortId, type SecurityEvidence } from "../lib/securityTypes";

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
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load evidence"))
      .finally(() => setLoading(false));
  }, [open, id, initial]);

  if (!open) return null;
  const evidence = detail || normalizeInitial(initial);
  const properties = evidence?.properties || {};

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4" onClick={onClose}>
      <div className="max-h-[88vh] w-full max-w-3xl overflow-y-auto rounded-lg border border-hairline-soft bg-canvas p-6 shadow-xl" onClick={(event) => event.stopPropagation()}>
        <div className="mb-4 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="break-all font-mono text-lg font-semibold">{asString(evidence?.evidence_id || evidence?.id, "Evidence detail")}</h2>
            <div className="mt-2 flex flex-wrap gap-2 text-xs text-ink-muted">
              <span>{asString(evidence?.type)}</span>
              <span>{asString(evidence?.source_tool)}</span>
              {loading && <span>Loading...</span>}
            </div>
          </div>
          <button onClick={onClose} className="rounded-md border border-hairline px-3 py-1.5 text-xs hover:bg-surface-default">Close</button>
        </div>

        {error && <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

        <div className="grid gap-3 md:grid-cols-4">
          <Info label="Session" value={shortId(evidence?.conversation_id)} />
          <Info label="Node" value={shortId(evidence?.node_id)} />
          <Info label="Tool Run" value={shortId(evidence?.tool_run_id)} />
          <Info label="Created" value={evidence?.created_at?.slice(0, 19) || "-"} />
        </div>

        <section className="mt-5">
          <h3 className="mb-2 text-xs font-semibold uppercase text-ink-secondary">Summary</h3>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-canvas-inset p-3 font-mono text-xs [overflow-wrap:anywhere]">{evidence?.summary || "-"}</pre>
        </section>

        <div className="mt-5 grid gap-3 md:grid-cols-2">
          <InfoBlock label="Raw Ref" value={evidence?.raw_ref} />
          <InfoBlock label="Hash" value={evidence?.hash} />
        </div>

        <section className="mt-5">
          <h3 className="mb-2 text-xs font-semibold uppercase text-ink-secondary">Metadata</h3>
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-canvas-inset p-3 font-mono text-xs [overflow-wrap:anywhere]">{JSON.stringify(properties, null, 2)}</pre>
        </section>
      </div>
    </div>
  );
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
    <div className="rounded-md bg-canvas-inset p-2">
      <div className="text-xs text-ink-muted">{label}</div>
      <div className="mt-1 truncate font-mono text-xs">{value || "-"}</div>
    </div>
  );
}

function InfoBlock({ label, value }: { label: string; value?: string | null }) {
  return (
    <section>
      <h3 className="mb-1 text-xs font-semibold uppercase text-ink-secondary">{label}</h3>
      <p className="break-all rounded-md bg-canvas-inset p-3 font-mono text-xs text-ink-secondary">{value || "-"}</p>
    </section>
  );
}