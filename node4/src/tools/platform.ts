/**
 * Platform ledger tools — Node calls authenticated platform HTTP APIs.
 * Policy (user-only host create) is enforced server-side; client also refuses create ops.
 */
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ToolRuntime } from "../types.js";
import { jsonResult, textResult } from "./common.js";

/** Pure policy: node tools must never request host creation. */
export function isHostCreateAttempt(op: string, body: Record<string, unknown> | null | undefined): boolean {
  const o = String(op || "").toLowerCase().trim();
  if (o === "create_asset" || o === "create_host" || o === "add_host") return true;
  if (!body || typeof body !== "object") return false;
  if (body.create_host === true || body.create === true) return true;
  // enrich must include existing asset_id — bare address without id is treated as create intent
  if (o === "enrich_asset" && !String(body.asset_id || body.id || "").trim() && String(body.address || body.host || "").trim()) {
    return true;
  }
  return false;
}

export async function platformLedgerFetch(
  runtime: ToolRuntime,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const api = runtime.platformApi;
  if (!api?.baseUrl || !api.nodeToken) {
    return { ok: false, status: 0, data: { error: "platform API not configured (NODE_TOKEN / PLATFORM_HTTP_URL)" } };
  }
  const url = `${api.baseUrl.replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${api.nodeToken}`,
    "X-Node-Token": api.nodeToken,
    "Content-Type": "application/json",
    "X-Conversation-Id": String(runtime.task.conversationId || ""),
  };
  const res = await fetch(url, {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
  });
  let data: unknown = null;
  const text = await res.text();
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text.slice(0, 2000) };
  }
  return { ok: res.ok, status: res.status, data };
}

function convQuery(runtime: ToolRuntime): string {
  const id = String(runtime.task.conversationId || "").trim();
  return id ? `?conversation_id=${encodeURIComponent(id)}` : "";
}

export function createPlatformListAssetsTool(runtime: ToolRuntime): ToolDefinition<any> {
  return {
    name: "platform_list_assets",
    label: "Platform list assets",
    description: "List assets from the platform ledger (hosts the user registered). Read-only.",
    parameters: Type.Object({
      limit: Type.Optional(Type.Number()),
      q: Type.Optional(Type.String()),
    }),
    async execute(_id: string, params: any) {
      const limit = Math.min(100, Math.max(1, Number(params.limit || 50) || 50));
      const q = String(params.q || "").trim();
      let path = `/api/node/ledger/assets${convQuery(runtime)}`;
      path += path.includes("?") ? "&" : "?";
      path += `limit=${limit}`;
      if (q) path += `&q=${encodeURIComponent(q)}`;
      const res = await platformLedgerFetch(runtime, "GET", path);
      return jsonResult(res.data, { isError: !res.ok });
    },
  };
}

export function createPlatformGetAssetTool(runtime: ToolRuntime): ToolDefinition<any> {
  return {
    name: "platform_get_asset",
    label: "Platform get asset",
    description: "Get one asset by id from the platform ledger.",
    parameters: Type.Object({
      asset_id: Type.String(),
    }),
    async execute(_id: string, params: any) {
      const assetId = String(params.asset_id || "").trim();
      if (!assetId) return textResult("error: asset_id required", { isError: true });
      const res = await platformLedgerFetch(
        runtime,
        "GET",
        `/api/node/ledger/assets/${encodeURIComponent(assetId)}${convQuery(runtime)}`,
      );
      return jsonResult(res.data, { isError: !res.ok });
    },
  };
}

export function createPlatformListVulnerabilitiesTool(runtime: ToolRuntime): ToolDefinition<any> {
  return {
    name: "platform_list_vulnerabilities",
    label: "Platform list vulnerabilities",
    description: "List vulnerabilities/findings from the platform ledger. Read-only.",
    parameters: Type.Object({
      limit: Type.Optional(Type.Number()),
      status: Type.Optional(Type.String()),
    }),
    async execute(_id: string, params: any) {
      const limit = Math.min(100, Math.max(1, Number(params.limit || 50) || 50));
      const status = String(params.status || "").trim();
      let path = `/api/node/ledger/vulnerabilities${convQuery(runtime)}`;
      path += path.includes("?") ? "&" : "?";
      path += `limit=${limit}`;
      if (status) path += `&status=${encodeURIComponent(status)}`;
      const res = await platformLedgerFetch(runtime, "GET", path);
      return jsonResult(res.data, { isError: !res.ok });
    },
  };
}

