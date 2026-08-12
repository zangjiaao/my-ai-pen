import { useEffect, useState, type ReactNode } from "react";
import type { Message } from "../lib/types";
import type { SecurityAsset, SecurityEvidence, SecurityVulnerability } from "../lib/securityTypes";
import { isTruthyNewFlag } from "../lib/findingNew";
import { PROCESS_LEADING_SLOT_CLASS } from "../lib/processChromeIcon";
import { isInfraStatusNotice, isLegacyPhaseOnlyStatus } from "../lib/chatStreamChrome";
import ChoiceCard from "./cards/ChoiceCard";
import ThinkingCard from "./cards/ThinkingCard";
import { ToolCallCard } from "./cards/ToolCallCard";
import { LoadingPixelMark } from "./LoadingState";
import MarkdownText from "./MarkdownText";
import type { ChoiceDecision } from "../lib/choiceCard";
import { formatAgentDurationLabel, resultAnchorWorkSeconds } from "../lib/workBurstTime";
import { isSteerDeliveryQueued, STEER_QUEUED_HINT } from "../lib/steerDelivery";

interface Props {
  message: Message;
  agentNameById?: Record<string, string>;
  previousMessage?: Message;
  fallbackPentestNodeId?: string | null;
  platformAgentNodeId?: string | null;
  onDecision?: (requestId: string, decision: "authorize" | "cancel") => void;
  /** Spec #313 next_steps single-select confirm + optional supplement. */
  onConfirmOptions?: (
    requestId: string,
    selectedOptionIds: string[],
    cardContent: Record<string, unknown>,
    supplement?: string,
  ) => void;
  onOpenVulnerability?: (finding: Partial<SecurityVulnerability>) => void;
  onOpenAsset?: (asset: Partial<SecurityAsset>) => void;
  onOpenEvidence?: (evidence: Partial<SecurityEvidence>) => void;
  highlightedApprovalId?: string | null;
  approvalDecisionByRequestId?: Record<string, ChoiceDecision>;
  /** Spec #312: selected option ids by request_id (hydrate read-only next_steps). */
  choiceSelectedByRequestId?: Record<string, string[]>;
  /** Case actively working — false clears orphan 「思考中…」 on idle/incomplete. */
  sessionActive?: boolean;
  /** Disable choice controls while a turn is running. */
  choiceDisabled?: boolean;
  /**
   * Spec #325 B1: finalized work-seconds for this message when it is the burst
   * result anchor (one duration per work-burst; not on tool/thinking cards).
   */
  resultAnchorWorkSeconds?: number | null;
}

/** Shared speaker resolution for agent messages and list-tail pending chrome (Spec #305). */
export function agentDisplayName(content: Record<string, unknown>, agentNameById: Record<string, string>, fallbackPentestNodeId?: string | null, platformAgentNodeId?: string | null): string {
  // Product expert persona wins — never show physical Node name as the speaker.
  const expertDisplay = String(content.expert_display_name || content.expertDisplayName || "").trim();
  if (expertDisplay) {
    return expertDisplay.startsWith("@") ? expertDisplay.slice(1) : expertDisplay;
  }
  const expertName = String(content.expert_name || content.expertName || "").trim();
  if (expertName) {
    return expertName.startsWith("@") ? expertName.slice(1) : expertName;
  }
  const expertId = String(content.expert_id || content.expertId || "").trim();
  if (expertId && agentNameById[expertId]) {
    return agentNameById[expertId];
  }
  // agentNameById may also be keyed by expert id only; ignore node-id keys as speaker.
  const source = String(content.agent_source || "pentest");
  if (source === "default" || source === "workspace") {
    return "\u901a\u7528\u52a9\u7406";
  }
  if (source === "platform") {
    return "\u5e73\u53f0Agent";
  }
  void fallbackPentestNodeId;
  void platformAgentNodeId;
  return "\u6e17\u900fAgent";
}

/** Same-speaker collapse rule used by MessageRenderer and pending chrome (Spec #305). */
export function shouldShowAgentSpeakerLabel(
  content: Record<string, unknown>,
  previousAgentContent: Record<string, unknown> | null | undefined,
  agentNameById: Record<string, string> = {},
  fallbackPentestNodeId?: string | null,
  platformAgentNodeId?: string | null,
): boolean {
  const label = agentDisplayName(content, agentNameById, fallbackPentestNodeId, platformAgentNodeId);
  if (!previousAgentContent) return true;
  const previousLabel = agentDisplayName(
    previousAgentContent,
    agentNameById,
    fallbackPentestNodeId,
    platformAgentNodeId,
  );
  return previousLabel !== label;
}

