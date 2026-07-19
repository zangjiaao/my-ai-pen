import MarkdownText from "../MarkdownText";

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

  // Title = the authorization question (e.g. 请确认DVWA渗透测试的授权范围和条件)
  const title =
    String(content.question || "").trim() ||
    (String(content.kind || "") === "handoff" ? "需要授权移交" : "需要授权");
  // Body = proposed plan / target details (markdown)
  const body = String(content.proposed_action || content.target || "").trim();

  return (
    <div
      data-testid="confirm-card"
      data-approval-request-id={requestId}
      data-approval-decision={decision || ""}
      className={`my-2 rounded-md border bg-surface-elevated p-5 transition-shadow ${
        highlighted
          ? "border-status-running shadow-[0_0_0_3px_rgba(37,99,235,0.24)]"
          : selected
            ? "border-status-success"
            : "border-hairline"
      }`}
    >
      <p className="text-sm font-medium text-ink">{title}</p>
      {body ? (
        <MarkdownText
          text={body}
          className="mt-2 min-w-0 max-w-full space-y-2 text-sm leading-relaxed text-ink-secondary [overflow-wrap:anywhere]"
        />
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          data-testid="confirm-authorize"
          type="button"
          onClick={onAuthorize}
          disabled={selected}
          aria-pressed={authorizeSelected}
          className={`rounded-pill px-4 py-2 text-sm font-medium transition-colors disabled:cursor-default ${
            authorizeSelected
              ? "bg-status-success text-white"
              : selected
                ? "border border-hairline bg-canvas text-ink-muted"
                : "bg-ink text-on-ink"
          }`}
        >
          {authorizeSelected ? "已授权" : "授权"}
        </button>
        <button
          data-testid="confirm-cancel"
          type="button"
          onClick={onCancel}
          disabled={selected}
          aria-pressed={cancelSelected}
          className={`rounded-pill px-4 py-2 text-sm transition-colors disabled:cursor-default ${
            cancelSelected
              ? "bg-severity-critical text-white"
              : "border border-hairline bg-canvas text-ink"
          }`}
        >
          {cancelSelected ? "已取消" : "取消"}
        </button>
      </div>
    </div>
  );
}