export function createPlatformGetVulnerabilityTool(runtime: ToolRuntime): ToolDefinition<any> {
  return {
    name: "platform_get_vulnerability",
    label: "Platform get vulnerability",
    description: "Get one vulnerability by id from the platform ledger.",
    parameters: Type.Object({
      vulnerability_id: Type.String(),
    }),
    async execute(_id: string, params: any) {
      const vid = String(params.vulnerability_id || "").trim();
      if (!vid) return textResult("error: vulnerability_id required", { isError: true });
      const res = await platformLedgerFetch(
        runtime,
        "GET",
        `/api/node/ledger/vulnerabilities/${encodeURIComponent(vid)}${convQuery(runtime)}`,
      );
      return jsonResult(res.data, { isError: !res.ok });
    },
  };
}

export function createPlatformUpdateFindingStatusTool(runtime: ToolRuntime): ToolDefinition<any> {
  return {
    name: "platform_update_finding_status",
    label: "Platform update finding status",
    description: "Update vulnerability management status: to_fix | fixing | fixed.",
    parameters: Type.Object({
      vulnerability_id: Type.String(),
      status: Type.String(),
    }),
    async execute(_id: string, params: any) {
      const vid = String(params.vulnerability_id || "").trim();
      const status = String(params.status || "").trim().toLowerCase();
      if (!vid) return textResult("error: vulnerability_id required", { isError: true });
      if (!["to_fix", "fixing", "fixed"].includes(status)) {
        return textResult("error: status must be to_fix | fixing | fixed", { isError: true });
      }
      const res = await platformLedgerFetch(
        runtime,
        "PATCH",
        `/api/node/ledger/vulnerabilities/${encodeURIComponent(vid)}${convQuery(runtime)}`,
        { status },
      );
      return jsonResult(res.data, { isError: !res.ok });
    },
  };
}

export function createPlatformEnrichAssetTool(runtime: ToolRuntime): ToolDefinition<any> {
  return {
    name: "platform_enrich_asset",
    label: "Platform enrich asset",
    description:
      "Enrich an **existing** host asset (ports, services, urls, api_endpoints). Requires asset_id. Cannot create hosts.",
    parameters: Type.Object({
      asset_id: Type.String(),
      ports: Type.Optional(Type.Array(Type.Any())),
      services: Type.Optional(Type.Array(Type.Any())),
      urls: Type.Optional(Type.Array(Type.String())),
      api_endpoints: Type.Optional(Type.Array(Type.Any())),
    }),
    async execute(_id: string, params: any) {
      const body = {
        asset_id: String(params.asset_id || "").trim(),
        ports: params.ports,
        services: params.services,
        urls: params.urls,
        api_endpoints: params.api_endpoints,
      };
      if (isHostCreateAttempt("enrich_asset", body)) {
        return jsonResult(
          { ok: false, error: "host create denied: provide existing asset_id only; users create hosts" },
          { isError: true },
        );
      }
      if (!body.asset_id) return textResult("error: asset_id required", { isError: true });
      const res = await platformLedgerFetch(
        runtime,
        "POST",
        `/api/node/ledger/assets/${encodeURIComponent(body.asset_id)}/enrich${convQuery(runtime)}`,
        body,
      );
      return jsonResult(res.data, { isError: !res.ok });
    },
  };
}

export function createPlatformConversationSnapshotTool(runtime: ToolRuntime): ToolDefinition<any> {
  return {
    name: "platform_conversation_snapshot",
    label: "Platform conversation snapshot",
    description: "Read conversation progress counts and recent findings from the platform (this session).",
    parameters: Type.Object({}),
    async execute() {
      const cid = String(runtime.task.conversationId || "").trim();
      if (!cid) return textResult("error: no conversation_id on task", { isError: true });
      const res = await platformLedgerFetch(
        runtime,
        "GET",
        `/api/node/ledger/conversations/${encodeURIComponent(cid)}/snapshot`,
      );
      return jsonResult(res.data, { isError: !res.ok });
    },
  };
}

/** Register all platform.* tool factories used by the default seat. */
export const PLATFORM_TOOL_FACTORIES: Record<string, (runtime: ToolRuntime) => ToolDefinition<any>> = {
  platform_list_assets: createPlatformListAssetsTool,
  platform_get_asset: createPlatformGetAssetTool,
  platform_list_vulnerabilities: createPlatformListVulnerabilitiesTool,
  platform_get_vulnerability: createPlatformGetVulnerabilityTool,
  platform_update_finding_status: createPlatformUpdateFindingStatusTool,
  platform_enrich_asset: createPlatformEnrichAssetTool,
  platform_conversation_snapshot: createPlatformConversationSnapshotTool,
};
