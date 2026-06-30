import ApprovalCountdown from "../ApprovalCountdown";

export default function ConfirmCard({ content, onAuthorize, onCancel, highlighted = false }: { content: Record<string, unknown>; onAuthorize: () => void; onCancel: () => void; highlighted?: boolean }) {
  const requestId = String(content.request_id || "");

  return (
    <div
      data-testid="confirm-card"
      data-approval-request-id={requestId}
      className={`my-2 rounded-md border bg-surface-elevated p-5 transition-shadow ${highlighted ? "border-status-running shadow-[0_0_0_3px_rgba(37,99,235,0.24)]" : "border-hairline"}`}
    >
      <div className="mb-2 flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium">Approval required</p>
          <p className="mt-1 text-xs text-ink-muted">Risk: {String(content.risk_level || "unknown")}</p>
        </div>
        <ApprovalCountdown expiresAt={content.expires_at} />
      </div>
      <p className="mb-3 break-words text-sm [overflow-wrap:anywhere]">{String(content.question || "")}</p>
      {Boolean(content.proposed_action) && (
        <pre className="mb-3 max-h-32 overflow-auto rounded-sm bg-canvas-inset p-2 font-mono text-xs whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{String(content.proposed_action)}</pre>
      )}
      <div className="flex flex-wrap gap-2">
        <button data-testid="confirm-authorize" type="button" onClick={onAuthorize} className="rounded-pill bg-ink px-4 py-2 text-sm font-medium text-white">Authorize</button>
        <button data-testid="confirm-cancel" type="button" onClick={onCancel} className="rounded-pill border border-hairline bg-canvas px-4 py-2 text-sm text-ink">Cancel</button>
      </div>
    </div>
  );
}
