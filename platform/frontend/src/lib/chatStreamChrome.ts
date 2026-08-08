/**
 * Conversation stream chrome (Spec #326 / #323 UI seam):
 * - Centered datetime stamps before dialogue (when necessary)
 * - Suppress harness/infra status notices; keep engagement_closeout only
 *
 * No free-text NLP for product routing — structured fields + denylist only.
 */
import { phaseLabel } from "./phase";

/** Infra/health status tokens (phase / type / status_kind). Expand only with explicit amend. */
export const INFRA_STATUS_TOKENS = new Set<string>(["tooling_health"]);

/**
 * Gap (ms) between consecutive messages before a new centered timestamp is needed.
 * Same-burst chatter stays unstamped.
 */
export const STREAM_TIME_STAMP_GAP_MS = 5 * 60 * 1000;

/**
 * True when a status/system payload is infrastructure noise, not product chat chrome.
 * engagement_closeout stays visible unless empty.
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
 *
 * Product choice: generic status/harness lines (e.g. "harness abort: cancelled") are
 * not useful in multi-agent Case streams — hide all `status` / system except
 * engagement_closeout with non-empty text.
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

  // Only user-meaningful system gist kept in stream (Spec #163 closeout).
  if (msgType === "engagement_closeout" || String(content.type || "") === "engagement_closeout") {
    return Boolean(String(content.text || "").trim());
  }

  // All other status / system notices (harness abort, tooling_health, phase ticks, …) stay out.
  if (isInfraStatusNotice(content, msgType)) return false;
  if (isLegacyPhaseOnlyStatus(content)) return false;
  return false;
}

// --- Time stamps (centered, before dialogue, when necessary) -----------------

/**
 * Parse message created_at for stream chrome.
 * Rejects missing/invalid times and epoch sentinels (e.g. live-frame Date(0) placeholders
 * that used to flash as 1970/01/01 then disappear).
 */
export function parseMessageDate(iso: string | undefined | null): Date | null {
  if (iso == null) return null;
  const raw = String(iso).trim();
  if (!raw || raw === "0") return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  // Treat unix epoch ±1 day as "no real time" (placeholder / default DB zero).
  if (d.getTime() < 86_400_000) return null;
  // Product stamps are modern Case times; years before 2000 are not operator-useful.
  if (d.getFullYear() < 2000) return null;
  return d;
}

/** Local calendar day key YYYY-MM-DD. */
export function calendarDayKey(iso: string | undefined | null): string | null {
  const d = parseMessageDate(iso);
  if (!d) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Full local datetime for stream separators: 20XX/XX/XX XX:XX:XX
 */
export function formatChatMessageTime(iso: string | undefined | null): string {
  const d = parseMessageDate(iso);
  if (!d) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${y}/${m}/${day} ${hh}:${mm}:${ss}`;
}

/** @deprecated use formatChatMessageTime — kept as alias for day-label callers during transition. */
export function formatChatDaySeparator(iso: string, _now?: Date): string {
  return formatChatMessageTime(iso);
}

/**
 * Insert a centered timestamp before this message when:
 * - first renderable message in the stream, or
 * - calendar day changed, or
 * - gap from previous message ≥ STREAM_TIME_STAMP_GAP_MS
 */
export function shouldInsertStreamTimeStamp(
  previousCreatedAt: string | undefined | null,
  currentCreatedAt: string | undefined | null,
  gapMs: number = STREAM_TIME_STAMP_GAP_MS,
): boolean {
  const curr = parseMessageDate(currentCreatedAt);
  if (!curr) return false;
  const prev = parseMessageDate(previousCreatedAt);
  if (!prev) return true;
  if (calendarDayKey(previousCreatedAt) !== calendarDayKey(currentCreatedAt)) return true;
  return curr.getTime() - prev.getTime() >= gapMs;
}

/** @deprecated name — same as shouldInsertStreamTimeStamp for first-day semantics. */
export function shouldInsertDaySeparator(
  previousCreatedAt: string | undefined | null,
  currentCreatedAt: string | undefined | null,
): boolean {
  return shouldInsertStreamTimeStamp(previousCreatedAt, currentCreatedAt);
}

export type StreamChromeItem<T> =
  | { kind: "time_separator"; stampKey: string; label: string }
  /** @deprecated prefer time_separator; still accepted by ConversationPage mapper */
  | { kind: "day_separator"; dayKey: string; label: string }
  | { kind: "message"; message: T };

/**
 * Project chronological messages into stream rows with centered datetime stamps
 * **before** dialogue when necessary (not every message).
 */
export function projectStreamWithDaySeparators<T extends { created_at?: string }>(
  messages: T[],
  _now: Date = new Date(),
  gapMs: number = STREAM_TIME_STAMP_GAP_MS,
): StreamChromeItem<T>[] {
  const out: StreamChromeItem<T>[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const prev = i > 0 ? messages[i - 1] : undefined;
    if (shouldInsertStreamTimeStamp(prev?.created_at, msg.created_at, gapMs)) {
      const label = formatChatMessageTime(msg.created_at);
      if (label) {
        out.push({
          kind: "time_separator",
          stampKey: label,
          label,
        });
      }
    }
    out.push({ kind: "message", message: msg });
  }
  return out;
}

/** Alias for clarity at call sites. */
export const projectStreamWithTimeSeparators = projectStreamWithDaySeparators;
