/**
 * Spec #308 — Package turn aggregator (S-turn / S4 / S8).
 *
 * package start → chronological process → Delivery when terminal.
 * Running turns have no Delivery. failed ≠ interrupted.
 */

import {
  filterWorkerAgentMessages,
  readAgentId,
  readPackageTurnId,
  type MessageLike,
} from "./workerAuditChannel";

export type DeliveryStatus = "ok" | "failed" | "interrupted";
export type PackageTurnStatus = "running" | DeliveryStatus;

export type HandoffFields = {
  target: string;
  scope: string;
  already_done: string;
  this_turn_goal: string;
  success_criteria: string;
  assignment?: string;
};

export type PackageTurn = {
  packageTurnId: string;
  agentId: string;
  ordinal: number;
  status: PackageTurnStatus;
  handoff: HandoffFields;
  process: MessageLike[];
  delivery: {
    status: DeliveryStatus;
    summary: string;
    settlement?: Record<string, unknown>;
  } | null;
  startedAt?: string;
  endedAt?: string;
};

const HANDOFF_KEYS = [
  "target",
  "scope",
  "already_done",
  "this_turn_goal",
  "success_criteria",
] as const;

export function emptyHandoff(): HandoffFields {
  return {
    target: "",
    scope: "",
    already_done: "",
    this_turn_goal: "",
    success_criteria: "",
  };
}

export function parseHandoff(raw: unknown): HandoffFields {
  const src =
    raw && typeof raw === "object"
      ? (raw as Record<string, unknown>)
      : {};
  const nested =
    src.handoff && typeof src.handoff === "object"
      ? (src.handoff as Record<string, unknown>)
      : src;
  const out = emptyHandoff();
  for (const k of HANDOFF_KEYS) {
    out[k] = String(nested[k] || "").trim();
  }
  const assignment = String(nested.assignment || "").trim();
  if (assignment) out.assignment = assignment;
  return out;
}

export function mapDeliveryStatus(raw: unknown): DeliveryStatus {
  const s = String(raw || "").trim().toLowerCase();
  if (s === "ok" || s === "success" || s === "completed" || s === "done") return "ok";
  if (s === "interrupted" || s === "aborted" || s === "canceled" || s === "cancelled") {
    return "interrupted";
  }
  return "failed";
}

/**
 * Aggregate Case messages for one Worker into Package turns (chronological).
 * Messages without package_turn_id are ignored (honest empty for legacy).
 */
export function buildPackageTurns(
  messages: MessageLike[],
  agentId: string,
): PackageTurn[] {
  const scoped = filterWorkerAgentMessages(messages, agentId);
  const byTurn = new Map<string, MessageLike[]>();
  const order: string[] = [];

  for (const m of scoped) {
    const turnId = readPackageTurnId(m);
    if (!turnId) continue;
    if (!byTurn.has(turnId)) {
      byTurn.set(turnId, []);
      order.push(turnId);
    }
    byTurn.get(turnId)!.push(m);
  }

  const turns: PackageTurn[] = [];
  let ordinal = 0;
  for (const turnId of order) {
    ordinal += 1;
    const frames = byTurn.get(turnId) || [];
    // Stable chronological order
    frames.sort((a, b) =>
      String(a.created_at || "").localeCompare(String(b.created_at || "")),
    );

    let handoff = emptyHandoff();
    let delivery: PackageTurn["delivery"] = null;
    const process: MessageLike[] = [];
    let startedAt: string | undefined;
    let endedAt: string | undefined;
    let resolvedAgent = String(agentId || "").trim();

    for (const m of frames) {
      const t = String(m.msg_type || "").trim();
      const content = m.content && typeof m.content === "object" ? m.content : {};
      const aid = readAgentId(m);
      if (aid) resolvedAgent = aid;

      if (t === "worker_package_start") {
        handoff = parseHandoff(content);
        startedAt = m.created_at || startedAt;
        continue;
      }
      if (t === "worker_package_delivery") {
        const status = mapDeliveryStatus(content.status);
        delivery = {
          status,
          summary: String(content.summary || "").trim(),
          settlement:
            content.settlement && typeof content.settlement === "object"
              ? (content.settlement as Record<string, unknown>)
              : undefined,
        };
        endedAt = m.created_at || endedAt;
        continue;
      }
      // Process: thinking / text / tool_call (and progressive aliases)
      if (
        t === "thinking" ||
        t === "text" ||
        t === "tool_call" ||
        t === "reasoning" ||
        t === "agent_thinking" ||
        t === "tool_output"
      ) {
        process.push(m);
      }
    }

    const status: PackageTurnStatus = delivery ? delivery.status : "running";
    turns.push({
      packageTurnId: turnId,
      agentId: resolvedAgent,
      ordinal,
      status,
      handoff,
      process,
      delivery,
      startedAt,
      endedAt,
    });
  }

  return turns;
}

/** Default selection: latest Package turn (including running). */
export function selectDefaultTurnId(turns: PackageTurn[]): string | null {
  if (!turns.length) return null;
  return turns[turns.length - 1].packageTurnId;
}

/** Merge history prefix + live frames without dropping prefix (S5). */
export function mergeHistoryAndLive(
  history: MessageLike[],
  live: MessageLike[],
): MessageLike[] {
  const byKey = new Map<string, MessageLike>();
  const keyOf = (m: MessageLike): string => {
    const content = m.content && typeof m.content === "object" ? m.content : {};
    const streamId = String(content.stream_id || "").trim();
    if (streamId) return `stream:${streamId}`;
    const toolRun = String(content.tool_run_id || "").trim();
    if (toolRun) return `tool:${toolRun}:${String(content.status || "")}`;
    if (m.id) return `id:${m.id}`;
    return `anon:${m.msg_type}:${m.created_at}:${readPackageTurnId(m)}`;
  };
  for (const m of history) byKey.set(keyOf(m), m);
  for (const m of live) {
    const k = keyOf(m);
    const prev = byKey.get(k);
    if (!prev) {
      byKey.set(k, m);
      continue;
    }
    // Prefer longer progressive text / later tool status
    const prevC = prev.content || {};
    const nextC = m.content || {};
    const prevText = String(prevC.text || prevC.reasoning || "");
    const nextText = String(nextC.text || nextC.reasoning || "");
    if (nextText.length >= prevText.length) {
      byKey.set(k, { ...prev, ...m, content: { ...prevC, ...nextC } });
    } else {
      byKey.set(k, {
        ...prev,
        ...m,
        content: { ...nextC, ...prevC, text: prevText, reasoning: prevC.reasoning || prevText },
      });
    }
  }
  return Array.from(byKey.values()).sort((a, b) =>
    String(a.created_at || "").localeCompare(String(b.created_at || "")),
  );
}
