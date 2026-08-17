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

export function convQuery(runtime: ToolRuntime): string {
  const id = String(runtime.task.conversationId || "").trim();
  return id ? `?conversation_id=${encodeURIComponent(id)}` : "";
}

/** Host hang from explicit args, or the single on-ledger Scope Host. Never invent. */
export function resolveIntelHang(
  params: { asset_id?: unknown; port?: unknown },
  scopeHosts?: Array<{ id?: string; on_ledger?: boolean }> | null,
): { asset_id: string; port?: string } | null {
  const assetId = String(params.asset_id || "").trim();
  const port = String(params.port || "").trim() || undefined;
  if (assetId) return { asset_id: assetId, ...(port ? { port } : {}) };
  const ledger = (scopeHosts || []).filter((h) => h && h.on_ledger !== false && String(h.id || "").trim());
  if (ledger.length !== 1) return null;
  return { asset_id: String(ledger[0].id).trim(), ...(port ? { port } : {}) };
}

export async function recordIntelRow(
  runtime: ToolRuntime,
  payload: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const res = await platformLedgerFetch(runtime, "POST", `/api/node/ledger/intel${convQuery(runtime)}`, payload);
  if (res.ok && res.data && typeof res.data === "object") {
    await emitIntelUpsert(runtime, (res.data as { intel?: unknown }).intel);
  }
  return res;
}

export async function listIntelRows(
  runtime: ToolRuntime,
  opts?: { asset_id?: string; port?: string; limit?: number },
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const limit = Math.min(200, Math.max(1, Number(opts?.limit || 50) || 50));
  let path = `/api/node/ledger/intel${convQuery(runtime)}`;
  path += path.includes("?") ? "&" : "?";
  path += `limit=${limit}`;
  if (opts?.asset_id) path += `&asset_id=${encodeURIComponent(opts.asset_id)}`;
  if (opts?.port) path += `&port=${encodeURIComponent(opts.port)}`;
  return platformLedgerFetch(runtime, "GET", path);
}

export async function getIntelRow(
  runtime: ToolRuntime,
  intelId: string,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  return platformLedgerFetch(
    runtime,
    "GET",
    `/api/node/ledger/intel/${encodeURIComponent(intelId)}${convQuery(runtime)}`,
  );
}

export async function forgetIntelRow(
  runtime: ToolRuntime,
  intelId: string,
  reason?: string,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const res = await platformLedgerFetch(
    runtime,
    "POST",
    `/api/node/ledger/intel/${encodeURIComponent(intelId)}/forget${convQuery(runtime)}`,
    { reason: String(reason || "").trim() },
  );
  if (res.ok && res.data && typeof res.data === "object") {
    await emitIntelUpsert(runtime, (res.data as { intel?: unknown }).intel);
  }
  return res;
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
      const res = await recordIntelRow(runtime, payload);
      return jsonResult(res.data, { isError: !res.ok });
    },
  };
}

export function createPlatformListIntelTool(runtime: ToolRuntime): AgentTool<any> {
  return {
    name: "platform_list_intel",
    label: "Platform list intel",
    description:
      "List **living** notebook rows (id + summary + hang). Forgotten rows are omitted. " +
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
      "Read one living notebook row by id (full body). Forgotten ids are not found.",
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
      "Hard-forget a notebook row (已忘记). reason required. Prefer upsert on the same id to correct.",
    parameters: Type.Object({
      id: Type.String(),
      reason: Type.String(),
    }),
    async execute(_id: string, params: any) {
      const intelId = String(params.id || params.intel_id || "").trim();
      const reason = String(params.reason || "").trim();
      if (!intelId) return textResult("error: id required", { isError: true });
      if (reason.length < 2) return textResult("error: reason required", { isError: true });
      const res = await platformLedgerFetch(
        runtime,
        "POST",
        `/api/node/ledger/intel/${encodeURIComponent(intelId)}/forget${convQuery(runtime)}`,
        { reason },
      );
      if (res.ok && res.data && typeof res.data === "object") {
        await emitIntelUpsert(runtime, (res.data as { intel?: unknown }).intel);
      }
      return jsonResult(res.data, { isError: !res.ok });
    },
  };
}
