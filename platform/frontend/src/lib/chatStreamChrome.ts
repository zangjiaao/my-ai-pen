/**
 * Conversation stream chrome (Spec #326 / #323 UI seam):
 * - Messenger-style day separators + message clock times
 * - Structured denylist for infra status notices (tooling_health-class)
 *
 * No free-text NLP for product routing — only structured type/field tokens.
 */
import { phaseLabel } from "./phase";

/** Infra/health status tokens (phase / type / status_kind). Expand only with explicit amend. */
export const INFRA_STATUS_TOKENS = new Set<string>(["tooling_health"]);

/**
 * True when a status/system payload is infrastructure noise, not product chat chrome.
 * engagement_closeout and other user-meaningful system gists stay visible unless listed here.
 */
export function isInfraStatusNotice(
  content: Record<string, unknown>,
  msgType?: string,
): boolean {
  const mt = String(msgType || "").trim().toLowerCase();
  if (mt === "engagement_closeout") return false;
  if (String(content.type || "").trim().toLowerCase() === "engagement_closeout") return false;

  // Nested structured health payload (live Node status_update may carry this).
  if (content.tooling_health != null && typeof content.tooling_health === "object") {
    return true;
  }

  for (const key of ["phase", "agent_phase", "type", "status_kind", "notice_kind"] as const) {
    const token = String(content[key] ?? "").trim().toLowerCase();
    if (token && INFRA_STATUS_TOKENS.has(token)) return true;
  }
  return false;
}

function parsePhaseFromText(text: string): string {
  return text.match(/Phase:\s*([^\s(]+)/)?.[1] || "";
}

/** Legacy synthetic phase ticks — already hidden as StatusNotice (pre-#326). */
export function isLegacyPhaseOnlyStatus(content: Record<string, unknown>): boolean {
  const phase =
    typeof content.phase === "string" ? content.phase : parsePhaseFromText(String(content.text || ""));
  if (!["intake", "recon", "analysis", "verify", "report", "complete"].includes(phase)) return false;
  const text = String(content.text || "").trim();
  return (
    Boolean(content.synthetic) ||
    !text ||
    text === phaseLabel(phase) ||
    text.startsWith(`Phase: ${phase}`)
  );
}

export function statusNoticeDisplayText(content: Record<string, unknown>): string {
  const phase =
    typeof content.phase === "string" ? content.phase : parsePhaseFromText(String(content.text || ""));
  return phase ? phaseLabel(phase) : String(content.text || "");
}

/**
 * External stream projection: should this status/system/engagement_closeout row
 * appear as centered StatusNotice chrome?
 */
export function shouldRenderStatusNotice(message: {
  role?: string;
  msg_type?: string;
  content?: Record<string, unknown> | null;
}): boolean {
  const content =
    message.content && typeof message.content === "object" && !Array.isArray(message.content)
      ? (message.content as Record<string, unknown>)
      : {};
  const msgType = String(message.msg_type || "");
  const role = String(message.role || "");

  const isStatusPath =
    role === "system" || msgType === "status" || msgType === "engagement_closeout";
  if (!isStatusPath) return false;

  if (isInfraStatusNotice(content, msgType)) return false;

  if (msgType === "engagement_closeout" || String(content.type || "") === "engagement_closeout") {
    return Boolean(String(content.text || "").trim());
  }

  if (isLegacyPhaseOnlyStatus(content)) return false;
  return Boolean(String(statusNoticeDisplayText(content) || "").trim());
}

// --- Day / time stamps -------------------------------------------------------

export function parseMessageDate(iso: string | undefined | null): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Local calendar day key YYYY-MM-DD for messenger orientation. */
export function calendarDayKey(iso: string | undefined | null): string | null {
  const d = parseMessageDate(iso);
  if (!d) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function localDayKeyFromDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function shouldInsertDaySeparator(
  previousCreatedAt: string | undefined | null,
  currentCreatedAt: string | undefined | null,
): boolean {
  const curr = calendarDayKey(currentCreatedAt);
  if (!curr) return false;
  const prev = calendarDayKey(previousCreatedAt);
  return prev !== curr;
}

/** Messenger-style day label (local calendar; Chinese product UI). */
export function formatChatDaySeparator(iso: string, now: Date = new Date()): string {
  const d = parseMessageDate(iso);
  if (!d) return "";
  const dayKey = calendarDayKey(iso);
  if (!dayKey) return "";
  const today = localDayKeyFromDate(now);
  const yesterdayDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const yesterday = localDayKeyFromDate(yesterdayDate);
  if (dayKey === today) return "今天";
  if (dayKey === yesterday) return "昨天";
  if (d.getFullYear() === now.getFullYear()) {
    return `${d.getMonth() + 1}月${d.getDate()}日`;
  }
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

/** Local HH:mm clock for message stamps. */
export function formatChatMessageTime(iso: string | undefined | null): string {
  const d = parseMessageDate(iso);
  if (!d) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export type StreamChromeItem<T> =
  | { kind: "day_separator"; dayKey: string; label: string }
  | { kind: "message"; message: T };

/**
 * Project a chronological message list into stream rows with day separators.
 * Callers may pre-filter suppressed status messages.
 */
export function projectStreamWithDaySeparators<T extends { created_at?: string }>(
  messages: T[],
  now: Date = new Date(),
): StreamChromeItem<T>[] {
  const out: StreamChromeItem<T>[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const prev = i > 0 ? messages[i - 1] : undefined;
    if (shouldInsertDaySeparator(prev?.created_at, msg.created_at)) {
      const dayKey = calendarDayKey(msg.created_at);
      if (dayKey) {
        out.push({
          kind: "day_separator",
          dayKey,
          label: formatChatDaySeparator(String(msg.created_at), now),
        });
      }
    }
    out.push({ kind: "message", message: msg });
  }
  return out;
}
