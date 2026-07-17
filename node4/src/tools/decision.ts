/**
 * Request a platform authorization card (ConfirmCard).
 * Blocks the tool until the user authorizes or cancels.
 */
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ToolRuntime } from "../types.js";
import { jsonResult, textResult } from "./common.js";
import { registerApprovalWait } from "../runtime/approvals.js";

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

export function createRequestUserDecisionTool(runtime: ToolRuntime): ToolDefinition<any> {
  return {
    name: "request_user_decision",
    label: "Request user authorization",
    description:
      "Show ONE authorization card and wait for Authorize/Cancel. " +
      "For execution work (pentest/CTF/…): always use kind=handoff + handoff_pack_id + target + full scope in proposed_action. " +
      "Do not chain multiple cards; do not use free-text yes/no for scope details — put defaults on the card. " +
      "After authorize on handoff, the platform starts the destination expert; keep any follow-up text very short.",
    parameters: Type.Object({
      question: Type.String({ description: "Card title — short authorization question" }),
      proposed_action: Type.Optional(
        Type.String({
          description: "Markdown body: target, scope, accounts, method, constraints (one card = complete plan)",
        }),
      ),
      risk_level: Type.Optional(
        Type.String({ description: "low | medium | intrusive | high (default intrusive)" }),
      ),
      target: Type.Optional(Type.String({ description: "Primary target URL/host (required for handoff when known)" })),
      kind: Type.Optional(
        Type.String({
          description: "handoff (start execution expert) | confirm (rare non-execution approval)",
        }),
      ),
      handoff_pack_id: Type.Optional(
        Type.String({
          description: "When kind=handoff: pentest | ctf | code-audit | llm-security | alert-triage",
        }),
      ),
      handoff_expert_id: Type.Optional(Type.String()),
      handoff_expert_name: Type.Optional(Type.String()),
    }),
    async execute(_id: string, params: any) {
      const question = String(params.question || "").trim();
      if (!question) return textResult("error: question required", { isError: true });

      const conversationId = String(runtime.task.conversationId || "").trim();
      const requestId = `${conversationId || "sess"}-${randomUUID()}`;
      const kind = String(params.kind || "confirm").trim().toLowerCase() || "confirm";
      const handoffPack = String(params.handoff_pack_id || params.pack_id || "").trim();
      const proposed = String(params.proposed_action || "").trim();
      const risk = String(params.risk_level || "intrusive").trim() || "intrusive";
      const target = String(params.target || "").trim();

      const payload: Record<string, unknown> = {
        type: "request_decision",
        conversation_id: conversationId,
        request_id: requestId,
        risk_level: risk,
        question,
        proposed_action: proposed,
        target,
        kind,
        expires_at: "",
      };
      if (kind === "handoff" || handoffPack) {
        payload.kind = "handoff";
        payload.handoff_pack_id = handoffPack || "pentest";
        if (params.handoff_expert_id) payload.handoff_expert_id = String(params.handoff_expert_id).trim();
        if (params.handoff_expert_name) {
          payload.handoff_expert_name = String(params.handoff_expert_name).trim();
        }
      }

      await runtime.platform.send(payload);

      const waitPromise = registerApprovalWait(requestId, conversationId);
      const abort = runtime.lifecycle.abortSignal;
      let onAbort: (() => void) | undefined;
      const abortPromise = new Promise<"authorize" | "cancel">((resolve) => {
        if (!abort) return;
        if (abort.aborted) {
          resolve("cancel");
          return;
        }
        onAbort = () => resolve("cancel");
        abort.addEventListener("abort", onAbort, { once: true });
      });
      const timeoutPromise = new Promise<"authorize" | "cancel">((resolve) => {
        setTimeout(() => resolve("cancel"), DEFAULT_TIMEOUT_MS);
      });

      let decision: "authorize" | "cancel";
      try {
        decision = await Promise.race([waitPromise, abortPromise, timeoutPromise]);
      } finally {
        if (onAbort && abort) abort.removeEventListener("abort", onAbort);
      }

      return jsonResult({
        ok: true,
        request_id: requestId,
        decision,
        kind: payload.kind || "confirm",
        handoff_pack_id: payload.handoff_pack_id || null,
        message:
          decision === "authorize"
            ? kind === "handoff" || handoffPack
              ? "User authorized handoff. Platform is starting the destination expert now. Reply in at most one short sentence; do not claim you ran the scan; do not emit another decision card."
              : "User authorized. Proceed within your tool policy; do not emit another decision card for the same plan."
            : "User canceled or timed out. Do not proceed with the proposed action.",
      });
    },
  };
}
