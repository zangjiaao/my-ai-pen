/**
 * Request a platform authorization card (ConfirmCard).
 * Blocks the tool until the user authorizes, cancels, or replies with free text.
 * Spec #277 §3.3 14a: click and type are the same feedback path into this Session.
 */
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolRuntime } from "../types.js";
import { jsonResult, textResult } from "./common.js";
import { registerApprovalWait, type ApprovalResult } from "../runtime/approvals.js";
import { platformLedgerFetch } from "./platform.js";

function speakerFields(runtime: ToolRuntime): { expert_id?: string; expert_name?: string } {
  // Always attribute the waiting turn to the *requesting* Session persona.
  // handoff_expert_* is card body only — never top-level speaker.
  const expertId = String(runtime.task.expertId || "").trim();
  const expertName = String(runtime.task.expertName || "").trim();
  const out: { expert_id?: string; expert_name?: string } = {};
  if (expertId) out.expert_id = expertId;
  if (expertName) out.expert_name = expertName;
  return out;
}

const GRAPH_MODE_KINDS = new Set([
  "enter_graph",
  "exit_graph",
  "switch_graph",
  "accept_enter_graph",
  "accept_exit_graph",
  "accept_switch_graph",
  "resume_parked",
  "continue_parked",
  "full_restart",
  "restart_graph",
]);

function normalizeGraphModeKind(kind: string): string {
  const k = String(kind || "").trim().toLowerCase();
  if (k === "accept_enter_graph") return "enter_graph";
  if (k === "accept_exit_graph") return "exit_graph";
  if (k === "accept_switch_graph") return "switch_graph";
  if (k === "continue_parked") return "resume_parked";
  if (k === "restart_graph") return "full_restart";
  return k;
}

