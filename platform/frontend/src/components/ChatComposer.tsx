import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Check, ChevronDown, Target } from "lucide-react";
import {
  ENGAGEMENT_TEMPLATES,
  ENGAGEMENT_UNSPECIFIED_LABEL,
  expertLabel,
  resolveExpertColor,
  type EngagementTemplateId,
} from "../lib/experts";
import {
  composerLiveSeconds,
  composerTimerVisible,
  formatWorkSeconds,
  type WorkBurstProjection,
} from "../lib/workBurstTime";
import { commitTypedInput, useRenderAudit } from "../lib/renderAudit";

/** @mention picker entry: workspace assistant (default seat) or product expert. */
export type MentionTarget = {
  kind: "expert" | "default" | "platform";
  key: string;
  name: string;
  label: string;
  subtitle: string;
  nodeId: string;
  packId?: string;
  expertId?: string;
  color?: string;
  status?: string;
  selectable?: boolean;
};

/** Parent-owned partner only; never guess from catalog order during Case restore. */
export function resolveActiveComposerPartner(
  selectedMention: MentionTarget | null,
): MentionTarget | null {
  return selectedMention?.selectable !== false ? selectedMention : null;
}

export type ChatComposerHandle = {
  getValue: () => string;
  setValue: (text: string) => void;
  clear: () => void;
};

type MentionState = { start: number; query: string } | null;

type Props = {
  mentionTargets: MentionTarget[];
  selectedMention: MentionTarget | null;
  onSelectPartner: (target: MentionTarget) => void;
  engagementTemplate: EngagementTemplateId | null;
  onEngagementTemplate: (id: EngagementTemplateId | null) => void;
  goalModeEnabled: boolean;
  onGoalMode: (enabled: boolean) => void;
  running: boolean;
  interrupting: boolean;
  workBurst: WorkBurstProjection | null;
  onSend: (text: string) => void;
  onInterrupt: () => void;
};

const CHAT_COMPOSER_OUTER_CLASS = "px-6 pb-4 pt-4";
const CHAT_COMPOSER_SHELL_CLASS =
  "relative rounded-2xl border border-hairline bg-canvas shadow-[0_1px_2px_rgba(0,0,0,0.04)]";
const CHAT_COMPOSER_INPUT_REGION_CLASS = "relative min-w-0";
const CHAT_COMPOSER_INPUT_CONTENT_CLASS = "px-4 py-3.5 text-sm leading-5";
/** py-3.5 × 2 + leading-5 × 2 — compact empty field; grows with draft. */
export const COMPOSER_TEXTAREA_MIN_PX = 68;
/** py-3.5 × 2 + leading-5 × 7 — then native scroll. */
export const COMPOSER_TEXTAREA_MAX_PX = 168;
const CHAT_COMPOSER_FOOTER_CLASS =
  "flex min-w-0 items-center justify-between gap-2 px-2.5 py-2";
const CHAT_COMPOSER_TOOLBAR_CLASS =
  "flex min-w-0 flex-1 flex-wrap items-center gap-1.5";
const CHAT_COMPOSER_PARTNER_CONTROL_CLASS =
  "inline-flex h-8 max-w-[13rem] items-center gap-1.5 rounded-full pl-2 pr-2 text-xs leading-none";
const CHAT_COMPOSER_MODE_CONTROL_CLASS =
  "inline-flex h-8 max-w-[11rem] items-center gap-1.5 rounded-full pl-2.5 pr-2 text-xs leading-none";
const CHAT_COMPOSER_GOAL_CONTROL_CLASS =
  "inline-flex h-8 items-center rounded-full px-3 text-xs font-medium leading-none";
const CHAT_COMPOSER_ACTIONS_CLASS = "flex h-8 shrink-0 items-center gap-2";
const CHAT_COMPOSER_SUBMIT_CONTROL_CLASS =
  "inline-flex h-8 items-center rounded-pill px-4 text-xs font-medium leading-none";

