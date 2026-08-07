/**
 * Spec #312 — Unified Choice Card shell.
 * authorize/handoff preset = two-button Confirm UX;
 * next_steps preset = multi-select packages + 按所选继续.
 */
import { useEffect, useMemo, useState } from "react";
import MarkdownText from "../MarkdownText";
import {
  isNextStepsChoice,
  parseChoiceOptions,
  type ChoiceDecision,
} from "../../lib/choiceCard";

export type ApprovalDecision = ChoiceDecision;

export default function ChoiceCard({
  content,
  onAuthorize,
  onCancel,
  onConfirmOptions,
  highlighted = false,
  decision,
  disabled = false,
  selectedOptionIds,
}: {
  content: Record<string, unknown>;
  onAuthorize?: () => void;
  onCancel?: () => void;
  onConfirmOptions?: (selectedOptionIds: string[]) => void;
  highlighted?: boolean;
  decision?: ApprovalDecision;
  /** Disable interaction while a turn is running. */
  disabled?: boolean;
  /** Spec #312: hydrate read-only next_steps checkboxes from decision. */
  selectedOptionIds?: string[];
}) {
  const requestId = String(content.request_id || "");
  const nextSteps = isNextStepsChoice(content);
  const selected =
    decision === "authorize" ||
    decision === "cancel" ||
    decision === "answered" ||
    decision === "confirm_options";
  const readOnly = selected || disabled;

  if (nextSteps) {
    return (
      <NextStepsBody
        content={content}
        requestId={requestId}
        decision={decision}
        highlighted={highlighted}
        readOnly={readOnly}
        selectedOptionIds={selectedOptionIds}
        onConfirmOptions={onConfirmOptions}
      />
    );
  }

  return (
    <AuthorizeBody
      content={content}
      requestId={requestId}
      decision={decision}
      highlighted={highlighted}
      selected={selected}
      disabled={disabled}
      onAuthorize={onAuthorize}
      onCancel={onCancel}
    />
  );
}