/** Chat card category: reuse vuln card UI; badge shows Vuln / Flag / Key. */
type FindingCardCategory = "vuln" | "flag" | "key";

function resolveFindingCardCategory(content: Record<string, unknown>): FindingCardCategory {
  const explicit = String(content.finding_kind || content.kind || content.category || "")
    .trim()
    .toLowerCase();
  if (["flag", "flags", "ctf"].includes(explicit)) return "flag";
  if (
    ["auth", "credential", "credentials", "secret", "secrets", "password", "apikey", "api_key", "aksk", "key"].includes(
      explicit,
    )
  ) {
    return "key";
  }
  if (["vuln", "vulnerability", "vulns"].includes(explicit)) return "vuln";

  const blob = [content.title, content.description, content.impact, content.poc, content.reproduction, content.flag_value]
    .map((v) => String(v || ""))
    .join("\n");
  const title = String(content.title || "").trim();
  // "Flag · …" is always a Flag object even when the challenge name contains XSS/SQLi wording.
  if (/^flag\s*[·•:：\-–—]/i.test(title) || /^flag\s+/i.test(title) || /^flag\{/i.test(title)) {
    return "flag";
  }
  if (/flag\{[^{}\n]{2,120}\}/i.test(blob) || /FLAG\{[^{}\n]{2,120}\}/.test(blob)) {
    // Prefer Flag badge when the artifact is mainly the token; keep Vuln if title is a vuln class.
    if (!/\b(sql\s*injection|sqli|xss|rce|ssrf|lfi|xxe|ssti|idor|漏洞|注入)\b/i.test(title)) {
      return "flag";
    }
  }
  if (
    /\b(api[_-]?key|access[_-]?key|secret[_-]?key|password|credential|credentials|ak\/sk)\b/i.test(blob) &&
    !/\b(sql\s*injection|sqli|xss|rce|漏洞)\b/i.test(String(content.title || ""))
  ) {
    return "key";
  }
  return "vuln";
}

function findingCardTitle(content: Record<string, unknown>, category: FindingCardCategory): string {
  if (category === "flag") {
    const direct = String(content.flag_value || "").trim();
    if (direct) return direct;
    const blob = [content.title, content.description, content.poc].map((v) => String(v || "")).join("\n");
    const m = blob.match(/flag\{[^{}\n]{2,120}\}/i) || blob.match(/FLAG\{[^{}\n]{2,120}\}/);
    if (m) return m[0];
  }
  return String(content.title || "Untitled finding");
}

function chatAuthSubtype(content: Record<string, unknown>): { label: string; badgeClass: string } {
  const blob = [content.title, content.description, content.poc, content.impact, content.location]
    .map((v) => String(v || ""))
    .join("\n")
    .toLowerCase();
  if (/\bjwt\b|\beyj[a-z0-9_-]+\./i.test(blob)) return { label: "JWT", badgeClass: "bg-status-running/12 text-status-running" };
  if (/\b(api[_-]?key|access[_-]?key|akia[0-9a-z]{12,}|ak\/sk)\b/i.test(blob)) return { label: "APIKEY", badgeClass: "bg-[#ecfeff] text-[#0e7490]" };
  if (/\b(password|passwd|pwd|密码)\b/i.test(blob)) return { label: "PASSWORD", badgeClass: "bg-[#f5f3ff] text-[#6d28d9]" };
  if (/\b(session[_-]?id|phpsessid|jsessionid)\b/i.test(blob)) return { label: "SESSION", badgeClass: "bg-[#f0fdfa] text-[#0f766e]" };
  if (/\b(bearer\s+|oauth|refresh[_-]?token|access[_-]?token)\b/i.test(blob)) return { label: "TOKEN", badgeClass: "bg-[#eef2ff] text-[#4338ca]" };
  if (/\b(private[_-]?key|secret|credential)\b/i.test(blob)) return { label: "SECRET", badgeClass: "bg-[#f8fafc] text-[#475569]" };
  return { label: "KEY", badgeClass: "bg-status-running/10 text-status-running" };
}

function VulnCard({ content, onOpen }: { content: Record<string, unknown>; onOpen?: (finding: Partial<SecurityVulnerability>) => void }) {
  const category = resolveFindingCardCategory(content);
  const severity = normalizeSeverity(content.severity);
  const keySub = category === "key" ? chatAuthSubtype(content) : null;
  const label =
    category === "vuln" ? severity : category === "flag" ? "Flag" : keySub!.label;
  const badgeClass =
    category === "vuln"
      ? severity === "critical"
        ? "bg-severity-critical-subtle text-severity-critical"
        : severity === "high"
          ? "bg-severity-high-subtle text-severity-high"
          : severity === "medium"
            ? "bg-severity-medium-subtle text-severity-medium"
            : severity === "low"
              ? "bg-severity-low-subtle text-severity-low"
              : "bg-canvas-inset text-ink-secondary"
      : category === "flag"
        ? "bg-status-success/15 text-status-success"
        : keySub!.badgeClass;
  const borderClass =
    category === "vuln"
      ? severity === "critical"
        ? "border-l-severity-critical"
        : severity === "high"
          ? "border-l-severity-high"
          : severity === "medium"
            ? "border-l-severity-medium"
            : severity === "low"
              ? "border-l-severity-low"
              : "border-l-severity-info"
      : category === "flag"
        ? "border-l-status-success"
        : "border-l-status-running";
  const description = String(content.description || content.impact || "")
    .replace(/\s+/g, " ")
    .trim();
  const subtitle = description
    ? description.length > 180
      ? `${description.slice(0, 177)}…`
      : description
    : String(content.location || content.endpoint || content.affected_asset || "").trim() || "-";
  // Spec #275 New-only: badge only when ledger create; never rediscovery chrome.
  const showNew = isTruthyNewFlag(content.created);

  return (
    <button
      type="button"
      onClick={() =>
        onOpen?.({
          ...content,
          finding_kind: category === "key" ? "auth" : category,
          kind: category === "key" ? "auth" : category,
          __surface_kind: category,
        } as Partial<SecurityVulnerability>)
      }
      className={`my-2 block w-full min-w-0 rounded-md border border-hairline bg-canvas border-l-3 ${borderClass} p-4 text-left transition-colors hover:bg-surface-default`}
    >
      <div className="mb-1 flex min-w-0 items-center gap-2">
        <span className={`inline-block flex-shrink-0 rounded-md px-2.5 py-0.5 font-mono text-[11px] font-medium uppercase ${badgeClass}`}>{label}</span>
        {showNew ? (
          <span className="inline-block flex-shrink-0 rounded-md bg-status-success/15 px-2.5 py-0.5 font-mono text-[11px] font-medium uppercase text-status-success">
            New
          </span>
        ) : null}
        <span className="min-w-0 truncate font-semibold">{findingCardTitle(content, category)}</span>
      </div>
      <p className="line-clamp-2 break-words text-sm text-ink-secondary [overflow-wrap:anywhere]">{subtitle}</p>
    </button>
  );
}

function AssetCard({ content, onOpen }: { content: Record<string, unknown>; onOpen?: (asset: Partial<SecurityAsset>) => void }) {
  const properties = content.properties as Record<string, unknown> | undefined;
  const ports = Array.isArray(content.open_ports) ? content.open_ports : Array.isArray(properties?.open_ports) ? properties.open_ports as unknown[] : [];
  const services = Array.isArray(content.services) ? content.services : Array.isArray(properties?.services) ? properties.services as unknown[] : [];
  return (
    <button type="button" onClick={() => onOpen?.(content as Partial<SecurityAsset>)} className="my-2 block w-full min-w-0 rounded-md border border-hairline bg-canvas p-4 text-left transition-colors hover:bg-surface-default">
      <div className="mb-1 flex min-w-0 items-center gap-2">
        <span className="rounded-md bg-canvas-inset px-2 py-0.5 text-xs text-ink-secondary">{String(content.asset_type || content.type || "asset")}</span>
        <span className="min-w-0 truncate font-semibold">{String(content.address || content.name || "Unknown asset")}</span>
      </div>
      <p className="break-words text-sm text-ink-secondary [overflow-wrap:anywhere]">ports: {ports.length ? ports.join(", ") : "-"} ? services: {services.length}</p>
    </button>
  );
}

function renderMentionText(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const pattern = /(@[^\s@]+)/g;
  let lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > lastIndex) parts.push(text.slice(lastIndex, index));
    parts.push(<span key={`${index}-${match[0]}`} className="font-semibold text-status-running">{match[0]}</span>);
    lastIndex = index + match[0].length;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts.length ? parts : [text];
}

