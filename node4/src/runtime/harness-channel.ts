/**
 * Product harness channel — not the operator user turn (#455).
 *
 * pi-ai Message is only user | assistant | toolResult, so convertToLlm maps
 * role=harness → user with a ## Runtime fence. Transcript / keep-tail / audit
 * keep role=harness so continue, persist-pass, and checkpoint are not operator.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";

/** Same fence as `LAYER_HEADING.runtime` — kept local so stores can import this file. */
const RUNTIME_HEADING = "## Runtime";

export const HARNESS_ROLE = "harness" as const;

export const HARNESS_CONTINUE_NOTICE =
  "This is a runtime continue, not a new operator instruction.";

export type HarnessMessage = {
  role: typeof HARNESS_ROLE;
  content: string;
  timestamp: number;
};

declare module "@earendil-works/pi-agent-core" {
  interface CustomAgentMessages {
    harness: HarnessMessage;
  }
}

export function isHarnessMessage(message: unknown): message is HarnessMessage {
  return Boolean(
    message &&
      typeof message === "object" &&
      (message as { role?: unknown }).role === HARNESS_ROLE,
  );
}

export function makeHarnessMessage(text: string, timestamp = Date.now()): HarnessMessage {
  return {
    role: HARNESS_ROLE,
    content: String(text || ""),
    timestamp,
  };
}

/** Agent-visible continue / persist / checkpoint body under the Runtime fence. */
export function formatHarnessForLlm(text: string): string {
  const t = String(text || "").trim();
  if (!t) return RUNTIME_HEADING;
  if (t.startsWith(RUNTIME_HEADING)) return t;
  return `${RUNTIME_HEADING}\n${t}`;
}

/** Join Case-speech / live-index prefixes; empty parts dropped. */
export function joinHarnessPrefixes(...parts: Array<string | undefined>): string | undefined {
  const kept = parts.map((p) => String(p || "").trim()).filter(Boolean);
  return kept.length ? kept.join("\n\n") : undefined;
}

export function convertNode4MessagesToLlm(messages: AgentMessage[]): Message[] {
  const out: Message[] = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    if (isHarnessMessage(message)) {
      out.push({
        role: "user",
        content: formatHarnessForLlm(message.content),
        timestamp: message.timestamp || Date.now(),
      });
      continue;
    }
    const role = (message as { role?: string }).role;
    if (role === "user" || role === "assistant" || role === "toolResult") {
      out.push(message as Message);
    }
  }
  return out;
}