function AuthorizeBody({
  content,
  requestId,
  decision,
  highlighted,
  selected,
  disabled = false,
  onAuthorize,
  onCancel,
}: {
  content: Record<string, unknown>;
  requestId: string;
  decision?: ApprovalDecision;
  highlighted: boolean;
  selected: boolean;
  disabled?: boolean;
  onAuthorize?: () => void;
  onCancel?: () => void;
}) {
  const authorizeSelected = decision === "authorize";
  const cancelSelected = decision === "cancel";
  const answeredSelected = decision === "answered";
  // Spec #312 review: honor turn-running disabled same as next_steps readOnly.
  const controlsDisabled = selected || disabled;

  const title =
    String(content.question || "").trim() ||
    (String(content.kind || "") === "handoff" ? "需要授权移交" : "需要授权");
  const body = String(content.proposed_action || content.target || "").trim();
  const handoffName = String(content.handoff_expert_name || "").trim();
  const handoffSubtitle =
    handoffName && String(content.kind || "") === "handoff"
      ? `移交至：${handoffName}`
      : "";

  return (
    <div
      data-testid="confirm-card"
      data-choice-kind={String(content.kind || "confirm")}
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
      {handoffSubtitle ? (
        <p className="mt-1 text-xs text-ink-muted">{handoffSubtitle}</p>
      ) : null}
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
          disabled={controlsDisabled}
          aria-pressed={authorizeSelected}
          className={`rounded-pill px-4 py-2 text-sm font-medium transition-colors disabled:cursor-default ${
            authorizeSelected
              ? "bg-status-success text-white"
              : selected
                ? "border border-hairline bg-canvas text-ink-muted"
                : "bg-ink text-on-ink"
          }`}
        >
          {authorizeSelected ? "已授权" : answeredSelected ? "已回复" : "授权"}
        </button>
        <button
          data-testid="confirm-cancel"
          type="button"
          onClick={onCancel}
          disabled={controlsDisabled}
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

function NextStepsBody({
  content,
  requestId,
  decision,
  highlighted,
  readOnly,
  selectedOptionIds,
  onConfirmOptions,
}: {
  content: Record<string, unknown>;
  requestId: string;
  decision?: ApprovalDecision;
  highlighted: boolean;
  readOnly: boolean;
  selectedOptionIds?: string[];
  onConfirmOptions?: (selectedOptionIds: string[]) => void;
}) {
  const options = useMemo(() => parseChoiceOptions(content), [content]);
  // Hydrate from decision selected_option_ids when read-only (reload / post-confirm).
  const hydratedIds = useMemo(() => {
    const ids = Array.isArray(selectedOptionIds)
      ? selectedOptionIds.map((x) => String(x || "").trim()).filter(Boolean)
      : [];
    return ids;
  }, [selectedOptionIds]);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(hydratedIds));
  useEffect(() => {
    if (hydratedIds.length) {
      setPicked(new Set(hydratedIds));
    }
  }, [hydratedIds.join("\0")]);
  const displayPicked = readOnly && hydratedIds.length > 0 ? new Set(hydratedIds) : picked;
  const confirmed =
    decision === "confirm_options" || decision === "answered" || decision === "authorize";
  const title =
    String(content.question || content.preamble || "").trim() || "下一步工作包";
  const preamble = String(content.preamble || content.proposed_action || "").trim();

  const toggle = (id: string) => {
    if (readOnly) return;
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const canSubmit = !readOnly && picked.size > 0;

  return (
    <div
      data-testid="choice-card"
      data-choice-kind="next_steps"
      data-approval-request-id={requestId}
      data-approval-decision={decision || ""}
      className={`my-2 rounded-md border bg-surface-elevated p-5 transition-shadow ${
        highlighted
          ? "border-status-running shadow-[0_0_0_3px_rgba(37,99,235,0.24)]"
          : confirmed
            ? "border-status-success"
            : "border-hairline"
      }`}
    >
      <p className="text-sm font-medium text-ink">{title}</p>
      {preamble && preamble !== title ? (
        <MarkdownText
          text={preamble}
          className="mt-2 min-w-0 max-w-full space-y-2 text-sm leading-relaxed text-ink-secondary [overflow-wrap:anywhere]"
        />
      ) : null}
      <ul className="mt-3 space-y-2" data-testid="choice-options">
        {options.map((opt) => {
          const isOn = displayPicked.has(opt.id);
          return (
            <li key={opt.id}>
              <label
                data-testid={`choice-option-${opt.id}`}
                className={`flex cursor-pointer gap-3 rounded-md border px-3 py-2.5 transition-colors ${
                  readOnly
                    ? "cursor-default border-hairline bg-canvas/50 opacity-80"
                    : isOn
                      ? "border-ink/40 bg-canvas"
                      : "border-hairline bg-canvas hover:border-ink/30"
                }`}
              >
                <input
                  type="checkbox"
                  className="mt-1 h-4 w-4 shrink-0"
                  checked={isOn}
                  disabled={readOnly}
                  onChange={() => toggle(opt.id)}
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-ink">{opt.title}</span>
                  {opt.body ? (
                    <MarkdownText
                      text={opt.body}
                      className="mt-1 min-w-0 max-w-full space-y-1 text-xs leading-relaxed text-ink-secondary [overflow-wrap:anywhere]"
                    />
                  ) : null}
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          data-testid="choice-confirm-options"
          type="button"
          disabled={!canSubmit}
          onClick={() => {
            if (!canSubmit) return;
            onConfirmOptions?.([...picked]);
          }}
          className={`rounded-pill px-4 py-2 text-sm font-medium transition-colors disabled:cursor-default ${
            confirmed
              ? "bg-status-success text-white"
              : canSubmit
                ? "bg-ink text-on-ink"
                : "border border-hairline bg-canvas text-ink-muted"
          }`}
        >
          {confirmed ? "已选择" : "按所选继续"}
        </button>
        {decision === "answered" ? (
          <span className="self-center text-xs text-ink-muted">已通过对话继续</span>
        ) : null}
      </div>
    </div>
  );
}
