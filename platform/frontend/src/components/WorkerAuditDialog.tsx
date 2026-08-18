/**
 * Spec #308 — Worker process audit modal (master–detail C).
 * V1: read-only process audit + Case display_name rename.
 *
 * Process stream reuses main-chat MessageRenderer (thinking / tool / text) —
 * do not fork a second card chrome for Worker audit.
 */
import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import type { Message } from "../lib/types";
import type { MessageLike } from "../lib/workerAuditChannel";
import {
  buildPackageTurns,
  selectDefaultTurnId,
  type PackageTurn,
  type PackageTurnStatus,
} from "../lib/workerAuditTurns";
import { resolveWorkerDisplayName, normalizeDisplayNameWrite } from "../lib/workerDisplayName";
import MessageRenderer from "./MessageRenderer";

type Props = {
  open: boolean;
  agentId: string;
  panelName?: string;
  workerOrdinal?: number;
  overrides?: Record<string, string>;
  messages: Message[];
  onClose: () => void;
  onRename?: (agentId: string, displayName: string) => Promise<void>;
};

function statusLabel(status: PackageTurnStatus): string {
  if (status === "running") return "running";
  if (status === "ok") return "ok";
  if (status === "interrupted") return "interrupted";
  return "failed";
}

function statusBadgeClass(status: PackageTurnStatus): string {
  if (status === "running") return "bg-status-running/15 text-status-running";
  if (status === "ok") return "bg-status-success/15 text-status-success";
  if (status === "interrupted") return "bg-ink-muted/15 text-ink-secondary";
  return "bg-severity-critical/15 text-severity-critical";
}

function clip(s: string, n: number): string {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  if (t.length <= n) return t;
  return `${t.slice(0, Math.max(0, n - 1))}…`;
}

