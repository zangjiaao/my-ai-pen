/**
 * Platform Intel (线索 / 情报) tools — Agent notebook on Host / Service.
 * Spec: docs/specs/owner-intel.md
 *
 * Agent supplies hang + kind + summary + body only. Harness stamps id / audit / New.
 */
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolRuntime } from "../types.js";
import { jsonResult, textResult } from "./common.js";
import { platformLedgerFetch } from "./platform.js";

const KIND_HELP =
  "credential_status | secret | token | flag | path_hint | account | config. " +
  "Pick the closest; do not invent a kind. Missing kind records as config.";

function convQuery(runtime: ToolRuntime): string {
  const id = String(runtime.task.conversationId || "").trim();
  return id ? `?conversation_id=${encodeURIComponent(id)}` : "";
}

async function emitIntelUpsert(runtime: ToolRuntime, row: unknown): Promise<void> {
  if (!row || typeof row !== "object") return;
  const intel = row as Record<string, unknown>;
  const id = String(intel.id || "").trim();
  if (!id) return;
  try {
    await runtime.platform.send({
      type: "intel_upsert",
      conversation_id: runtime.task.conversationId,
      task_id: runtime.task.taskId,
      intel,
    });
  } catch {
    /* non-fatal — snapshot still has the row */
  }
}

export function createPlatformRecordIntelTool(runtime: ToolRuntime): AgentTool<any> {
  return {
    name: "platform_record_intel",
    label: "Platform record intel",
    description:
      "Notebook on an **existing** Host or Service. Create (omit id) or update (pass id). " +
      "Write what you need to keep across turns / Sessions / compact — not a Finding, not a chore. " +
      "Args: asset_id (Host), optional port (Service), kind, summary, body. " +
      "Do not invent a Host to hang a clue. Do not pass timestamps, source, or new. " +
      KIND_HELP,
    parameters: Type.Object({
      asset_id: Type.String({ description: "Host asset id" }),
      port: Type.Optional(Type.String({ description: "Service port; omit to hang on the Host" })),
      kind: Type.Optional(Type.String({ description: KIND_HELP })),
      summary: Type.String({ description: "Short line for list / inject / compact" }),
      body: Type.String({ description: "Natural-language 情报/线索; full text via get(id)" }),
      id: Type.Optional(Type.String({ description: "Existing intel id to update" })),
    }),
    async execute(_id: string, params: any) {
      const assetId = String(params.asset_id || "").trim();
      if (!assetId) return textResult("error: asset_id required (hang on an existing Host)", { isError: true });
      const summary = String(params.summary || "").trim();
      const body = String(params.body || "").trim();
      if (summary.length < 2) return textResult("error: summary required", { isError: true });
      if (!body) return textResult("error: body required", { isError: true });
      const payload: Record<string, unknown> = {
        asset_id: assetId,
        kind: params.kind,
        summary,
        body,
      };
      const port = String(params.port || "").trim();
      if (port) payload.port = port;
      const intelId = String(params.id || "").trim();
      if (intelId) payload.id = intelId;
      const res = await platformLedgerFetch(runtime, "POST", `/api/node/ledger/intel${convQuery(runtime)}`, payload);
      if (res.ok && res.data && typeof res.data === "object") {
        await emitIntelUpsert(runtime, (res.data as { intel?: unknown }).intel);
      }
      return jsonResult(res.data, { isError: !res.ok });
    },
  };
}

export function createPlatformListIntelTool(runtime: ToolRuntime): AgentTool<any> {
  return {
    name: "platform_list_intel",
    label: "Platform list intel",
    description:
      "List **living** notebook rows (id + summary + hang). Soft-forgotten and 遗忘区 are omitted. " +
      "Optional asset_id / port filters. Full body via platform_get_intel(id).",
    parameters: Type.Object({
      asset_id: Type.Optional(Type.String()),
      port: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Number()),
      offset: Type.Optional(Type.Number()),
    }),
    async execute(_id: string, params: any) {
      const limit = Math.min(200, Math.max(1, Number(params.limit || 50) || 50));
      const offset = Math.max(0, Number(params.offset || 0) || 0);
      let path = `/api/node/ledger/intel${convQuery(runtime)}`;
      path += path.includes("?") ? "&" : "?";
      path += `limit=${limit}&offset=${offset}`;
      const assetId = String(params.asset_id || "").trim();
      const port = String(params.port || "").trim();
      if (assetId) path += `&asset_id=${encodeURIComponent(assetId)}`;
      if (port) path += `&port=${encodeURIComponent(port)}`;
      const res = await platformLedgerFetch(runtime, "GET", path);
      return jsonResult(res.data, { isError: !res.ok });
    },
  };
}

export function createPlatformGetIntelTool(runtime: ToolRuntime): AgentTool<any> {
  return {
    name: "platform_get_intel",
    label: "Platform get intel",
    description:
      "Read one notebook row by id (full body). Living and soft-forgotten succeed. " +
      "遗忘区 (second forget) is not found.",
    parameters: Type.Object({
      id: Type.String(),
    }),
    async execute(_id: string, params: any) {
      const intelId = String(params.id || params.intel_id || "").trim();
      if (!intelId) return textResult("error: id required", { isError: true });
      const res = await platformLedgerFetch(
        runtime,
        "GET",
        `/api/node/ledger/intel/${encodeURIComponent(intelId)}${convQuery(runtime)}`,
      );
      return jsonResult(res.data, { isError: !res.ok });
    },
  };
}

export function createPlatformForgetIntelTool(runtime: ToolRuntime): AgentTool<any> {
  return {
    name: "platform_forget_intel",
    label: "Platform forget intel",
    description:
      "Forget a notebook row by id. First forget = leave working memory (update still allowed). " +
      "Second forget = 遗忘区 (operator-only; later Agent calls on that id fail).",
    parameters: Type.Object({
      id: Type.String(),
    }),
    async execute(_id: string, params: any) {
      const intelId = String(params.id || params.intel_id || "").trim();
      if (!intelId) return textResult("error: id required", { isError: true });
      const res = await platformLedgerFetch(
        runtime,
        "POST",
        `/api/node/ledger/intel/${encodeURIComponent(intelId)}/forget${convQuery(runtime)}`,
        {},
      );
      if (res.ok && res.data && typeof res.data === "object") {
        await emitIntelUpsert(runtime, (res.data as { intel?: unknown }).intel);
      }
      return jsonResult(res.data, { isError: !res.ok });
    },
  };
}
