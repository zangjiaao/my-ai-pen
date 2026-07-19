import { useEffect, useState } from "react";
import { authFetch } from "../lib/api";
import { asString, type SecurityEvidence } from "../lib/securityTypes";
import { evidenceProofSteps, parseEvidenceView, type EvidenceLike, type ParsedEvidenceView } from "../lib/evidenceDisplay";

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
    <div className="fixed inset-0 z-50 flex items-center justify-center theme-overlay px-4" onClick={onClose}>
      <div
        className="max-h-[88vh] w-full max-w-3xl overflow-y-auto rounded-lg border border-hairline-soft bg-canvas p-6 shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <p className="mb-1 text-xs font-medium uppercase tracking-wide text-ink-muted">Evidence</p>
            <h2 className="break-words text-lg font-semibold leading-snug text-ink">{view.title}</h2>
            {view.subtitle && <p className="mt-1 text-xs text-ink-muted">{view.subtitle}</p>}
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
              <span className={`rounded-md px-2 py-0.5 font-mono text-[11px] font-medium uppercase ${badgeClassForKind(view.kind)}`}>
                {view.badge}
              </span>
              {view.role && (
                <span
                  className={`rounded-md px-2 py-0.5 font-mono text-[11px] uppercase ${
                    view.role === "proof" ? "bg-status-success/15 text-status-success" : "bg-canvas-inset text-ink-muted"
                  }`}
                >
                  {view.role}
                </span>
              )}
              {view.toolName && (
                <span className="rounded-md bg-canvas-inset px-2 py-0.5 text-ink-secondary">{view.toolName}</span>
              )}
              {evidence?.created_at && (
                <span className="text-ink-muted">{String(evidence.created_at).slice(0, 19).replace("T", " ")}</span>
              )}
              {loading && <span className="text-ink-muted">Loading...</span>}
            </div>
          </div>
          <button onClick={onClose} className="shrink-0 rounded-md border border-hairline px-3 py-1.5 text-xs hover:bg-surface-default">
            Close
          </button>
        </div>

        {error && <div className="mb-4 rounded-md border border-severity-critical/30 bg-severity-critical-subtle px-3 py-2 text-sm text-severity-critical">{error}</div>}

        {/* Same compact steps as finding panel — no separate “evidence product card”. */}
        {(() => {
          const steps = evidenceProofSteps((evidence || {}) as EvidenceLike);
          if (steps.length) {
            return (
              <ol className="space-y-2">
                {steps.map((s) => (
                  <li
                    key={`${s.n}-${s.label}`}
                    className="min-w-0 overflow-hidden rounded-md border border-hairline-soft"
                  >
                    <p className="flex items-center gap-1.5 border-b border-hairline-soft bg-canvas-inset/50 px-2.5 py-1.5 text-[11px] font-medium text-ink">
                      <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-canvas font-mono text-[10px] text-ink-secondary">
                        {s.n}
                      </span>
                      {s.label}
                    </p>
                    <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words px-2.5 py-2 font-mono text-[11px] leading-relaxed text-ink-secondary">
                      {s.text}
                    </pre>
                  </li>
                ))}
              </ol>
            );
          }
          if (view.kind === "http" && view.http) return <HttpEvidenceBody http={view.http} />;
          if (view.kind === "shell" && view.shell) return <ShellEvidenceBody shell={view.shell} />;
          if (view.kind === "file" && view.file) return <FileEvidenceBody file={view.file} />;
          return (
            <pre className="max-h-[28rem] overflow-auto whitespace-pre-wrap break-words rounded-md bg-canvas-inset p-3 font-mono text-xs leading-relaxed text-ink-secondary">
              {view.bodyPreview || view.subtitle || "—"}
            </pre>
          );
        })()}
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

function ShellEvidenceBody({ shell }: { shell: NonNullable<ParsedEvidenceView["shell"]> }) {
  const observation = shell.observation || "";
  const fullOut = shell.stdout || "";
  const showFullSeparately =
    Boolean(fullOut) &&
    Boolean(observation) &&
    fullOut.replace(/\s+/g, " ").slice(0, 200) !== observation.replace(/\s+/g, " ").slice(0, 200) &&
    fullOut.length > observation.length + 40;

  return (
    <div className="space-y-4">
      {observation ? (
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase text-ink-secondary">1. Result (what was observed)</h3>
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border border-hairline-soft bg-canvas p-3 font-mono text-xs leading-relaxed text-ink">
            {observation}
          </pre>
        </section>
      ) : fullOut ? (
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase text-ink-secondary">1. Result (what was observed)</h3>
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border border-hairline-soft bg-canvas p-3 font-mono text-xs leading-relaxed text-ink">
            {fullOut}
          </pre>
        </section>
      ) : null}

      {shell.command && (
        <section className="rounded-md border border-hairline-soft bg-canvas-inset/50 p-3">
          <h3 className="mb-1 text-xs font-semibold uppercase text-ink-secondary">2. What the agent did</h3>
          <p className="mb-2 text-[11px] text-ink-muted">Shell command that produced the result.</p>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-canvas p-2 font-mono text-[11px] leading-relaxed text-ink">
            {shell.command}
          </pre>
        </section>
      )}

      {showFullSeparately && (
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase text-ink-secondary">Full stdout</h3>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-canvas-inset p-3 font-mono text-xs leading-relaxed text-ink-secondary">
            {fullOut}
          </pre>
        </section>
      )}
      {shell.stderr && (
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase text-ink-secondary">Stderr</h3>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-canvas-inset p-3 font-mono text-xs leading-relaxed text-severity-critical">
            {shell.stderr}
          </pre>
        </section>
      )}
      {!observation && !fullOut && !shell.command && !shell.stderr && (
        <p className="text-sm text-ink-muted">No proving observation recorded for this evidence.</p>
      )}
    </div>
  );
}

function FileEvidenceBody({ file }: { file: NonNullable<ParsedEvidenceView["file"]> }) {
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Info label="Path" value={file.path || "—"} />
        {file.hash && <Info label="Hash" value={file.hash} />}
        {file.bytes && <Info label="Bytes" value={file.bytes} />}
      </div>
      {file.preview ? (
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase text-ink-secondary">Preview</h3>
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-canvas-inset p-3 font-mono text-xs leading-relaxed text-ink-secondary">
            {file.preview}
          </pre>
        </section>
      ) : (
        <p className="text-sm text-ink-muted">No file preview recorded for this evidence.</p>
      )}
    </div>
  );
}

function badgeClassForKind(kind: ParsedEvidenceView["kind"]): string {
  if (kind === "http") return "bg-status-running/12 text-status-running";
  if (kind === "scan") return "bg-[#f5f3ff] text-[#6d28d9]";
  if (kind === "browser") return "bg-[#f0fdfa] text-[#0f766e]";
  if (kind === "shell") return "bg-canvas-inset text-ink";
  if (kind === "file") return "bg-[#fff7ed] text-[#c2410c]";
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
    <div className="min-w-0 rounded-md bg-canvas-inset p-2.5">
      <div className="text-xs text-ink-muted">{label}</div>
      <div className="mt-1 break-all font-mono text-xs text-ink">{value || "—"}</div>
    </div>
  );
}