export default function WorkerAuditDialog({
  open,
  agentId,
  panelName,
  workerOrdinal,
  overrides,
  messages,
  onClose,
  onRename,
}: Props) {
  const displayName = resolveWorkerDisplayName({
    agentId,
    overrides,
    panelName,
    workerOrdinal,
  });

  const turns = useMemo(() => buildPackageTurns(messages, agentId), [messages, agentId]);
  const [selectedTurnId, setSelectedTurnId] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [handoffOpen, setHandoffOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSelectedTurnId(selectDefaultTurnId(turns));
    setRenaming(false);
    setRenameError(null);
    setHandoffOpen(false);
  }, [open, agentId]);

  // When new turns arrive live, keep selection if still valid; else latest.
  useEffect(() => {
    if (!open) return;
    if (selectedTurnId && turns.some((t) => t.packageTurnId === selectedTurnId)) return;
    setSelectedTurnId(selectDefaultTurnId(turns));
  }, [open, turns, selectedTurnId]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const selected: PackageTurn | null =
    turns.find((t) => t.packageTurnId === selectedTurnId) || turns[turns.length - 1] || null;

  const submitRename = async () => {
    if (!onRename) return;
    const norm = normalizeDisplayNameWrite(renameDraft);
    if (!norm.ok) {
      setRenameError(norm.error);
      return;
    }
    setRenameBusy(true);
    setRenameError(null);
    try {
      await onRename(agentId, norm.value);
      setRenaming(false);
    } catch (err) {
      setRenameError(err instanceof Error ? err.message : String(err));
    } finally {
      setRenameBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center theme-overlay p-4"
      data-testid="worker-audit-dialog"
      onClick={onClose}
    >
      <div
        className="flex h-[min(720px,90vh)] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-hairline bg-canvas shadow-lg"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`Worker audit: ${displayName}`}
      >
        {/* Header */}
        <div className="flex shrink-0 items-center gap-3 border-b border-hairline px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-base font-semibold" data-testid="worker-audit-title">
              {displayName}
            </h2>
            <p className="truncate font-mono text-[11px] text-ink-muted" title={agentId}>
              {agentId}
            </p>
          </div>
          {onRename && !renaming && (
            <button
              type="button"
              className="rounded-md border border-hairline bg-canvas px-2.5 py-1 text-xs text-ink-secondary hover:bg-canvas-inset"
              onClick={() => {
                setRenameDraft(displayName && displayName !== "Worker" ? displayName : "");
                setRenaming(true);
              }}
              data-testid="worker-audit-rename"
            >
              重命名
            </button>
          )}
          <button
            type="button"
            className="rounded-md border border-hairline p-1.5 text-ink-muted hover:bg-canvas-inset"
            onClick={onClose}
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {renaming && (
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-hairline bg-canvas-inset px-4 py-2">
            <input
              className="min-w-[12rem] flex-1 rounded-md border border-hairline bg-canvas px-2 py-1 text-sm"
              value={renameDraft}
              onChange={(e) => setRenameDraft(e.target.value)}
              placeholder="显示名称（留空恢复 Worker N）"
              maxLength={64}
              disabled={renameBusy}
              data-testid="worker-audit-rename-input"
            />
            <button
              type="button"
              className="rounded-md bg-ink px-2.5 py-1 text-xs font-medium text-on-ink disabled:opacity-50"
              disabled={renameBusy}
              onClick={() => void submitRename()}
            >
              {renameBusy ? "保存中…" : "保存"}
            </button>
            <button
              type="button"
              className="rounded-md border border-hairline px-2.5 py-1 text-xs text-ink-secondary"
              disabled={renameBusy}
              onClick={() => setRenaming(false)}
            >
              取消
            </button>
            {renameError && <span className="w-full text-xs text-severity-critical">{renameError}</span>}
          </div>
        )}

        {/* Master–detail body */}
        <div className="flex min-h-0 flex-1">
          {/* Left: Package list */}
          <aside className="flex w-[240px] shrink-0 flex-col border-r border-hairline bg-canvas-inset">
            <div className="px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-ink-muted">
              Packages
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2 pt-0.5">
              {turns.length === 0 ? (
                <p className="px-2 py-4 text-xs text-ink-muted" data-testid="worker-audit-empty-turns">
                  尚无派工记录
                </p>
              ) : (
                turns.map((turn) => {
                  const active = turn.packageTurnId === selected?.packageTurnId;
                  return (
                    <button
                      key={turn.packageTurnId}
                      type="button"
                      onClick={() => setSelectedTurnId(turn.packageTurnId)}
                      className={`mb-0.5 w-full rounded-md px-2.5 py-2 text-left transition-colors ${
                        active ? "bg-status-running/10" : "hover:bg-canvas"
                      }`}
                      data-testid={`worker-package-row-${turn.ordinal}`}
                    >
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs font-semibold">Package {turn.ordinal}</span>
                        <span
                          className={`ml-auto rounded px-1.5 py-0.5 text-[10px] font-medium uppercase ${statusBadgeClass(turn.status)}`}
                        >
                          {statusLabel(turn.status)}
                        </span>
                      </div>
                      <p className="mt-0.5 truncate text-[11px] text-ink-secondary" title={turn.handoff.this_turn_goal}>
                        {clip(turn.handoff.this_turn_goal || "（无目标）", 48)}
                      </p>
                    </button>
                  );
                })
              )}
            </div>
          </aside>

          {/* Right: detail */}
          <main className="min-w-0 flex-1 overflow-y-auto bg-canvas p-4">
            {!selected ? (
              <p className="text-sm text-ink-muted">选择左侧 Package 查看过程</p>
            ) : (
              <TurnDetail turn={selected} handoffOpen={handoffOpen} setHandoffOpen={setHandoffOpen} />
            )}
          </main>
        </div>
      </div>
    </div>
  );
}