export function ChatComposerSkeleton() {
  return (
    <div className={CHAT_COMPOSER_OUTER_CLASS} data-testid="composer-loading-skeleton">
      <div
        aria-hidden="true"
        className={`${CHAT_COMPOSER_SHELL_CLASS} animate-pulse`}
      >
        <div className={CHAT_COMPOSER_INPUT_REGION_CLASS}>
          <div className={CHAT_COMPOSER_INPUT_CONTENT_CLASS}>
            <div className="flex h-5 items-center">
              <div className="h-3 w-[38%] rounded-full bg-canvas-inset" />
            </div>
            <div className="flex h-5 items-center">
              <div className="h-3 w-[24%] rounded-full bg-canvas-inset" />
            </div>
          </div>
        </div>
        <div className={CHAT_COMPOSER_FOOTER_CLASS}>
          <div className={CHAT_COMPOSER_TOOLBAR_CLASS}>
            <div className={`${CHAT_COMPOSER_PARTNER_CONTROL_CLASS} w-24 bg-canvas-inset`} />
            <div className={`${CHAT_COMPOSER_MODE_CONTROL_CLASS} w-20 bg-canvas-inset`} />
            <div className={`${CHAT_COMPOSER_GOAL_CONTROL_CLASS} w-14 bg-canvas-inset`} />
          </div>
          <div className={CHAT_COMPOSER_ACTIONS_CLASS}>
            <div className={`${CHAT_COMPOSER_SUBMIT_CONTROL_CLASS} w-14 bg-canvas-inset`} />
          </div>
        </div>
      </div>
    </div>
  );
}

export type ComposerSubmitKeyEvent = {
  key: string;
  shiftKey: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
};

function composerEnterIsIme(event: ComposerSubmitKeyEvent, composing: boolean): boolean {
  return composing || event.isComposing === true || event.keyCode === 229;
}

/** Enter sends; Shift/⌘/Ctrl+Enter newlines; IME confirm / processing must not send. Spec #490. */
export function shouldSubmitComposerOnEnter(
  event: ComposerSubmitKeyEvent,
  composing = false,
): boolean {
  if (event.key !== "Enter") return false;
  if (event.shiftKey || event.metaKey || event.ctrlKey) return false;
  if (composerEnterIsIme(event, composing)) return false;
  return true;
}

/** ⌘/Ctrl+Enter inserts a newline (Shift+Enter is native textarea). IME confirm must not insert. */
export function shouldInsertComposerNewline(
  event: ComposerSubmitKeyEvent,
  composing = false,
): boolean {
  if (event.key !== "Enter") return false;
  if (!(event.metaKey || event.ctrlKey) || event.shiftKey) return false;
  if (composerEnterIsIme(event, composing)) return false;
  return true;
}

export function insertComposerNewlineAtCaret(
  value: string,
  start: number,
  end: number,
): { next: string; caret: number } {
  const lo = Math.max(0, Math.min(start, value.length));
  const hi = Math.max(lo, Math.min(end, value.length));
  return { next: `${value.slice(0, lo)}\n${value.slice(hi)}`, caret: lo + 1 };
}

export function composerTextareaLayout(contentHeight: number): {
  heightPx: number;
  overflowY: "auto" | "hidden";
} {
  const heightPx = Math.min(
    Math.max(contentHeight, COMPOSER_TEXTAREA_MIN_PX),
    COMPOSER_TEXTAREA_MAX_PX,
  );
  return {
    heightPx,
    overflowY: contentHeight > COMPOSER_TEXTAREA_MAX_PX ? "auto" : "hidden",
  };
}

/** Collapse, measure scrollHeight, then clamp to min/max. */
export function applyComposerTextareaLayout(field: HTMLTextAreaElement): void {
  const keepEnd = field.selectionStart === field.value.length;
  const prevScroll = field.scrollTop;
  field.style.height = "0px";
  const { heightPx, overflowY } = composerTextareaLayout(field.scrollHeight);
  field.style.height = `${heightPx}px`;
  field.style.overflowY = overflowY;
  if (overflowY === "auto") {
    field.scrollTop = keepEnd ? field.scrollHeight : prevScroll;
  }
}

