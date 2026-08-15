/**
 * Platform ledger tools — Node calls authenticated platform HTTP APIs.
 * Host create: dedicated platform_create_asset only (user must have asked; reason required server-side).
 * enrich_asset must never smuggle create.
 */
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolRuntime } from "../types.js";
import { jsonResult, textResult } from "./common.js";

/**
 * Pure policy: enrich path must not create Hosts.
 * Dedicated create_asset tool is allowed (server requires reason = user request).
 */
export function isHostCreateAttempt(op: string, body: Record<string, unknown> | null | undefined): boolean {
  const o = String(op || "").toLowerCase().trim();
  // Explicit create tool is not an "attempt smuggled via enrich"
  if (o === "create_asset" || o === "create_host" || o === "add_host" || o === "platform_create_asset") {
    return false;
  }
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
    "X-Task-Id": String(runtime.task.taskId || ""),
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

export function createPlatformListAssetsTool(runtime: ToolRuntime): AgentTool<any> {
  return {
    name: "platform_list_assets",
    label: "Platform list assets",
    description:
      "List Hosts from the **shared owner ledger** (same inventory as 资产管理). " +
      "Use whenever the user asks what machines you can see, whether a host/tag/note is on the books, " +
      "or before claiming inventory is empty. Optional q filters address/name/tags/notes. Read-only. " +
      "Response: count=this page, total=full inventory size, has_more. Default limit 200 (max 2000). " +
      "Never treat count as total when has_more/total says otherwise.",
    parameters: Type.Object({
      limit: Type.Optional(Type.Number()),
      offset: Type.Optional(Type.Number()),
      q: Type.Optional(Type.String()),
    }),
    async execute(_id: string, params: any) {
      const limit = Math.min(2000, Math.max(1, Number(params.limit || 200) || 200));
      const offset = Math.max(0, Number(params.offset || 0) || 0);
      const q = String(params.q || "").trim();
      let path = `/api/node/ledger/assets${convQuery(runtime)}`;
      path += path.includes("?") ? "&" : "?";
      path += `limit=${limit}&offset=${offset}`;
      if (q) path += `&q=${encodeURIComponent(q)}`;
      const res = await platformLedgerFetch(runtime, "GET", path);
      return jsonResult(res.data, { isError: !res.ok });
    },
  };
}

export function createPlatformGetAssetTool(runtime: ToolRuntime): AgentTool<any> {
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

export function createPlatformListVulnerabilitiesTool(runtime: ToolRuntime): AgentTool<any> {
  return {
    name: "platform_list_vulnerabilities",
    label: "Platform list vulnerabilities",
    description:
      "List findings from the **owner ledger** (same DB as 漏洞台账). " +
      "When Scope Host is known, **pass asset_id** (from platform_list_assets / scope_intel). " +
      "Look up when you approach a path/module — pass **port** and/or **q** (title/path). " +
      "Do not dump the host ledger at kickoff. Priors are an index, not a retest queue. " +
      "Response: count=this page, total=match size, has_more. Default limit 50 (max 200). " +
      "multiple_discoveries=true means rediscovered before. Read-only.",
    parameters: Type.Object({
      limit: Type.Optional(Type.Number()),
      offset: Type.Optional(Type.Number()),
      status: Type.Optional(Type.String()),
      asset_id: Type.Optional(
        Type.String({ description: "Host asset id — prefer this when filtering one machine" }),
      ),
      asset_ids: Type.Optional(
        Type.Array(Type.String(), { description: "Multiple Host asset ids" }),
      ),
      port: Type.Optional(
        Type.String({ description: "Service port (Scope face) — prefer when looking up one site" }),
      ),
      q: Type.Optional(
        Type.String({ description: "Title / location / description needle for the surface you are about to test" }),
      ),
    }),
    async execute(_id: string, params: any) {
      const limit = Math.min(200, Math.max(1, Number(params.limit || 50) || 50));
      const offset = Math.max(0, Number(params.offset || 0) || 0);
      const status = String(params.status || "").trim();
      const assetId = String(params.asset_id || "").trim();
      const assetIds = Array.isArray(params.asset_ids)
        ? params.asset_ids.map(String).map((s) => s.trim()).filter(Boolean)
        : [];
      const port = String(params.port || "").trim();
      const q = String(params.q || params.search || "").trim();
      const unscoped = !port && !q;
      const effectiveLimit = unscoped ? Math.min(limit, 12) : limit;
      let path = `/api/node/ledger/vulnerabilities${convQuery(runtime)}`;
      path += path.includes("?") ? "&" : "?";
      path += `limit=${effectiveLimit}&offset=${offset}`;
      if (status) path += `&status=${encodeURIComponent(status)}`;
      if (assetId) path += `&asset_id=${encodeURIComponent(assetId)}`;
      for (const id of assetIds) {
        if (id === assetId) continue;
        path += `&asset_ids=${encodeURIComponent(id)}`;
      }
      if (port) path += `&port=${encodeURIComponent(port)}`;
      if (q) path += `&q=${encodeURIComponent(q)}`;
      const res = await platformLedgerFetch(runtime, "GET", path);
      const data =
        res.data && typeof res.data === "object" && !Array.isArray(res.data)
          ? {
              ...(res.data as Record<string, unknown>),
              ...(unscoped
                ? {
                    guidance:
                      "Unscoped list is an index only (capped). Pass port= and/or q= for the surface you are testing. Do not treat this page as the host's full set or a kickoff retest queue.",
                  }
                : {}),
            }
          : res.data;
      return jsonResult(data, { isError: !res.ok });
    },
  };
}

export function createPlatformGetVulnerabilityTool(runtime: ToolRuntime): AgentTool<any> {
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

export function createPlatformUpdateFindingStatusTool(runtime: ToolRuntime): AgentTool<any> {
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

export function createPlatformEnrichAssetTool(runtime: ToolRuntime): AgentTool<any> {
  return {
    name: "platform_enrich_asset",
    label: "Platform enrich asset",
    description:
      "Enrich **one existing** Host (add/remove ports like 资产管理). Requires asset_id. " +
      "remove_ports=[\"3389\"] drops those services. " +
      "For many Hosts or a whole Group, use platform_batch_enrich_assets. " +
      "To add new Hosts, use platform_create_asset.",
    parameters: Type.Object({
      asset_id: Type.String(),
      ports: Type.Optional(Type.Array(Type.Any())),
      services: Type.Optional(Type.Array(Type.Any())),
      remove_ports: Type.Optional(
        Type.Array(Type.Any(), { description: "Ports to remove from this Host" }),
      ),
      urls: Type.Optional(Type.Array(Type.String())),
      api_endpoints: Type.Optional(Type.Array(Type.Any())),
    }),
    async execute(_id: string, params: any) {
      const body = {
        asset_id: String(params.asset_id || "").trim(),
        ports: params.ports,
        services: params.services,
        remove_ports: params.remove_ports,
        urls: params.urls,
        api_endpoints: params.api_endpoints,
      };
      if (isHostCreateAttempt("enrich_asset", body)) {
        return jsonResult(
          {
            ok: false,
            error:
              "host create denied on enrich: provide existing asset_id, or use platform_create_asset when the user asked to add Hosts",
          },
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

export function createPlatformBatchEnrichAssetsTool(runtime: ToolRuntime): AgentTool<any> {
  return {
    name: "platform_batch_enrich_assets",
    label: "Platform batch enrich assets",
    description:
      "Bulk add/remove ports on **existing** Hosts in **one call**. " +
      "Add: reason=, group_name|asset_ids, ports/services. " +
      "Remove: reason=, asset_ids=[…], remove_ports=[\"3389\"] (e.g. 改回端口 after a mistaken enrich). " +
      "Does **not** create Hosts. Does **not** change Group membership — use assemble for that.",
    parameters: Type.Object({
      reason: Type.String({
        description: "Quote/summary of the user's request to change ports",
      }),
      group_id: Type.Optional(Type.String()),
      group_name: Type.Optional(Type.String({ description: "e.g. XXX公司 — enrich all members" })),
      asset_ids: Type.Optional(Type.Array(Type.String())),
      addresses: Type.Optional(Type.Array(Type.String())),
      ports: Type.Optional(Type.Array(Type.Any())),
      remove_ports: Type.Optional(Type.Array(Type.Any())),
      services: Type.Optional(
        Type.Array(
          Type.Object({
            port: Type.Any(),
            protocol: Type.Optional(Type.String()),
            name: Type.Optional(Type.String()),
          }),
        ),
      ),
    }),
    async execute(_id: string, params: any) {
      const reason = String(params.reason || "").trim();
      if (!reason) {
        return textResult("error: reason required — user must have asked to change ports", { isError: true });
      }
      const body: Record<string, unknown> = {
        reason,
        group_id: String(params.group_id || "").trim() || undefined,
        group_name: String(params.group_name || "").trim() || undefined,
        asset_ids: Array.isArray(params.asset_ids) ? params.asset_ids : undefined,
        addresses: Array.isArray(params.addresses) ? params.addresses : undefined,
        ports: params.ports,
        services: params.services,
        remove_ports: params.remove_ports,
      };
      const res = await platformLedgerFetch(
        runtime,
        "POST",
        `/api/node/ledger/assets/batch-enrich${convQuery(runtime)}`,
        body,
      );
      return jsonResult(res.data, { isError: !res.ok });
    },
  };
}

export function createPlatformCreateAssetTool(runtime: ToolRuntime): AgentTool<any> {
  return {
    name: "platform_create_asset",
    label: "Platform create asset",
    description:
      "Add Host(s) to the **shared owner ledger** (same as 资产管理) **only when the user explicitly asked**. " +
      "Pass reason= short quote/summary of their request. " +
      "address or addresses: IP/domain list; CIDR allowed (e.g. 10.0.0.0/24, max 256 hosts/call). " +
      "exclude_last_octets e.g. [1,255] skips gateway/broadcast when user asks. " +
      "group_name/group_id: put Hosts into that Group after create. " +
      "Identity is asset **id**, not address: same IP may exist in multiple Groups as different Hosts. " +
      "Merge only if that address is **already a member of the target Group**; otherwise create a new Host. " +
      "Optional ports/services apply to every host in the batch. " +
      "Do **not** invent Hosts from recon alone — only user-requested inventory.",
    parameters: Type.Object({
      reason: Type.String({
        description: "Why this is allowed: quote/summary of the user's request to add these hosts",
      }),
      address: Type.Optional(Type.String({ description: "Single IP, domain, or CIDR" })),
      addresses: Type.Optional(
        Type.Array(Type.String(), { description: "Multiple IPs/domains/CIDRs" }),
      ),
      ports: Type.Optional(Type.Array(Type.Any())),
      services: Type.Optional(
        Type.Array(
          Type.Object({
            port: Type.Any(),
            protocol: Type.Optional(Type.String()),
            name: Type.Optional(Type.String()),
          }),
        ),
      ),
      tags: Type.Optional(Type.Array(Type.String())),
      group_id: Type.Optional(Type.String({ description: "Put created Hosts into this Group id" })),
      group_name: Type.Optional(
        Type.String({ description: "Or resolve Group by name (e.g. XXX公司); ambiguous → error" }),
      ),
      assembly_ports: Type.Optional(
        Type.Array(Type.Any(), {
          description: "Ports subset for Group assembly (empty/omit = bare Host in Group)",
        }),
      ),
      exclude_last_octets: Type.Optional(
        Type.Array(Type.Number(), {
          description: "IPv4 last-octet denylist (e.g. [1,255] for gateway+broadcast)",
        }),
      ),
    }),
    async execute(_id: string, params: any) {
      const reason = String(params.reason || "").trim();
      if (!reason) {
        return textResult(
          "error: reason required — only create Hosts when the user asked; put their request in reason",
          { isError: true },
        );
      }
      const address = String(params.address || "").trim();
      const addresses = Array.isArray(params.addresses)
        ? params.addresses.map((a: unknown) => String(a || "").trim()).filter(Boolean)
        : [];
      if (!address && !addresses.length) {
        return textResult("error: address or addresses required", { isError: true });
      }
      const body: Record<string, unknown> = {
        reason,
        address: address || undefined,
        addresses: addresses.length ? addresses : undefined,
        ports: params.ports,
        services: params.services,
        tags: params.tags,
        group_id: String(params.group_id || "").trim() || undefined,
        group_name: String(params.group_name || "").trim() || undefined,
        assembly_ports: params.assembly_ports,
        exclude_last_octets: Array.isArray(params.exclude_last_octets)
          ? params.exclude_last_octets
          : undefined,
      };
      const res = await platformLedgerFetch(
        runtime,
        "POST",
        `/api/node/ledger/assets${convQuery(runtime)}`,
        body,
      );
      return jsonResult(res.data, { isError: !res.ok });
    },
  };
}

export function createPlatformListGroupsTool(runtime: ToolRuntime): AgentTool<any> {
  return {
    name: "platform_list_groups",
    label: "Platform list groups",
    description:
      "List owner ledger **Groups** (资产管理分组 / 公司·系统·项目). " +
      "Use when the user names a group (e.g. XXX公司) or asks where hosts are assembled. " +
      "Returns id, name, member_count, **addresses** (full host list), members sample. " +
      "For bulk port work on a group use platform_batch_enrich_assets(group_name=…).",
    parameters: Type.Object({
      q: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Number()),
    }),
    async execute(_id: string, params: any) {
      const limit = Math.min(100, Math.max(1, Number(params.limit || 50) || 50));
      const q = String(params.q || "").trim();
      let path = `/api/node/ledger/groups${convQuery(runtime)}`;
      path += path.includes("?") ? "&" : "?";
      path += `limit=${limit}`;
      if (q) path += `&q=${encodeURIComponent(q)}`;
      const res = await platformLedgerFetch(runtime, "GET", path);
      return jsonResult(res.data, { isError: !res.ok });
    },
  };
}

export function createPlatformCreateGroupTool(runtime: ToolRuntime): AgentTool<any> {
  return {
    name: "platform_create_group",
    label: "Platform create group",
    description:
      "Create a Group in the owner ledger **only when the user asked** (e.g. 新建XXX公司组). " +
      "reason= user request. If the name already exists, returns the existing group.",
    parameters: Type.Object({
      reason: Type.String(),
      name: Type.String(),
    }),
    async execute(_id: string, params: any) {
      const reason = String(params.reason || "").trim();
      const name = String(params.name || "").trim();
      if (!reason) return textResult("error: reason required (user must have asked)", { isError: true });
      if (!name) return textResult("error: name required", { isError: true });
      const res = await platformLedgerFetch(runtime, "POST", `/api/node/ledger/groups${convQuery(runtime)}`, {
        reason,
        name,
      });
      return jsonResult(res.data, { isError: !res.ok });
    },
  };
}

export function createPlatformAssembleGroupTool(runtime: ToolRuntime): AgentTool<any> {
  return {
    name: "platform_assemble_group",
    label: "Platform assemble group",
    description:
      "Put Hosts into a Group assembly (装入分组) when the user asked. " +
      "Resolve group by group_id or group_name (e.g. XXX公司). " +
      "Pass asset_ids and/or addresses (hosts must already exist — create first with platform_create_asset). " +
      "ports empty = bare Host in Group; non-empty = Group **view subset** only — does **NOT** add Host Service ports. " +
      "To add 22/ssh on Hosts themselves use platform_batch_enrich_assets.",
    parameters: Type.Object({
      reason: Type.String(),
      group_id: Type.Optional(Type.String()),
      group_name: Type.Optional(Type.String()),
      asset_ids: Type.Optional(Type.Array(Type.String())),
      addresses: Type.Optional(Type.Array(Type.String())),
      ports: Type.Optional(Type.Array(Type.Any())),
    }),
    async execute(_id: string, params: any) {
      const reason = String(params.reason || "").trim();
      if (!reason) return textResult("error: reason required", { isError: true });
      const groupId = String(params.group_id || "").trim();
      const groupName = String(params.group_name || "").trim();
      if (!groupId && !groupName) {
        return textResult("error: group_id or group_name required", { isError: true });
      }
      const body: Record<string, unknown> = {
        reason,
        group_id: groupId || undefined,
        group_name: groupName || undefined,
        asset_ids: Array.isArray(params.asset_ids) ? params.asset_ids : undefined,
        addresses: Array.isArray(params.addresses) ? params.addresses : undefined,
        ports: params.ports,
      };
      const res = await platformLedgerFetch(
        runtime,
        "POST",
        `/api/node/ledger/groups/assemble${convQuery(runtime)}`,
        body,
      );
      return jsonResult(res.data, { isError: !res.ok });
    },
  };
}

export function createPlatformConversationSnapshotTool(runtime: ToolRuntime): AgentTool<any> {
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

export function createPlatformListReportsTool(runtime: ToolRuntime): AgentTool<any> {
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

export function createPlatformCreateReportTool(runtime: ToolRuntime): AgentTool<any> {
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

export function createPlatformListExpertsTool(runtime: ToolRuntime): AgentTool<any> {
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

/** Placeholder titles for brand-new Cases (Spec #457). */
const DEFAULT_CONVERSATION_TITLES = new Set([
  "新会话",
  "New session",
  "new session",
  "Untitled",
  "未命名会话",
  "",
]);

export function createPlatformSetConversationTitleTool(runtime: ToolRuntime): AgentTool<any> {
  return {
    name: "platform_set_conversation_title",
    label: "Set session title",
    description:
      "Rename **this** Case/session title (sidebar + top bar). " +
      "When the title is still 新会话 and this turn has a structured target/scope, " +
      "call once with only_if_default=true. " +
      "User-asked rename: only_if_default=false. " +
      "Titles: concise (≤~24 Chinese chars or ~40 Latin), no quotes, no trailing period. " +
      "Never overwrite a user-chosen title. Do not announce the rename unless they asked.",
    parameters: Type.Object({
      title: Type.String({ description: "New session title" }),
      only_if_default: Type.Optional(
        Type.Boolean({
          description:
            "If true, update only when current title is still a default placeholder (新会话 etc.). Prefer true for auto-naming.",
        }),
      ),
    }),
    async execute(_id: string, params: any) {
      const cid = String(runtime.task.conversationId || "").trim();
      if (!cid) return textResult("error: no conversation_id on task", { isError: true });
      const title = String(params.title || "").trim();
      if (!title) return textResult("error: title required", { isError: true });
      const onlyIfDefault = params.only_if_default === true || params.only_if_default === "true";
      const res = await platformLedgerFetch(
        runtime,
        "PATCH",
        `/api/node/ledger/conversations/${encodeURIComponent(cid)}/title`,
        {
          title: title.slice(0, 255),
          only_if_default: onlyIfDefault,
        },
      );
      if (res.ok) {
        const data = (res.data && typeof res.data === "object" ? res.data : {}) as {
          title?: string;
          skipped?: boolean;
        };
        const nextTitle = String(data.title || title).trim();
        if (!data.skipped && nextTitle) {
          try {
            await runtime.platform.send({
              type: "conversation_title_updated",
              conversation_id: cid,
              task_id: runtime.task.taskId,
              title: nextTitle,
            } as any);
          } catch {
            /* non-fatal */
          }
        }
      }
      return jsonResult(res.data, { isError: !res.ok });
    },
  };
}

/** True when title is still a product default placeholder (for prompts / tests). */
export function isDefaultConversationTitle(title: string | undefined | null): boolean {
  return DEFAULT_CONVERSATION_TITLES.has(String(title ?? "").trim());
}

/** Register all platform.* tool factories used by the default seat. */
export const PLATFORM_TOOL_FACTORIES: Record<string, (runtime: ToolRuntime) => AgentTool<any>> = {
  platform_list_assets: createPlatformListAssetsTool,
  platform_get_asset: createPlatformGetAssetTool,
  platform_create_asset: createPlatformCreateAssetTool,
  platform_list_groups: createPlatformListGroupsTool,
  platform_create_group: createPlatformCreateGroupTool,
  platform_assemble_group: createPlatformAssembleGroupTool,
  platform_list_vulnerabilities: createPlatformListVulnerabilitiesTool,
  platform_get_vulnerability: createPlatformGetVulnerabilityTool,
  platform_update_finding_status: createPlatformUpdateFindingStatusTool,
  platform_enrich_asset: createPlatformEnrichAssetTool,
  platform_batch_enrich_assets: createPlatformBatchEnrichAssetsTool,
  platform_conversation_snapshot: createPlatformConversationSnapshotTool,
  platform_list_reports: createPlatformListReportsTool,
  platform_create_report: createPlatformCreateReportTool,
  platform_list_experts: createPlatformListExpertsTool,
  platform_set_conversation_title: createPlatformSetConversationTitleTool,
};