function TurnDetail({
  turn,
  handoffOpen,
  setHandoffOpen,
}: {
  turn: PackageTurn;
  handoffOpen: boolean;
  setHandoffOpen: (v: boolean) => void;
}) {
  const h = turn.handoff;
  return (
    <div className="space-y-3" data-testid="worker-turn-detail">
      {/* Package card */}
      <section className="rounded-xl border border-hairline bg-canvas-inset/60 p-3">
        <div className="flex items-start gap-2">
          <span className="shrink-0 rounded bg-status-running/10 px-1.5 py-0.5 text-[10px] font-bold uppercase text-status-running">
            Package {turn.ordinal}
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold leading-snug">{h.this_turn_goal || "（无 this_turn_goal）"}</h3>
            {h.target && (
              <p className="mt-1 truncate font-mono text-[11px] text-ink-secondary" title={h.target}>
                target: {h.target}
              </p>
            )}
          </div>
        </div>
        <button
          type="button"
          className="mt-2 text-[11px] text-ink-muted underline-offset-2 hover:underline"
          onClick={() => setHandoffOpen(!handoffOpen)}
        >
          {handoffOpen ? "收起 handoff" : "展开 handoff 字段"}
        </button>
        {handoffOpen && (
          <dl className="mt-2 space-y-1.5 text-[11px]">
            {(
              [
                ["target", h.target],
                ["scope", h.scope],
                ["already_done", h.already_done],
                ["this_turn_goal", h.this_turn_goal],
                ["success_criteria", h.success_criteria],
                ...(h.assignment ? ([["assignment", h.assignment]] as const) : []),
              ] as [string, string][]
            ).map(([key, val]) => (
              <div key={key}>
                <dt className="font-mono text-ink-muted">{key}</dt>
                <dd className="whitespace-pre-wrap break-words text-ink-secondary">{val || "—"}</dd>
              </div>
            ))}
          </dl>
        )}
      </section>

      {/* Process stream — same cards as main Conversation chat */}
      <section>
        <h4 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-ink-muted">Process</h4>
        {turn.process.length === 0 ? (
          <p className="rounded-lg border border-dashed border-hairline px-3 py-6 text-center text-xs text-ink-muted" data-testid="worker-process-empty">
            过程未记录（历史 Case 或尚未产生 thinking/tool）
          </p>
        ) : (
          <div className="space-y-0" data-testid="worker-process-stream">
            {turn.process.map((m, idx) => {
              const message = toAuditMessage(m, turn.packageTurnId, idx);
              if (!message) return null;
              const prevRaw = idx > 0 ? turn.process[idx - 1] : null;
              const previousMessage = prevRaw
                ? toAuditMessage(prevRaw, turn.packageTurnId, idx - 1) || undefined
                : undefined;
              return (
                <MessageRenderer
                  key={message.id}
                  message={message}
                  previousMessage={previousMessage}
                  sessionActive={turn.status === "running"}
                />
              );
            })}
          </div>
        )}
      </section>

      {/* Delivery — only when terminal */}
      {turn.delivery && (
        <section
          className={`rounded-xl border p-3 ${
            turn.delivery.status === "ok"
              ? "border-status-success/35 bg-status-success/5"
              : turn.delivery.status === "interrupted"
                ? "border-hairline bg-canvas-inset"
                : "border-severity-critical/35 bg-severity-critical/5"
          }`}
          data-testid="worker-delivery-card"
        >
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold uppercase">Delivery</span>
            <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase ${statusBadgeClass(turn.delivery.status)}`}>
              {turn.delivery.status}
            </span>
          </div>
          {turn.delivery.summary && (
            <p className="mt-1.5 whitespace-pre-wrap text-xs text-ink-secondary">{turn.delivery.summary}</p>
          )}
        </section>
      )}
    </div>
  );
}

/** Map audit process frames onto main-chat Message shape for MessageRenderer. */
function toAuditMessage(
  raw: MessageLike,
  packageTurnId: string,
  index: number,
): Message | null {
  let msgType = String(raw.msg_type || "").trim();
  if (!msgType) return null;
  // Progressive alias → tool_call so ToolCallCard matches Main chat.
  if (msgType === "tool_output") msgType = "tool_call";
  if (
    msgType !== "thinking" &&
    msgType !== "reasoning" &&
    msgType !== "agent_thinking" &&
    msgType !== "tool_call" &&
    msgType !== "text"
  ) {
    return null;
  }
  const content =
    raw.content && typeof raw.content === "object" && !Array.isArray(raw.content)
      ? { ...raw.content }
      : {};
  const role = (raw.role === "user" || raw.role === "system" ? raw.role : "agent") as Message["role"];
  return {
    id: String(raw.id || `${packageTurnId}-p-${index}`),
    conversation_id: "",
    role,
    msg_type: msgType,
    content,
    parent_msg_id: null,
    created_at: String(raw.created_at || ""),
  };
}
