/**
 * Owner-ledger clerk — one multi-op tool for Host/Group list/get/create/enrich/assemble.
 * Default seat only. Act-expert catalogs must not include this tool (#547).
 * Delegates to existing platform HTTP helpers; does not rewrite the ledger API.
 */
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolRuntime } from "../types.js";
import { jsonResult, textResult } from "./common.js";
import {
  createPlatformAssembleGroupTool,
  createPlatformBatchEnrichAssetsTool,
  createPlatformCreateAssetTool,
  createPlatformCreateGroupTool,
  createPlatformEnrichAssetTool,
  createPlatformGetAssetTool,
  createPlatformListAssetsTool,
  createPlatformListGroupsTool,
  isHostCreateAttempt,
} from "./platform.js";

const OPS = new Set(["list", "get", "create", "enrich", "assemble"]);

function resolveKind(op: string, raw: string): "host" | "group" {
  const k = String(raw || "").trim().toLowerCase();
  if (k === "group" || k === "groups") return "group";
  if (k === "host" || k === "hosts" || k === "asset" || k === "assets") return "host";
  return op === "assemble" ? "group" : "host";
}

export function createInventoryTool(runtime: ToolRuntime): AgentTool<any> {
  const listAssets = createPlatformListAssetsTool(runtime);
  const getAsset = createPlatformGetAssetTool(runtime);
  const createAsset = createPlatformCreateAssetTool(runtime);
  const enrichAsset = createPlatformEnrichAssetTool(runtime);
  const batchEnrich = createPlatformBatchEnrichAssetsTool(runtime);
  const listGroups = createPlatformListGroupsTool(runtime);
  const createGroup = createPlatformCreateGroupTool(runtime);
  const assembleGroup = createPlatformAssembleGroupTool(runtime);

  return {
    name: "inventory",
    label: "Owner ledger inventory",
    description: [
      "Owner Ledger clerk for Hosts and Groups (same books as 资产管理).",
      "Ops: list | get | create | enrich | assemble. kind=host | group.",
      "list/get: read Hosts or Groups. Optional q= filters address/name/tags/notes.",
      "When q is an IP/domain, identity=unique|ambiguous|none (primary∪aliases, not note).",
      "identity=ambiguous → request_user_decision with those Host ids; never pick the first row.",
      "create: only when the user asked — reason required. kind=host needs address/addresses; kind=group needs name.",
      "enrich: existing Hosts only (asset_id, or batch/asset_ids/group_name). Never smuggle create.",
      "assemble: Group membership only (装入组). Does not add Host ports — use enrich.",
      "Do not invent Hosts from recon. Identity is asset id (same IP may be multiple Hosts).",
    ].join(" "),
    parameters: Type.Object({
      op: Type.String(),
      kind: Type.Optional(Type.String()),
      q: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Number()),
      offset: Type.Optional(Type.Number()),
      id: Type.Optional(Type.String()),
      asset_id: Type.Optional(Type.String()),
      asset_ids: Type.Optional(Type.Array(Type.String())),
      group_id: Type.Optional(Type.String()),
      group_name: Type.Optional(Type.String()),
      name: Type.Optional(Type.String()),
      reason: Type.Optional(Type.String()),
      address: Type.Optional(Type.String()),
      addresses: Type.Optional(Type.Array(Type.String())),
      ports: Type.Optional(Type.Array(Type.Any())),
      services: Type.Optional(Type.Array(Type.Any())),
      remove_ports: Type.Optional(Type.Array(Type.Any())),
      urls: Type.Optional(Type.Array(Type.String())),
      api_endpoints: Type.Optional(Type.Array(Type.Any())),
      tags: Type.Optional(Type.Array(Type.String())),
      assembly_ports: Type.Optional(Type.Array(Type.Any())),
      exclude_last_octets: Type.Optional(Type.Array(Type.Number())),
      batch: Type.Optional(Type.Boolean()),
    }),
    async execute(_id: string, params: any) {
      const op = String(params.op || "").trim().toLowerCase();
      if (!OPS.has(op)) {
        return textResult("error: op must be list | get | create | enrich | assemble", { isError: true });
      }
      const kind = resolveKind(op, params.kind);
      if (op === "assemble" && kind !== "group") {
        return textResult("error: assemble is Group membership only (kind=group)", { isError: true });
      }

      if (op === "list") {
        return kind === "group" ? listGroups.execute!(_id, params) : listAssets.execute!(_id, params);
      }

      if (op === "get") {
        if (kind === "group") {
          const q = String(
            params.q || params.name || params.group_name || params.group_id || params.id || "",
          ).trim();
          return listGroups.execute!(_id, { ...params, q });
        }
        const asset_id = String(params.asset_id || params.id || "").trim();
        return getAsset.execute!(_id, { ...params, asset_id });
      }

      if (op === "create") {
        if (kind === "group") {
          return createGroup.execute!(_id, { ...params, name: params.name || params.group_name });
        }
        return createAsset.execute!(_id, params);
      }

      if (op === "enrich") {
        const assetIds = Array.isArray(params.asset_ids)
          ? params.asset_ids.map(String).map((s: string) => s.trim()).filter(Boolean)
          : [];
        const singleId = String(params.asset_id || params.id || "").trim();
        const body = {
          asset_id: singleId,
          address: params.address,
          host: params.host,
          create: params.create,
          create_host: params.create_host,
        };
        if (isHostCreateAttempt("enrich_asset", body)) {
          return jsonResult(
            {
              ok: false,
              error:
                "host create denied on enrich: provide existing asset_id, or use inventory(create) when the user asked to add Hosts",
            },
            { isError: true },
          );
        }
        const batch =
          params.batch === true ||
          assetIds.length > 1 ||
          kind === "group" ||
          Boolean(String(params.group_name || params.group_id || "").trim() && !singleId);
        if (batch) {
          return batchEnrich.execute!(_id, {
            ...params,
            asset_ids: assetIds.length ? assetIds : singleId ? [singleId] : params.asset_ids,
          });
        }
        return enrichAsset.execute!(_id, { ...params, asset_id: singleId });
      }

      return assembleGroup.execute!(_id, params);
    },
  };
}
