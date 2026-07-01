import ApprovalCountdown from "../ApprovalCountdown";

type ApprovalDecision = "authorize" | "cancel";

export default function ConfirmCard({
  content,
  onAuthorize,
  onCancel,
  highlighted = false,
  decision,
}: {
  content: Record<string, unknown>;
  onAuthorize: () => void;
  onCancel: () => void;
  highlighted?: boolean;
  decision?: ApprovalDecision;
}) {
  const requestId = String(content.request_id || "");
  const selected = decision === "authorize" || decision === "cancel";
  const authorizeSelected = decision === "authorize";
  const cancelSelected = decision === "cancel";

  return (
    <div
      data-testid="confirm-card"
      data-approval-request-id={requestId}
      data-approval-decision={decision || ""}
      className={`my-2 rounded-md border bg-surface-elevated p-5 transition-shadow ${highlighted ? "border-status-running shadow-[0_0_0_3px_rgba(37,99,235,0.24)]" : selected ? "border-status-success" : "border-hairline"}`}
    >
      <div className="mb-2 flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium">Approval required</p>
          <p className="mt-1 text-xs text-ink-muted">Risk: {String(content.risk_level || "unknown")}</p>
        </div>
        {selected ? <span className="rounded-pill bg-status-success px-2 py-1 text-xs font-medium text-white">{authorizeSelected ? "Authorized" : "Canceled"}</span> : <ApprovalCountdown expiresAt={content.expires_at} />}
      </div>
      <p className="mb-3 break-words text-sm [overflow-wrap:anywhere]">{String(content.question || "")}</p>
      {Boolean(content.proposed_action) && (
        <pre className="mb-3 max-h-32 overflow-auto rounded-sm bg-canvas-inset p-2 font-mono text-xs whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{String(content.proposed_action)}</pre>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          data-testid="confirm-authorize"
          type="button"
          onClick={onAuthorize}
          disabled={selected}
          aria-pressed={authorizeSelected}
          className={`rounded-pill px-4 py-2 text-sm font-medium transition-colors disabled:cursor-default ${authorizeSelected ? "bg-status-success text-white" : selected ? "border border-hairline bg-canvas text-ink-muted" : "bg-ink text-white"}`}
        >
          Authorize
        </button>
        <button
          data-testid="confirm-cancel"
          type="button"
          onClick={onCancel}
          disabled={selected}
          aria-pressed={cancelSelected}
          className={`rounded-pill px-4 py-2 text-sm transition-colors disabled:cursor-default ${cancelSelected ? "bg-severity-critical text-white" : "border border-hairline bg-canvas text-ink"}`}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}