/** Pentest pack experts get mode template + Goal switch; platform / other packs do not. */
export function isPentestMentionTarget(target: MentionTarget | null | undefined): boolean {
  if (!target || target.kind !== "expert") return false;
  const pack = String(target.packId || "").trim().toLowerCase();
  return pack === "pentest" || pack.startsWith("pentest");
}

function getMentionState(value: string): MentionState {
  const match = value.match(/(?:^|\s)@([^\s@]*)$/);
  if (!match || match.index === undefined) return null;
  const atOffset = value.slice(match.index).indexOf("@");
  return { start: match.index + atOffset, query: match[1] || "" };
}

function filterMentionTargets(targets: MentionTarget[], query: string): MentionTarget[] {
  const normalized = query.trim().toLowerCase();
  const ordered = [...targets].sort((a, b) => a.name.localeCompare(b.name));
  if (!normalized) return ordered.slice(0, 8);
  return ordered
    .filter(
      (t) =>
        t.name.toLowerCase().includes(normalized) ||
        t.label.toLowerCase().includes(normalized) ||
        (t.packId || "").toLowerCase().includes(normalized) ||
        t.subtitle.toLowerCase().includes(normalized),
    )
    .slice(0, 8);
}

const ChatComposer = forwardRef<ChatComposerHandle, Props>(function ChatComposer(
  {
    mentionTargets,
    selectedMention,
    onSelectPartner,
    engagementTemplate,
    onEngagementTemplate,
    goalModeEnabled,
    onGoalMode,
    running,
    interrupting,
    workBurst,
    onSend,
    onInterrupt,
  },
  ref,
) {
  const [input, setInput] = useState("");
  useRenderAudit("ChatComposer");
  const [partnerMenuOpen, setPartnerMenuOpen] = useState(false);
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const [composerTickMs, setComposerTickMs] = useState(() => Date.now());
  const partnerMenuRef = useRef<HTMLDivElement | null>(null);
  const modeMenuRef = useRef<HTMLDivElement | null>(null);
  const inputElRef = useRef<HTMLTextAreaElement | null>(null);
  const tickAnchorRef = useRef<{ seconds: number; atMs: number } | null>(null);
  const imeComposingRef = useRef(false);
  const imeSettleTimerRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    const el = inputElRef.current;
    if (el) applyComposerTextareaLayout(el);
  }, [input]);

  useImperativeHandle(ref, () => ({
    getValue: () => input,
    setValue: (text: string) => setInput(text),
    clear: () => setInput(""),
  }), [input]);

  const mentionState = useMemo(() => getMentionState(input), [input]);
  const mentionOptions = useMemo(
    () => filterMentionTargets(mentionTargets, mentionState?.query || ""),
    [mentionTargets, mentionState],
  );

  const activePartner = resolveActiveComposerPartner(selectedMention);
  const showPentestControls = isPentestMentionTarget(activePartner);
  const activeModeLabel =
    ENGAGEMENT_TEMPLATES.find((t) => t.id === engagementTemplate)?.label
    || ENGAGEMENT_UNSPECIFIED_LABEL;

  const showComposerTimer = composerTimerVisible(workBurst, running);
  useEffect(() => {
    if (workBurst?.active_burst_id && workBurst.live_work_seconds != null && workBurst.accruing) {
      tickAnchorRef.current = { seconds: Number(workBurst.live_work_seconds) || 0, atMs: Date.now() };
    } else if (!workBurst?.active_burst_id) {
      tickAnchorRef.current = null;
    } else if (workBurst.authorize_paused || workBurst.accruing === false) {
      const live = workBurst.live_work_seconds;
      tickAnchorRef.current = live != null
        ? { seconds: Number(live) || 0, atMs: Date.now() }
        : tickAnchorRef.current;
    }
  }, [workBurst]);

  useEffect(() => {
    if (!showComposerTimer || workBurst?.authorize_paused || workBurst?.accruing === false) {
      return;
    }
    const id = window.setInterval(() => setComposerTickMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [showComposerTimer, workBurst?.authorize_paused, workBurst?.accruing, workBurst?.active_burst_id]);

  const composerTimerText = useMemo(() => {
    if (!showComposerTimer) return null;
    const secs = composerLiveSeconds(workBurst, {
      nowMs: composerTickMs,
      tickAnchor: workBurst?.authorize_paused || workBurst?.accruing === false
        ? null
        : tickAnchorRef.current,
    });
    if (secs == null) return null;
    return formatWorkSeconds(secs);
  }, [showComposerTimer, workBurst, composerTickMs]);

  useEffect(() => {
    if (!partnerMenuOpen && !modeMenuOpen) return;
    const onPointer = (event: MouseEvent) => {
      const target = event.target as Node;
      if (partnerMenuOpen && partnerMenuRef.current && !partnerMenuRef.current.contains(target)) {
        setPartnerMenuOpen(false);
      }
      if (modeMenuOpen && modeMenuRef.current && !modeMenuRef.current.contains(target)) {
        setModeMenuOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setPartnerMenuOpen(false);
        setModeMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [partnerMenuOpen, modeMenuOpen]);

  const chooseMention = useCallback((target: MentionTarget) => {
    if (target.selectable === false) return;
    const state = getMentionState(input);
    if (state) {
      setInput((current) => {
        const before = current.slice(0, state.start).replace(/\s+$/, "");
        const after = current.slice(state.start + state.query.length + 1).replace(/^\s+/, "");
        return [before, after].filter(Boolean).join(" ");
      });
    }
    onSelectPartner(target);
    if (!isPentestMentionTarget(target)) {
      onGoalMode(false);
    }
  }, [input, onSelectPartner, onGoalMode]);

  const selectExpertFromToolbar = useCallback((key: string) => {
    const selectable = mentionTargets.filter((t) => t.selectable !== false);
    const fallback = selectable[0] || null;
    const found = key ? mentionTargets.find((t) => t.key === key) : null;
    const target = found && found.selectable !== false ? found : fallback;
    if (!target) return;
    onSelectPartner(target);
    if (!isPentestMentionTarget(target)) {
      onGoalMode(false);
      setModeMenuOpen(false);
      onEngagementTemplate(null);
    }
  }, [mentionTargets, onSelectPartner, onGoalMode, onEngagementTemplate]);

  const submit = useCallback(() => {
    const text = input.trim();
    if (!text) return;
    setInput("");
    onSend(text);
  }, [input, onSend]);

  const beginImeComposition = useCallback(() => {
    if (imeSettleTimerRef.current != null) {
      window.clearTimeout(imeSettleTimerRef.current);
      imeSettleTimerRef.current = null;
    }
    imeComposingRef.current = true;
  }, []);

  const endImeCompositionSoon = useCallback(() => {
    if (imeSettleTimerRef.current != null) window.clearTimeout(imeSettleTimerRef.current);
    imeSettleTimerRef.current = window.setTimeout(() => {
      imeComposingRef.current = false;
      imeSettleTimerRef.current = null;
    }, 0);
  }, []);

  useEffect(() => {
    return () => {
      if (imeSettleTimerRef.current != null) window.clearTimeout(imeSettleTimerRef.current);
    };
  }, []);

  return (
    <div className={CHAT_COMPOSER_OUTER_CLASS}>
      <div className={`${CHAT_COMPOSER_SHELL_CLASS} focus-within:border-ink/40 focus-within:shadow-[0_2px_8px_rgba(0,0,0,0.06)]`}>
        {mentionState && mentionOptions.length > 0 && (
          <div className="absolute bottom-full left-0 z-20 mb-2 w-80 overflow-hidden rounded-xl border border-hairline bg-canvas shadow-lg">
            {mentionOptions.map((target) => {
              const accent = target.color || resolveExpertColor(null, target.expertId || target.key);
              const disabled = target.selectable === false;
              return (
                <button
                  key={target.key}
                  type="button"
                  disabled={disabled}
                  title={disabled ? "绑定节点离线，不可调度" : undefined}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    if (disabled) return;
                    chooseMention(target);
                  }}
                  className={`flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-sm transition-colors ${
                    disabled
                      ? "cursor-not-allowed opacity-45"
                      : "hover:bg-surface-default"
                  }`}
                >
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: accent }}
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-ink">
                      {target.label || target.name}
                    </span>
                    <span className="block truncate text-[11px] text-ink-muted">
                      {target.subtitle || target.label}
                    </span>
                  </span>
                  <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-ink-muted">
                    {disabled
                      ? "不可调度"
                      : target.status === "online"
                        ? "Online"
                        : target.status === "offline"
                          ? "Offline"
                          : expertLabel(target.packId)}
                  </span>
                </button>
              );
            })}
          </div>
        )}
        <div className={CHAT_COMPOSER_INPUT_REGION_CLASS}>
          <textarea
            ref={inputElRef}
            value={input}
            onChange={(e) => {
              const next = e.target.value;
              commitTypedInput("ChatComposer", () => setInput(next));
            }}
            onCompositionStart={beginImeComposition}
            onCompositionEnd={endImeCompositionSoon}
            onKeyDown={(e) => {
              const keyEvent = {
                key: e.key,
                shiftKey: e.shiftKey,
                metaKey: e.metaKey,
                ctrlKey: e.ctrlKey,
                isComposing: e.nativeEvent.isComposing,
                keyCode: e.nativeEvent.keyCode,
              };
              const composing = imeComposingRef.current;
              if (shouldSubmitComposerOnEnter(keyEvent, composing)) {
                e.preventDefault();
                submit();
                return;
              }
              if (shouldInsertComposerNewline(keyEvent, composing)) {
                e.preventDefault();
                const el = e.currentTarget;
                const { next, caret } = insertComposerNewlineAtCaret(
                  el.value,
                  el.selectionStart,
                  el.selectionEnd,
                );
                commitTypedInput("ChatComposer", () => setInput(next));
                requestAnimationFrame(() => {
                  el.selectionStart = el.selectionEnd = caret;
                  applyComposerTextareaLayout(el);
                });
              }
            }}
            rows={1}
            placeholder={
              activePartner
                ? `向 ${activePartner.label || activePartner.name} 描述任务…（Shift+Enter 或 ⌘/Ctrl+Enter 换行）`
                : "请先在专家管理创建专家，或从下方选择对话对象…"
            }
            className={`block min-h-[4.25rem] w-full resize-none whitespace-pre-wrap break-words bg-transparent text-ink caret-ink placeholder:text-ink-muted focus:outline-none ${CHAT_COMPOSER_INPUT_CONTENT_CLASS}`}
          />
        </div>
        <div className={CHAT_COMPOSER_FOOTER_CLASS}>
          <div className={CHAT_COMPOSER_TOOLBAR_CLASS}>
            <div ref={partnerMenuRef} className="relative">
              <button
                type="button"
                aria-haspopup="listbox"
                aria-expanded={partnerMenuOpen}
                title="选择对话对象"
                onClick={() => {
                  setPartnerMenuOpen((open) => !open);
                  setModeMenuOpen(false);
                }}
                className={`${CHAT_COMPOSER_PARTNER_CONTROL_CLASS} text-ink transition-colors ${
                  partnerMenuOpen ? "bg-surface-elevated ring-1 ring-hairline" : "bg-canvas-inset hover:bg-surface-elevated"
                }`}
              >
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{
                    backgroundColor:
                      activePartner?.color ||
                      resolveExpertColor(null, activePartner?.expertId || activePartner?.key || "none"),
                  }}
                  aria-hidden
                />
                <span className="min-w-0 truncate font-medium leading-none">
                  {activePartner?.label || activePartner?.name || "选择专家"}
                </span>
                <ChevronDown
                  size={12}
                  className={`shrink-0 text-ink-muted transition-transform ${partnerMenuOpen ? "rotate-180" : ""}`}
                />
              </button>
              {partnerMenuOpen && (
                <div
                  role="listbox"
                  aria-label="对话对象"
                  className="absolute bottom-full left-0 z-30 mb-2 w-72 overflow-hidden rounded-xl border border-hairline bg-canvas py-1 shadow-[0_8px_30px_rgba(0,0,0,0.08)]"
                >
                  <p className="px-3 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wider text-ink-muted">
                    对话对象
                  </p>
                  {mentionTargets.map((t) => {
                    const selected = t.key === activePartner?.key;
                    const disabled = t.selectable === false;
                    const statusLabel = disabled
                      ? "不可调度"
                      : t.status === "online"
                        ? "在线"
                        : t.status === "offline"
                          ? "离线"
                          : expertLabel(t.packId);
                    const accent = t.color || resolveExpertColor(null, t.expertId || t.key);
                    return (
                      <button
                        key={t.key}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        aria-disabled={disabled}
                        disabled={disabled}
                        title={disabled ? "绑定节点离线，不可调度" : undefined}
                        onClick={() => {
                          if (disabled) return;
                          selectExpertFromToolbar(t.key);
                          setPartnerMenuOpen(false);
                        }}
                        className={`flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors ${
                          disabled
                            ? "cursor-not-allowed opacity-45"
                            : selected
                              ? "bg-surface-elevated"
                              : "hover:bg-surface-default"
                        }`}
                      >
                        <span
                          className="h-2.5 w-2.5 shrink-0 rounded-full"
                          style={{ backgroundColor: accent }}
                          aria-hidden
                        />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5">
                            <span className="truncate text-sm font-medium text-ink">
                              {t.label || t.name}
                            </span>
                            {t.status === "online" && !disabled && (
                              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-status-success" />
                            )}
                          </span>
                          <span className="mt-0.5 block truncate text-[11px] text-ink-muted">
                            {t.subtitle || statusLabel}
                          </span>
                        </span>
                        {selected && !disabled ? (
                          <Check size={14} className="shrink-0 text-ink" strokeWidth={2.25} />
                        ) : (
                          <span className="shrink-0 text-[10px] font-medium text-ink-muted">
                            {statusLabel}
                          </span>
                        )}
                      </button>
                    );
                  })}
                  {mentionTargets.length === 0 && (
                    <p className="px-3 py-3 text-xs text-ink-muted">暂无可用对象</p>
                  )}
                </div>
              )}
            </div>

            {showPentestControls && (
              <div ref={modeMenuRef} className="relative">
                <button
                  type="button"
                  aria-haspopup="listbox"
                  aria-expanded={modeMenuOpen}
                  title="工作流偏好（用户意图；AgentRow 显示 Session 实际模式）"
                  onClick={() => {
                    setModeMenuOpen((open) => !open);
                    setPartnerMenuOpen(false);
                  }}
                  className={`${CHAT_COMPOSER_MODE_CONTROL_CLASS} text-ink transition-colors ${
                    modeMenuOpen ? "bg-surface-elevated ring-1 ring-hairline" : "bg-canvas-inset hover:bg-surface-elevated"
                  }`}
                >
                  <Target size={12} className="shrink-0 text-ink-muted" />
                  <span className="min-w-0 truncate font-medium leading-none">{activeModeLabel}</span>
                  <ChevronDown
                    size={12}
                    className={`shrink-0 text-ink-muted transition-transform ${modeMenuOpen ? "rotate-180" : ""}`}
                  />
                </button>
                {modeMenuOpen && (
                  <div
                    role="listbox"
                    aria-label="工作流偏好"
                    className="absolute bottom-full left-0 z-30 mb-2 w-64 overflow-hidden rounded-xl border border-hairline bg-canvas py-1 shadow-[0_8px_30px_rgba(0,0,0,0.08)]"
                  >
                    <p className="px-3 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wider text-ink-muted">
                      工作流偏好
                    </p>
                    <button
                      type="button"
                      role="option"
                      aria-selected={engagementTemplate == null}
                      onClick={() => {
                        onEngagementTemplate(null);
                        setModeMenuOpen(false);
                      }}
                      className={`flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition-colors ${
                        engagementTemplate == null ? "bg-surface-elevated" : "hover:bg-surface-default"
                      }`}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium text-ink">
                          {ENGAGEMENT_UNSPECIFIED_LABEL}
                        </span>
                        <span className="mt-0.5 block text-[11px] leading-snug text-ink-muted">
                          不强制改模式：已在 Graph 则保持；否则 Free
                        </span>
                      </span>
                      {engagementTemplate == null && (
                        <Check size={14} className="mt-0.5 shrink-0 text-ink" strokeWidth={2.25} />
                      )}
                    </button>
                    {ENGAGEMENT_TEMPLATES.map((t) => {
                      const selected = t.id === engagementTemplate;
                      return (
                        <button
                          key={t.id}
                          type="button"
                          role="option"
                          aria-selected={selected}
                          onClick={() => {
                            onEngagementTemplate(t.id);
                            setModeMenuOpen(false);
                          }}
                          className={`flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition-colors ${
                            selected ? "bg-surface-elevated" : "hover:bg-surface-default"
                          }`}
                        >
                          <span className="min-w-0 flex-1">
                            <span className="block text-sm font-medium text-ink">{t.label}</span>
                            <span className="mt-0.5 block text-[11px] leading-snug text-ink-muted">
                              {t.description}
                            </span>
                          </span>
                          {selected && (
                            <Check size={14} className="mt-0.5 shrink-0 text-ink" strokeWidth={2.25} />
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {showPentestControls && (
              <button
                type="button"
                aria-pressed={goalModeEnabled}
                aria-label="Goal mode"
                title={goalModeEnabled ? "Goal 已开启" : "开启 Goal 模式"}
                onClick={() => onGoalMode(!goalModeEnabled)}
                className={`${CHAT_COMPOSER_GOAL_CONTROL_CLASS} transition-colors ${
                  goalModeEnabled
                    ? "bg-ink text-on-ink"
                    : "bg-canvas-inset text-ink-secondary hover:bg-surface-elevated"
                }`}
              >
                Goal
              </button>
            )}
          </div>
          <div className={CHAT_COMPOSER_ACTIONS_CLASS}>
            {composerTimerText != null && (
              <span
                data-testid="composer-work-timer"
                className="font-mono text-xs tabular-nums text-ink-muted"
                title={workBurst?.authorize_paused ? "等待授权（不计工作时间）" : "本轮工作时长"}
              >
                {composerTimerText}
              </span>
            )}
            {running ? (
              <button
                type="button"
                disabled={interrupting}
                onClick={onInterrupt}
                className={`${CHAT_COMPOSER_SUBMIT_CONTROL_CLASS} bg-severity-critical text-white transition-opacity hover:opacity-90 disabled:opacity-70`}
              >
                {interrupting ? "中断中…" : "中断"}
              </button>
            ) : null}
            <button
              type="button"
              onClick={submit}
              disabled={!input.trim()}
              title={running ? "工作中：加入队列" : undefined}
              className={`${CHAT_COMPOSER_SUBMIT_CONTROL_CLASS} bg-ink text-on-ink transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-35`}
            >
              发送
            </button>
          </div>
        </div>
      </div>
    </div>
  );
});

export default ChatComposer;