export function createRequestUserDecisionTool(runtime: ToolRuntime): AgentTool<any> {
  return {
    name: "request_user_decision",
    label: "Request user authorization",
    description:
      "Show ONE choice/authorization card and wait for user feedback (button OR free-text reply). " +
      "Click and type are the same path — the tool unblocks with the user's response. " +
      "When legal entity, Host identity, Group member set, active-testing authorization, or Scope is insufficient, ask here and wait — do not invent Scope or Target. " +
      "Group / Hosts: pass asset_ids (and/or options[].asset_id = Host id from platform_list_groups / platform_list_assets). " +
      "After the user allows, the platform writes those Hosts as Case Scope; continue the user's original task — do not invent a scan workflow. " +
      "For multi-agent handoff to any listed colleague (default/assistant, pentest, CTF, …): kind=handoff + handoff_pack_id (+ handoff_expert_id) + target + proposed_action=short authorized scope (target + restatement of what the user asked). " +
      "Do not write method, RoE, playbook, or ledger-dump instructions in proposed_action — those live in Profession/Runtime. " +
      "Call platform_list_experts first when unsure who can receive the work. " +
      "Graph harness (Spec #278): kind=enter_graph|exit_graph|switch_graph + graph_id (product id e.g. app_assessment|redteam_deep). " +
      "Never silent-switch Free↔Graph — always card or user composer Workflow. " +
      "Spec #312 next_steps: at stoppable settle / empty-continue with open Case Workset, emit kind=next_steps + options[2–5] " +
      "(each id,title,body required; optional workset_item_ids binds). Multi-select; do not only say 等待指示 or prose A/B/C/D. " +
      "Do not chain multiple cards; put defaults on the card. " +
      "After authorize on handoff, the platform starts the destination expert; do not reply. " +
      "After authorize on enter/switch Graph, platform settles Session work_mode and may re-dispatch Graph. " +
      "If the tool result decision is authorize/confirm_options (including free-text reply), do not re-show the card.",
    parameters: Type.Object({
      question: Type.String({ description: "Card title — short authorization question or next_steps preamble" }),
      proposed_action: Type.Optional(
        Type.String({
          description:
            "Short authorized scope for the user card: target + restatement of what the user asked. Not method, RoE, playbook, or ledger-dump instructions.",
        }),
      ),
      risk_level: Type.Optional(
        Type.String({ description: "low | medium | intrusive | high (default intrusive)" }),
      ),
      target: Type.Optional(Type.String({ description: "Primary target URL/host (required for handoff when known)" })),
      kind: Type.Optional(
        Type.String({
          description:
            "handoff | enter_graph | exit_graph | switch_graph | confirm | next_steps. Graph kinds need graph_id (except exit_graph). next_steps needs options[2–5].",
        }),
      ),
      graph_id: Type.Optional(
        Type.String({
          description:
            "When kind=enter_graph|switch_graph: product Graph id (app_assessment | redteam_deep). Not thin lab ids.",
        }),
      ),
      handoff_pack_id: Type.Optional(
        Type.String({
          description:
            "When kind=handoff: destination pack from platform_list_experts — default | pentest | ctf | code-audit | llm-security | alert-triage",
        }),
      ),
      handoff_expert_id: Type.Optional(Type.String()),
      handoff_expert_name: Type.Optional(Type.String()),
      asset_ids: Type.Optional(
        Type.Array(
          Type.String({
            description:
              "Host ids to authorize as Case Scope (confirm = all listed). From platform_list_groups members / platform_list_assets. Not a Target.",
          }),
        ),
      ),
      /** Spec #312: curated next_steps options (2–5). */
      options: Type.Optional(
        Type.Array(
          Type.Object({
            id: Type.String({ description: "Stable option id unique within this card" }),
            title: Type.String({ description: "Short package title" }),
            body: Type.String({ description: "Why / what / success shape (required)" }),
            workset_item_ids: Type.Optional(
              Type.Array(Type.String(), { description: "Optional Case Workset item id binds" }),
            ),
            asset_id: Type.Optional(
              Type.String({ description: "Owner Host id when this option authorizes that Host as Case Scope" }),
            ),
            kind: Type.Optional(Type.String()),
          }),
        ),
      ),
      selection: Type.Optional(
        Type.String({ description: "next_steps: single (default, Spec #313) | multi" }),
      ),
      preamble: Type.Optional(Type.String({ description: "Optional markdown preamble for next_steps" })),
      presentation: Type.Optional(
        Type.String({
          description:
            "Spec #450: approval_wizard | recommendation | flat. Option cards default to approval_wizard chrome.",
        }),
      ),
      allow_custom: Type.Optional(
        Type.Boolean({
          description: "Spec #450: custom last-row answer allowed (default true for option cards).",
        }),
      ),
      questions: Type.Optional(
        Type.Array(
          Type.Object({
            id: Type.String(),
            prompt: Type.String(),
            selection: Type.Optional(Type.String({ description: "single (default) | multi" })),
            allow_custom: Type.Optional(Type.Boolean()),
            options: Type.Optional(
              Type.Array(
                Type.Object({
                  id: Type.String(),
                  title: Type.String(),
                  body: Type.Optional(Type.String()),
                  workset_item_ids: Type.Optional(Type.Array(Type.String())),
                  asset_id: Type.Optional(Type.String()),
                }),
              ),
            ),
          }),
        ),
      ),
    }),
    async execute(_id: string, params: any) {
      const question = String(params.question || "").trim();
      if (!question) return textResult("error: question required", { isError: true });

      const conversationId = String(runtime.task.conversationId || "").trim();
      const requestId = `${conversationId || "sess"}-${randomUUID()}`;
      let kind = normalizeGraphModeKind(
        String(params.kind || "confirm").trim().toLowerCase() || "confirm",
      );
      const handoffPack = String(params.handoff_pack_id || params.pack_id || "").trim();
      const proposed = String(params.proposed_action || "").trim();
      const risk = String(params.risk_level || "intrusive").trim() || "intrusive";
      const target = String(params.target || "").trim();
      const graphId = String(params.graph_id || params.engagement_template || "").trim();
      let handoffExpertId = params.handoff_expert_id ? String(params.handoff_expert_id).trim() : "";
      let handoffExpertName = params.handoff_expert_name ? String(params.handoff_expert_name).trim() : "";

      // Spec #312: normalize next_steps options (2–5, title+body, unique ids).
      let nextStepsOptions: Array<Record<string, unknown>> | undefined;
      const rawOpts = Array.isArray(params.options) ? params.options : null;
      const rawQuestions = Array.isArray(params.questions) ? params.questions : null;
      if (kind === "next_steps" || (rawOpts && rawOpts.length && rawOpts.every((o: unknown) => o && typeof o === "object"))) {
        kind = "next_steps";
        const cleaned: Array<Record<string, unknown>> = [];
        const ids = new Set<string>();
        for (const row of rawOpts || []) {
          if (!row || typeof row !== "object") continue;
          const r = row as Record<string, unknown>;
          const id = String(r.id || "").trim();
          const title = String(r.title || "").trim();
          const body = String(r.body || "").trim();
          if (!id || !title || !body || ids.has(id)) continue;
          ids.add(id);
          const opt: Record<string, unknown> = { id, title, body };
          if (Array.isArray(r.workset_item_ids)) {
            const wids = r.workset_item_ids.map((x) => String(x || "").trim()).filter(Boolean);
            if (wids.length) opt.workset_item_ids = wids;
          }
          const assetId = String(r.asset_id || "").trim();
          if (assetId) opt.asset_id = assetId;
          if (r.kind) opt.kind = String(r.kind);
          cleaned.push(opt);
        }
        if (cleaned.length < 2 || cleaned.length > 5) {
          if (!(rawQuestions && rawQuestions.length)) {
            return textResult(
              "error: kind=next_steps requires 2–5 options with unique id + non-empty title + body",
              { isError: true },
            );
          }
        } else {
          nextStepsOptions = cleaned;
        }
      }
      if (rawQuestions && rawQuestions.length) {
        kind = "next_steps";
      }

      // Graph mode permission: require graph_id for enter/switch (exit parks current).
      if (GRAPH_MODE_KINDS.has(kind)) {
        if ((kind === "enter_graph" || kind === "switch_graph" || kind === "full_restart") && !graphId) {
          return textResult(
            "error: graph_id required for enter_graph / switch_graph (e.g. app_assessment or redteam_deep)",
            { isError: true },
          );
        }
        if (graphId && /_thin$/i.test(graphId)) {
          return textResult(
            "error: lab thin graphs are not product L1; use app_assessment or redteam_deep",
            { isError: true },
          );
        }
      }

      // Handoff preflight: refuse the card when no product expert can receive the pack.
      if (kind === "handoff" || handoffPack) {
        const pack = (handoffPack || "pentest").toLowerCase();
        const res = await platformLedgerFetch(runtime, "GET", "/api/node/ledger/experts");
        const data = (res.ok && res.data && typeof res.data === "object" ? res.data : {}) as {
          experts?: Array<Record<string, unknown>>;
          can_handoff?: boolean;
        };
        const experts = Array.isArray(data.experts) ? data.experts : [];
        const packMatches = experts.filter((e) => String(e.pack_id || "").toLowerCase() === pack);
        if (!experts.length) {
          return jsonResult(
            {
              ok: false,
              decision: "cancel",
              reason: "no_product_experts",
              message:
                "No product experts are configured. Handoff is impossible — stay on the current seat or ask the user to create/bind an Expert in 专家管理.",
            },
            { isError: true },
          );
        }
        if (!packMatches.length) {
          return jsonResult(
            {
              ok: false,
              decision: "cancel",
              reason: "no_expert_for_pack",
              pack_id: pack,
              available_pack_ids: [...new Set(experts.map((e) => String(e.pack_id || "")).filter(Boolean))],
              message: `No enabled expert with pack_id=${pack}. List experts for the user or pick an available pack.`,
            },
            { isError: true },
          );
        }
        // Fill missing expert id/name from first matching online (else any) expert.
        if (!handoffExpertId) {
          const online = packMatches.find((e) => e.node_online === true) || packMatches[0];
          if (online) {
            handoffExpertId = String(online.id || "").trim();
            handoffExpertName = handoffExpertName || String(online.name || "").trim();
          }
        }
      }

      const speaker = speakerFields(runtime);
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
        // Speaker = requesting Session (never handoff destination).
        ...speaker,
      };
      if (kind === "handoff" || handoffPack) {
        payload.kind = "handoff";
        payload.handoff_pack_id = handoffPack || "pentest";
        if (handoffExpertId) payload.handoff_expert_id = handoffExpertId;
        if (handoffExpertName) payload.handoff_expert_name = handoffExpertName;
      }
      const rawAssetIds = Array.isArray(params.asset_ids) ? params.asset_ids : [];
      const assetIds = rawAssetIds.map((x: unknown) => String(x || "").trim()).filter(Boolean);
      if (assetIds.length) payload.asset_ids = assetIds;
      if (GRAPH_MODE_KINDS.has(kind)) {
        payload.kind = kind;
        if (graphId) {
          payload.graph_id = graphId;
          payload.engagement_template = graphId;
        }
      }
      if (kind === "next_steps" && nextStepsOptions) {
        payload.kind = "next_steps";
        payload.options = nextStepsOptions;
        const selection = String(params.selection || "single").trim().toLowerCase();
        payload.selection = selection === "multi" ? "multi" : "single";
        const preamble = String(params.preamble || "").trim();
        if (preamble) payload.preamble = preamble;
        payload.presentation = "approval_wizard";
        if (params.allow_custom === false) payload.allow_custom = false;
      }
      if (rawQuestions && rawQuestions.length) {
        payload.kind = "next_steps";
        payload.presentation = "approval_wizard";
        payload.questions = rawQuestions;
        if (params.allow_custom === false) payload.allow_custom = false;
      }
      const presentation = String(params.presentation || "").trim().toLowerCase();
      if (presentation === "approval_wizard" || presentation === "recommendation" || presentation === "flat") {
        payload.presentation = presentation;
      }

      await runtime.platform.send(payload as import("../types.js").PlatformMessage);

      const waitPromise = registerApprovalWait(requestId, conversationId);
      const abort = runtime.lifecycle.abortSignal;
      let onAbort: (() => void) | undefined;
      const abortPromise = new Promise<ApprovalResult>((resolve) => {
        if (!abort) return;
        if (abort.aborted) {
          resolve({ decision: "cancel" });
          return;
        }
        onAbort = () => resolve({ decision: "cancel" });
        abort.addEventListener("abort", onAbort, { once: true });
      });
      // No wall-clock auto-cancel: an unanswered card must stay parked until the
      // user decides or interrupts. A timeout that returns cancel to the model
      // continues the turn and can emit another 等待授权 card.

      let approvalResult: ApprovalResult;
      try {
        runtime.lifecycle.pendingUserDecision = true;
        approvalResult = abort
          ? await Promise.race([waitPromise, abortPromise])
          : await waitPromise;
      } finally {
        // Interrupt during the wait: leave the flag so settle can emit paused.
        // Authorize/cancel: clear so a following abort is a normal incomplete.
        if (!abort?.aborted) runtime.lifecycle.pendingUserDecision = false;
        if (onAbort && abort) abort.removeEventListener("abort", onAbort);
      }
      const decision = approvalResult.decision;

      // Session-owned handoff apply: button and free-text both resolve here.
      // Platform only displays + forwards feedback; this tool starts the destination
      // when decision is authorize for kind=handoff (single apply path).
      const isHandoff = String(payload.kind || kind) === "handoff" || Boolean(handoffPack);
      if (decision === "authorize" && isHandoff) {
        await runtime.platform.send({
          type: "handoff_apply",
          conversation_id: conversationId,
          request_id: requestId,
          kind: "handoff",
          handoff_pack_id: payload.handoff_pack_id || handoffPack || "pentest",
          handoff_expert_id: handoffExpertId || undefined,
          handoff_expert_name: handoffExpertName || undefined,
          target: target || undefined,
          proposed_action: proposed || undefined,
          question: question || undefined,
        });
      }

      // Spec #278 S3: Graph mode permission — settle Session work_mode via platform.
      const isGraphMode = GRAPH_MODE_KINDS.has(String(payload.kind || kind));
      if (decision === "authorize" && isGraphMode) {
        await runtime.platform.send({
          type: "graph_mode_apply",
          conversation_id: conversationId,
          request_id: requestId,
          kind: payload.kind || kind,
          graph_id: graphId || undefined,
          engagement_template: graphId || undefined,
          target: target || undefined,
          proposed_action: proposed || undefined,
          question: question || undefined,
          expert_id: speaker.expert_id,
          expert_name: speaker.expert_name,
        } as import("../types.js").PlatformMessage);
      }

      const graphAuthorizeMsg =
        kind === "enter_graph" || kind === "switch_graph"
          ? "User authorized Graph mode. Platform is settling Session work_mode and may re-dispatch Expert Graph. Reply in at most one short sentence; do not re-show the card; do not claim stages already ran."
          : kind === "exit_graph"
            ? "User authorized exit Graph → Free (Graph parked). Platform settled Session work_mode=free. Reply briefly; do not re-show the card."
            : "User authorized Graph mode change. Platform settled Session work_mode. Reply briefly; do not re-show the card.";

      const selectedIds = Array.isArray(approvalResult.selected_option_ids)
        ? approvalResult.selected_option_ids.map((x) => String(x || "").trim()).filter(Boolean)
        : [];
      const selectedOpts = (nextStepsOptions || []).filter((o) => selectedIds.includes(String(o.id || "")));
      const selectedHostIds = selectedOpts
        .map((o) => String(o.asset_id || "").trim())
        .filter(Boolean);
      const authorizedHosts =
        selectedHostIds.length > 0 ||
        (decision === "authorize" && assetIds.length > 0);
      const selectedBits = selectedOpts
        .map((o) => `${o.id}: ${String(o.title || "").trim()}`)
        .filter((s) => s.length > 2)
        .join("; ");
      const customText = String(approvalResult.custom_text || "").trim();
      const hostScopeMsg =
        "User authorized those Hosts as this Case Scope. Continue the user's original task; do not invent a scan workflow; do not re-show the card.";
      const nextStepsMsg =
        decision === "confirm_options"
          ? authorizedHosts
            ? hostScopeMsg
            : selectedBits
            ? `User confirmed next_steps. Selected: ${selectedBits}. Honor those option bodies; do not start unselected work; do not re-show the same card.`
            : customText
              ? `User confirmed next_steps with a custom answer: ${customText}. Honor that answer; do not re-show the same card.`
              : "User confirmed next_steps. Honor the selected option bodies; do not start unselected work; do not re-show the same card."
          : decision === "authorize" && authorizedHosts
            ? hostScopeMsg
          : decision === "authorize" && kind === "next_steps"
            ? "User replied on the next_steps card. Honor their reply; do not re-show the same card."
            : decision === "answered"
              ? "User continued in free text; this card was dismissed without selecting options. Do not re-show it; do not apply handoff or Graph mode from this wait."
              : null;

      const resultPayload: Record<string, unknown> = {
        ok: true,
        request_id: requestId,
        decision,
        kind: payload.kind || "confirm",
        handoff_pack_id: payload.handoff_pack_id || null,
        graph_id: graphId || null,
        message:
          nextStepsMsg ||
          (decision === "authorize"
            ? kind === "handoff" || handoffPack
              ? "User authorized handoff. Platform is starting the destination expert now. Do not reply; do not claim you ran the scan; do not emit another decision card."
              : isGraphMode
                ? graphAuthorizeMsg
                : "User authorized. Proceed within your tool policy; do not emit another decision card for the same plan."
            : "User canceled, dismissed, or timed out. Do not proceed with the proposed action."),
      };
      if (approvalResult.selected_option_ids?.length) {
        resultPayload.selected_option_ids = approvalResult.selected_option_ids;
      }
      if (approvalResult.workset_item_ids?.length) {
        resultPayload.workset_item_ids = approvalResult.workset_item_ids;
      }
      if (approvalResult.text) {
        resultPayload.user_text = approvalResult.text;
      }
      if (customText) {
        resultPayload.custom_text = customText;
      }
      if (Array.isArray(approvalResult.answers) && approvalResult.answers.length) {
        resultPayload.answers = approvalResult.answers;
      }
      return jsonResult(resultPayload);
    },
  };
}
