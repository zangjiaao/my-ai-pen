/**
 * Spec #312 / #313 / #450 — Unified Choice Card shell.
 * authorize/handoff preset = two-button Confirm UX;
 * option cards = Approval wizard chrome (radio/check, custom last option, pager, Send, ✕).
 */
import { useEffect, useMemo, useState } from "react";
import MarkdownText from "../MarkdownText";
import {
  isNextStepsChoice,
  isQuestionAnswerValid,
  parseWizardQuestions,
  reduceChoiceDecision,
  type ChoiceDecision,
  type WizardAnswer,
  type WizardQuestion,
} from "../../lib/choiceCard";

export type ApprovalDecision = ChoiceDecision;

export type ConfirmOptionsExtras = {
  customText?: string;
  answers?: WizardAnswer[];
};

export default function ChoiceCard({
  content,
  onAuthorize,
  onCancel,
  onConfirmOptions,
  highlighted = false,
  decision,
  disabled = false,
  selectedOptionIds,
  customText,
  answers,
}: {
  content: Record<string, unknown>;
  onAuthorize?: () => void;
  onCancel?: () => void;
  onConfirmOptions?: (selectedOptionIds: string[], extras?: ConfirmOptionsExtras) => void;
  highlighted?: boolean;
  decision?: ApprovalDecision;
  disabled?: boolean;
  selectedOptionIds?: string[];
  customText?: string;
  answers?: WizardAnswer[];
}) {
  const requestId = String(content.request_id || "");
  const optionCard = isNextStepsChoice(content);
  const selected =
    decision === "authorize" ||
    decision === "cancel" ||
    decision === "answered" ||
    decision === "confirm_options";
  const readOnly = selected || disabled;

  if (optionCard) {
    return (
      <ApprovalWizardBody
        content={content}
        requestId={requestId}
        decision={decision}
        highlighted={highlighted}
        readOnly={readOnly}
        selectedOptionIds={selectedOptionIds}
        customText={customText}
        answers={answers}
        onConfirmOptions={onConfirmOptions}
        onCancel={onCancel}
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

type Draft = { optionIds: string[]; custom: string };

function emptyDraft(): Draft {
  return { optionIds: [], custom: "" };
}

function draftsFromHydration(
  questions: WizardQuestion[],
  selectedOptionIds?: string[],
  customText?: string,
  answers?: WizardAnswer[],
): Record<string, Draft> {
  const out: Record<string, Draft> = {};
  const byId = new Map((answers || []).map((a) => [a.question_id, a]));
  for (const q of questions) {
    const ans = byId.get(q.id);
    if (ans) {
      out[q.id] = {
        optionIds: (ans.selected_option_ids || []).map((x) => String(x || "").trim()).filter(Boolean),
        custom: String(ans.custom_text || "").trim(),
      };
      continue;
    }
    if (questions.length === 1) {
      out[q.id] = {
        optionIds: (selectedOptionIds || []).map((x) => String(x || "").trim()).filter(Boolean),
        custom: String(customText || "").trim(),
      };
    } else {
      out[q.id] = emptyDraft();
    }
  }
  return out;
}

function ApprovalWizardBody({
  content,
  requestId,
  decision,
  highlighted,
  readOnly,
  selectedOptionIds,
  customText,
  answers,
  onConfirmOptions,
  onCancel,
}: {
  content: Record<string, unknown>;
  requestId: string;
  decision?: ApprovalDecision;
  highlighted: boolean;
  readOnly: boolean;
  selectedOptionIds?: string[];
  customText?: string;
  answers?: WizardAnswer[];
  onConfirmOptions?: (selectedOptionIds: string[], extras?: ConfirmOptionsExtras) => void;
  onCancel?: () => void;
}) {
  const questions = useMemo(() => parseWizardQuestions(content), [content]);
  const [qi, setQi] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() =>
    draftsFromHydration(questions, selectedOptionIds, customText, answers),
  );

  useEffect(() => {
    if (!readOnly) return;
    setDrafts(draftsFromHydration(questions, selectedOptionIds, customText, answers));
  }, [readOnly, questions, selectedOptionIds, customText, answers]);

  const confirmed =
    decision === "confirm_options" || decision === "answered" || decision === "authorize";
  const canceled = decision === "cancel";
  const safeIndex = Math.min(Math.max(0, qi), Math.max(0, questions.length - 1));
  const question = questions[safeIndex];
  const last = safeIndex === questions.length - 1;
  const multiQ = questions.length > 1;
  const draft = question ? drafts[question.id] || emptyDraft() : emptyDraft();
  const hasAnswer = question
    ? isQuestionAnswerValid({
        selection: question.selection,
        allow_custom: question.allow_custom,
        selected_option_ids: draft.optionIds,
        custom_text: draft.custom,
      })
    : false;
  const allAnswered = questions.every((q) => {
    const row = drafts[q.id] || emptyDraft();
    return isQuestionAnswerValid({
      selection: q.selection,
      allow_custom: q.allow_custom,
      selected_option_ids: row.optionIds,
      custom_text: row.custom,
    });
  });
  const canSend = last ? allAnswered : hasAnswer;

  const setDraft = (questionId: string, next: Draft) => {
    setDrafts((current) => ({ ...current, [questionId]: next }));
  };

  const toggle = (optionId: string) => {
    if (readOnly || !question) return;
    if (question.selection === "single") {
      setDraft(question.id, { optionIds: [optionId], custom: "" });
      return;
    }
    const picked = draft.optionIds.includes(optionId)
      ? draft.optionIds.filter((id) => id !== optionId)
      : [...draft.optionIds, optionId];
    setDraft(question.id, { ...draft, optionIds: picked });
  };

  const setCustom = (value: string) => {
    if (readOnly || !question) return;
    if (question.selection === "single") {
      setDraft(question.id, { optionIds: [], custom: value });
      return;
    }
    setDraft(question.id, { ...draft, custom: value });
  };

  const submit = () => {
    if (readOnly || !canSend) return;
    const payloadAnswers: WizardAnswer[] = questions.map((q) => {
      const row = drafts[q.id] || emptyDraft();
      const ans: WizardAnswer = {
        question_id: q.id,
        selected_option_ids: q.selection === "single" && row.custom.trim() ? [] : row.optionIds,
      };
      const custom = q.allow_custom ? row.custom.trim() : "";
      if (custom) ans.custom_text = custom;
      return ans;
    });
    if (!last) {
      setQi((current) => Math.min(questions.length - 1, current + 1));
      return;
    }
    const reduced = reduceChoiceDecision(content, { answers: payloadAnswers });
    if (!reduced.ok) return;
    onConfirmOptions?.(reduced.selected_option_ids, {
      customText: reduced.custom_text,
      answers: reduced.answers,
    });
  };

  if (!question) return null;

  return (
    <div
      data-testid="choice-card"
      data-choice-kind="next_steps"
      data-choice-presentation="approval_wizard"
      data-choice-selection={question.selection}
      data-approval-request-id={requestId}
      data-approval-decision={decision || ""}
      className={`my-2 w-full overflow-hidden rounded-md border bg-surface-elevated ${
        highlighted
          ? "border-status-running shadow-[0_0_0_3px_rgba(37,99,235,0.24)]"
          : confirmed
            ? "border-status-success"
            : "border-hairline"
      }`}
    >
      <div className="px-4 pb-3 pt-4">
        <div className="flex items-start justify-between gap-3">
          <span className="text-[13px] font-medium text-ink">{question.prompt}</span>
          {!readOnly ? (
            <button
              type="button"
              data-testid="choice-dismiss"
              aria-label="取消"
              onClick={() => onCancel?.()}
              className="flex size-6 shrink-0 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-canvas hover:text-ink"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          ) : null}
        </div>
        <div className="mt-2 flex flex-col gap-0.5" data-testid="choice-options">
          {question.options.map((opt) => {
            const on = draft.optionIds.includes(opt.id);
            return (
              <button
                key={opt.id}
                type="button"
                data-testid={`choice-option-${opt.id}`}
                aria-pressed={on}
                disabled={readOnly}
                onClick={() => toggle(opt.id)}
                className="-mx-1.5 flex items-start gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-canvas disabled:hover:bg-transparent"
              >
                <span
                  className={`mt-0.5 flex size-4 shrink-0 items-center justify-center transition-colors duration-200 ${
                    question.selection === "single" ? "rounded-full" : "rounded-[5px]"
                  } ${on ? "bg-ink text-on-ink" : "text-transparent shadow-[inset_0_0_0_1.5px_var(--color-hairline)]"}`}
                >
                  {question.selection === "single" ? (
                    <span
                      className="size-1.5 rounded-full bg-canvas transition-transform duration-200"
                      style={{ transform: on ? "scale(1)" : "scale(0)" }}
                    />
                  ) : (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M20 6L9 17l-5-5" />
                    </svg>
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className={`block text-[13px] ${on ? "text-ink" : "text-ink-secondary"}`}>{opt.title}</span>
                  {opt.body ? (
                    <MarkdownText
                      text={opt.body}
                      className="mt-0.5 min-w-0 max-w-full space-y-1 text-xs leading-relaxed text-ink-muted [overflow-wrap:anywhere]"
                    />
                  ) : null}
                </span>
              </button>
            );
          })}
          {question.allow_custom ? (
            <label className="-mx-1.5 flex items-center gap-2 rounded-md px-1.5 py-1 transition-colors focus-within:bg-canvas hover:bg-canvas">
              <span aria-hidden="true" className="size-4 shrink-0" />
              <input
                data-testid="choice-custom-input"
                value={draft.custom}
                disabled={readOnly}
                onChange={(event) => setCustom(event.target.value)}
                placeholder="输入自定义需求…"
                aria-label="自定义需求"
                className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-muted disabled:cursor-default"
              />
            </label>
          ) : null}
        </div>
      </div>

      <div className="flex items-center justify-between border-t border-hairline px-3 py-2">
        <span className="flex items-center gap-2">
          {multiQ ? (
            <>
              <button
                type="button"
                aria-label="上一题"
                disabled={safeIndex === 0}
                onClick={() => setQi((current) => Math.max(0, current - 1))}
                className="flex size-6 items-center justify-center rounded-md text-ink-muted transition-colors enabled:hover:bg-canvas enabled:hover:text-ink-secondary disabled:opacity-35"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M15 18l-6-6 6-6" />
                </svg>
              </button>
              <span className="flex items-center gap-1" data-testid="choice-pager">
                {questions.map((q, i) => (
                  <button
                    key={q.id}
                    type="button"
                    aria-label={`第 ${i + 1} 题`}
                    aria-current={i === safeIndex ? "step" : undefined}
                    onClick={() => setQi(i)}
                    className="rounded-full transition-all duration-300"
                    style={
                      i === safeIndex
                        ? { width: 9, height: 9, border: "2.5px solid var(--color-ink)" }
                        : i < safeIndex || Boolean(drafts[q.id]?.optionIds.length || drafts[q.id]?.custom.trim())
                          ? { width: 7, height: 7, background: "var(--color-ink-muted)" }
                          : { width: 7, height: 7, border: "1.5px solid var(--color-ink-muted)" }
                    }
                  />
                ))}
              </span>
              <button
                type="button"
                aria-label="下一题"
                disabled={last}
                onClick={() => setQi((current) => Math.min(questions.length - 1, current + 1))}
                className="flex size-6 items-center justify-center rounded-md text-ink-muted transition-colors enabled:hover:bg-canvas enabled:hover:text-ink-secondary disabled:opacity-35"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 6l6 6-6 6" />
                </svg>
              </button>
            </>
          ) : (
            <span />
          )}
        </span>
        {!readOnly ? (
          <button
            type="button"
            data-testid="choice-confirm-options"
            aria-label={last ? "提交" : "下一题"}
            disabled={!canSend}
            onClick={submit}
            className="flex size-7 items-center justify-center rounded-[8px] transition-[background-color,color,transform] duration-200 enabled:active:scale-[0.96] disabled:cursor-default"
            style={{
              background: canSend ? "var(--color-ink)" : "var(--color-canvas-inset)",
              color: canSend ? "var(--color-on-ink)" : "var(--color-ink-muted)",
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 19V5M5 12l7-7 7 7" />
            </svg>
          </button>
        ) : (
          <span className="text-[12px] text-ink-muted">
            {confirmed ? "已选择" : canceled ? "已取消" : decision === "answered" ? "已通过对话继续" : ""}
          </span>
        )}
      </div>
    </div>
  );
}