function normalizeSeverity(value: unknown): string {
  const severity = String(value || "info").toLowerCase();
  return ["critical", "high", "medium", "low", "info"].includes(severity) ? severity : "info";
}
/**
 * Wall-clock tenths since mount (`0.0s` / `1m 5.3s`). Remeasures Date.now()
 * each tick so Agent streaming re-renders cannot under-count.
 */
function useMountElapsedTenthsLabel(): string {
  const [totalSec, setTotalSec] = useState(0);
  useEffect(() => {
    const startedAt = Date.now();
    const tick = () => setTotalSec(Math.max(0, (Date.now() - startedAt) / 1000));
    tick();
    const id = window.setInterval(tick, 100);
    return () => window.clearInterval(id);
  }, []);
  if (totalSec < 60) return `${totalSec.toFixed(1)}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${s.toFixed(1)}s`;
}

/**
 * List-tail Working chrome — process row aligned with Thinking / Tool:
 *
 *   【像素 Loading 格】工作中...  12.3s
 *
 * Leading is the original Drive pixel-grid (not a status light). Row metrics
 * match Think/Tool (h-7, gap-1.5). Elapsed is mount wall-clock with tenths.
 * Hide via localStorage my-ai-pen.workingChrome=0.
 */
export function AgentPendingCard({ content }: { content: Record<string, unknown> }) {
  const raw = String(content.text || "工作中...").trim() || "工作中...";
  const title =
    raw === "思考" ||
    raw === "思考中…" ||
    raw === "思考中" ||
    raw === "Working ..." ||
    raw === "Working…" ||
    /^working\b/i.test(raw)
      ? "工作中..."
      : raw;
  const elapsed = useMountElapsedTenthsLabel();

  return (
    <div
      data-testid="agent-pending-card"
      className="my-1.5 w-full min-w-0 max-w-full"
      role="status"
      aria-live="polite"
    >
      <div
        data-testid="pending-chrome-row"
        className="-mx-1 flex h-7 w-fit max-w-full min-w-0 items-center gap-1.5 rounded-md px-1 text-left"
      >
        {/* Same leading slot metrics as Brain / tool icons; mark is the pixel loader. */}
        <span className={PROCESS_LEADING_SLOT_CLASS} title="Working">
          <LoadingPixelMark variant="Drive" testId="pending-status-light" />
        </span>
        <span
          data-testid="agent-pending-title"
          className="shimmer-label shrink-0 font-sans text-[13px] font-medium"
        >
          {title}
        </span>
        <span
          data-testid="loading-state-elapsed"
          className="shrink-0 font-mono text-[12px] tabular-nums text-ink-muted"
          title="本段展示计时（挂载墙钟）"
        >
          {elapsed}
        </span>
      </div>
    </div>
  );
}
function StatusNotice({ content, msgType }: { content: Record<string, unknown>; msgType?: string }) {
  // Only engagement_closeout is product-visible; harness/status noise stays out of the stream.
  if (msgType === "engagement_closeout" || String(content.type || "") === "engagement_closeout") {
    const text = String(content.text || "").trim();
    if (!text) return null;
    return (
      <div className="my-2 text-center text-xs text-ink-muted" data-status-notice>
        {text}
      </div>
    );
  }
  if (isInfraStatusNotice(content, msgType)) return null;
  if (isLegacyPhaseOnlyStatus(content)) return null;
  // Generic status (e.g. harness abort) — not useful in multi-agent Case stream.
  return null;
}

