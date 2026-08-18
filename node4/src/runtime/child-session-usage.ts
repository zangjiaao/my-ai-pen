/**
 * Narrow child-session usage observer (Spec #487).
 *
 * Subscribes to a Sub/package pi session and records assistant `message_end`
 * usage onto an LlmUsageLedger. Does **not** attach Main observability
 * (no text/status/health/checkpoint fan-out).
 */

import {
  LlmUsageLedger,
  loadLlmCostRatesFromEnv,
  type LlmUsageSnapshot,
} from "./llm-usage.js";

export type ChildSessionLike = {
  subscribe: (listener: (event: unknown) => void | Promise<void>) => (() => void) | void;
};

export type ChildUsageMeter = {
  ledger: LlmUsageLedger;
  snapshot: () => LlmUsageSnapshot;
  unsubscribe: () => void;
  dispose: () => void;
};

/**
 * Attach a usage-only listener to a child pi session.
 * Cold sessions create a fresh ledger; warm resumes pass the existing meter
 * and do not call this again.
 */
export function attachChildSessionUsage(options: {
  session: ChildSessionLike;
  ledger?: LlmUsageLedger;
  onRecorded?: (snapshot: LlmUsageSnapshot) => void;
}): ChildUsageMeter {
  const ledger = options.ledger ?? new LlmUsageLedger(loadLlmCostRatesFromEnv());
  const unsubRaw = options.session.subscribe((event: unknown) => {
    if (!event || typeof event !== "object") return;
    const ev = event as { type?: string; message?: unknown };
    if (ev.type !== "message_end") return;
    const message = ev.message;
    if (!message || typeof message !== "object") return;
    if (String((message as { role?: unknown }).role || "") !== "assistant") return;
    const recorded = ledger.recordAssistantMessage(message);
    if (recorded) {
      try {
        options.onRecorded?.(ledger.snapshot());
      } catch {
        /* observability must not change package settlement */
      }
    }
  });

  let unsubscribed = false;
  const unsubscribe = () => {
    if (unsubscribed) return;
    unsubscribed = true;
    if (typeof unsubRaw === "function") {
      try {
        unsubRaw();
      } catch {
        /* ignore */
      }
    }
  };

  return {
    ledger,
    snapshot: () => ledger.snapshot(),
    unsubscribe,
    dispose: unsubscribe,
  };
}
