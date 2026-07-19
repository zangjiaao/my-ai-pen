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
    description:
      "List vulnerabilities/findings from the platform ledger (user-wide by default). " +
      "Call at task start on a known Scope host: open priors are a re-verify workstream " +
      "(re-prove + finding(confirm) → rediscovery merge), not a skip list. " +
      "Also check before booking to avoid inventing duplicate titles for the same issue. " +
      "Rows with multiple_discoveries=true were rediscovered before. Read-only.",
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

export function createPlatformListReportsTool(runtime: ToolRuntime): ToolDefinition<any> {
  return {
    name: "platform_list_reports",
    label: "Platform list reports",
    description:
      "List delivery report revisions already saved for this conversation/Case (newest first). Read-only.",
    parameters: Type.Object({
      limit: Type.Optional(Type.Number()),
    }),
    async execute(_id: string, params: any) {
      const cid = String(runtime.task.conversationId || "").trim();
      if (!cid) return textResult("error: no conversation_id on task", { isError: true });
      const limit = Math.min(100, Math.max(1, Number(params.limit || 50) || 50));
      const res = await platformLedgerFetch(
        runtime,
        "GET",
        `/api/node/ledger/conversations/${encodeURIComponent(cid)}/reports?limit=${limit}`,
      );
      return jsonResult(res.data, { isError: !res.ok });
    },
  };
}

export function createPlatformCreateReportTool(runtime: ToolRuntime): ToolDefinition<any> {
  return {
    name: "platform_create_report",
    label: "Platform create report",
    description:
      "REQUIRED when the user asks for a vulnerability/detection/delivery report. " +
      "First platform_list_vulnerabilities, then pass a full professional markdown body " +
      "(## 1 summary … ## 6 disclaimer continuous; each finding: title/severity/location/description/PoC/impact/remediation). " +
      "Do NOT only paste the report in chat — this tool persists a Case report revision for the top-bar 报告 drawer. " +
      "Do not invent findings not on the ledger. Not for every booking — only on explicit report request.",
    parameters: Type.Object({
      title: Type.String(),
      markdown: Type.String(),
      summary: Type.Optional(Type.String()),
      finding_ids: Type.Optional(Type.Array(Type.String())),
      created_by: Type.Optional(Type.String()),
    }),
    async execute(_id: string, params: any) {
      const cid = String(runtime.task.conversationId || "").trim();
      if (!cid) return textResult("error: no conversation_id on task", { isError: true });
      const title = String(params.title || "").trim();
      const markdown = String(params.markdown || "").trim();
      if (!title) return textResult("error: title required", { isError: true });
      if (markdown.length < 40) {
        return textResult(
          "error: markdown too short — write a full delivery report body (summary + findings with PoC/impact/remediation)",
          { isError: true },
        );
      }
      const findingIds = Array.isArray(params.finding_ids)
        ? params.finding_ids.map(String).filter(Boolean)
        : [];
      const body = {
        title,
        markdown,
        summary: String(params.summary || "").trim() || undefined,
        finding_ids: findingIds,
        created_by:
          String(params.created_by || "").trim() ||
          String((runtime.task as { expertName?: string }).expertName || "agent"),
        meta: {
          seat: runtime.rolePackId || "default",
          task_id: runtime.task.taskId,
        },
      };
      const res = await platformLedgerFetch(
        runtime,
        "POST",
        `/api/node/ledger/conversations/${encodeURIComponent(cid)}/reports`,
        body,
      );
      // Notify platform UI that a new report revision exists.
      if (res.ok) {
        try {
          await runtime.platform.send({
            type: "report_created",
            conversation_id: cid,
            task_id: runtime.task.taskId,
            report: (res.data as { report?: unknown })?.report ?? res.data,
          } as any);
        } catch {
          /* non-fatal */
        }
      }
      return jsonResult(res.data, { isError: !res.ok });
    },
  };
}

export function createPlatformListExpertsTool(runtime: ToolRuntime): ToolDefinition<any> {
  return {
    name: "platform_list_experts",
    label: "Platform list experts",
    description:
      "List product experts (id, name, pack_id, online) for multi-agent handoff. " +
      "Call before request_user_decision(kind=handoff). If count is 0, handoff is impossible — stay on default / current seat.",
    parameters: Type.Object({
      pack_id: Type.Optional(Type.String({ description: "Filter by pack e.g. pentest | ctf | code-audit" })),
    }),
    async execute(_id: string, params: any) {
      const packFilter = String(params.pack_id || "").trim().toLowerCase();
      const res = await platformLedgerFetch(runtime, "GET", "/api/node/ledger/experts");
      if (!res.ok || !res.data || typeof res.data !== "object") {
        return jsonResult(res.data ?? { error: "list experts failed" }, { isError: true });
      }
      const data = res.data as {
        experts?: Array<Record<string, unknown>>;
        pack_ids?: string[];
        can_handoff?: boolean;
        note?: string;
      };
      let experts = Array.isArray(data.experts) ? data.experts : [];
      if (packFilter) {
        experts = experts.filter((e) => String(e.pack_id || "").toLowerCase() === packFilter);
      }
      return jsonResult({
        ok: true,
        experts,
        count: experts.length,
        pack_ids: data.pack_ids || [],
        can_handoff: Boolean(data.can_handoff) && experts.length > 0,
        note: data.note,
      });
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
  platform_list_reports: createPlatformListReportsTool,
  platform_create_report: createPlatformCreateReportTool,
  platform_list_experts: createPlatformListExpertsTool,
};