function SystemNotice({ content, msgType }: { content: Record<string, unknown>; msgType?: string }) {
  return <StatusNotice content={content} msgType={msgType} />;
}

export default function MessageRenderer({ message, agentNameById = {}, previousMessage, fallbackPentestNodeId, platformAgentNodeId, onDecision, onConfirmOptions, onOpenVulnerability, onOpenAsset, onOpenEvidence, highlightedApprovalId, approvalDecisionByRequestId = {}, choiceSelectedByRequestId = {}, sessionActive, choiceDisabled = false, resultAnchorWorkSeconds: resultAnchorSecondsProp }: Props) {
  const { role, msg_type, content } = message;

  // Spec #163: engagement_closeout only. Generic status/harness lines are not rendered.
  if (role === "system" || msg_type === "status" || msg_type === "engagement_closeout") {
    return <SystemNotice content={content} msgType={msg_type} />;
  }

  // Spec #312: only confirm_options decisions show a user bubble (text is display content).
  // Stream datetime stamps are stream chrome (before dialogue), not per-bubble clocks.
  if (role === "user" && msg_type === "decision") {
    const decision = String(content.decision || "").trim();
    if (decision !== "confirm_options") return null;
    const decisionText = String(content.text || "").trim() || "已选择";
    return (
      <div className="my-2 flex min-w-0 justify-end">
        <div className="max-w-[70%] break-words rounded-2xl bg-surface-default px-4 py-2.5 text-sm [overflow-wrap:anywhere]">
          {renderMentionText(decisionText)}
        </div>
      </div>
    );
  }

  if (role === "user") {
    // Mid-run user_steer: FE marks delivery=queued until Agent processes after tools.
    const deliveryQueued = isSteerDeliveryQueued(content);
    return (
      <div className="my-2 flex min-w-0 flex-col items-end">
        <div className="max-w-[70%] break-words rounded-2xl bg-surface-default px-4 py-2.5 text-sm [overflow-wrap:anywhere]">{renderMentionText(String(content.text || ""))}</div>
        {deliveryQueued ? (
          <div
            className="mt-1 max-w-[70%] text-right text-xs text-ink-muted"
            data-testid="user-message-queued-hint"
          >
            {STEER_QUEUED_HINT}
          </div>
        ) : null}
      </div>
    );
  }

  const agentLabel = agentDisplayName(content, agentNameById, fallbackPentestNodeId, platformAgentNodeId);
  const previousAgentLabel = previousMessage?.role === "agent" ? agentDisplayName(previousMessage.content, agentNameById, fallbackPentestNodeId, platformAgentNodeId) : "";
  const showAgentLabel = previousAgentLabel !== agentLabel;
  // Spec #325 B1: one duration per work-burst on result anchor — never on tool/thinking.
  // Withhold 耗时 while session is active unless the parent map already assigned
  // finalized seconds (historical turns). Content-stamp fallback only when idle
  // so mid-stream replies never flash 耗时 before output finishes.
  const isToolOrThinking =
    msg_type === "tool_call"
    || msg_type === "thinking"
    || msg_type === "reasoning"
    || msg_type === "agent_thinking";
  const b1Seconds = isToolOrThinking
    ? null
    : (resultAnchorSecondsProp != null
      ? resultAnchorSecondsProp
      : (sessionActive ? null : resultAnchorWorkSeconds(content)));
  let body: ReactNode;
  switch (msg_type) {
    case "tool_call":
      body = (
        <ToolCallCard
          content={content}
          onOpenEvidence={onOpenEvidence}
          sessionActive={sessionActive}
        />
      );
      break;
    case "vuln_card":
    case "vuln_found":
      body = <VulnCard content={content} onOpen={onOpenVulnerability} />;
      break;
    case "asset_card":
    case "asset_discovered":
      body = <AssetCard content={content} onOpen={onOpenAsset} />;
      break;
    case "confirm_card":
    case "choice_card": {
      const rid = String(content.request_id || "");
      body = (
        <ChoiceCard
          content={content}
          decision={approvalDecisionByRequestId[rid]}
          selectedOptionIds={choiceSelectedByRequestId[rid]}
          highlighted={Boolean(content.request_id && content.request_id === highlightedApprovalId)}
          disabled={choiceDisabled}
          onAuthorize={() => onDecision?.(content.request_id as string, "authorize")}
          onCancel={() => onDecision?.(content.request_id as string, "cancel")}
          onConfirmOptions={(ids, supplement) =>
            onConfirmOptions?.(String(content.request_id || ""), ids, content, supplement)
          }
        />
      );
      break;
    }
    case "agent_pending":
      body = <AgentPendingCard content={content} />;
      break;
    case "thinking":
    case "reasoning":
    case "agent_thinking":
      body = <ThinkingCard content={content} sessionActive={sessionActive} />;
      break;
    case "status":
    case "engagement_closeout":
      body = <StatusNotice content={content} msgType={msg_type} />;
      break;
    case "text":
    default:
      body = <MarkdownText text={String(content.text || "")} />;
  }

  // Spec #325 B1: total work duration only on Agent result (bottom-right), not user bubbles.
  // Stream datetime stamps live in ConversationPage chrome *before* dialogue.
  return (
    <div className="my-2 min-w-0">
      {showAgentLabel && (
        <div className="mb-1 flex items-center gap-2 text-xs text-ink-muted">
          <span className="font-medium text-ink-secondary">{agentLabel}</span>
        </div>
      )}
      <div className="relative min-w-0">
        {body}
        {b1Seconds != null && (
          <div
            data-testid="burst-result-duration"
            className="mt-1 flex justify-start"
            title="本轮工作总耗时"
          >
            <span className="text-[11px] tabular-nums text-ink-muted">
              {formatAgentDurationLabel(b1Seconds)}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}




