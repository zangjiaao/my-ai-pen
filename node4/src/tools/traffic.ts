/**
 * Spec #378 — Agent-facing traffic raw-material query.
 * Read-only over session Runtime capture store. Never writes surface ledger.
 */
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolRuntime } from "../types.js";
import { jsonResult } from "./common.js";
import { listRuntimeTraffic } from "../runtime/traffic-query.js";

export function createTrafficListTool(runtime: ToolRuntime): AgentTool<any> {
  return {
    name: "traffic_list",
    label: "List captured traffic",
    description:
      "Query HTTP traffic captured by Runtime hooks (http/browser/shell) as raw material " +
      "for recon analysis. Prefer latest/delta (limit + since_sequence) or paginate " +
      "(offset/limit). Default returns summaries (method, host, path, status, source, time) " +
      "without bodies; set include_bodies=true or exchange_id for detail. " +
      "Optional aggregate_paths for path-level overview. " +
      "Read-only — does NOT deposit attack-surface ledger rows (use surface(op=upsert) after analysis).",
    parameters: Type.Object({
      limit: Type.Optional(Type.Number({ description: "Max rows (default 20, max 200)" })),
      offset: Type.Optional(Type.Number({ description: "Pagination offset (default 0)" })),
      since_sequence: Type.Optional(
        Type.Number({ description: "Delta: only exchanges with sequence greater than this" }),
      ),
      include_bodies: Type.Optional(
        Type.Boolean({ description: "Include request/response bodies (default false)" }),
      ),
      aggregate_paths: Type.Optional(
        Type.Boolean({ description: "Include path aggregation over the filtered set" }),
      ),
      exchange_id: Type.Optional(
        Type.String({ description: "Fetch one exchange by id (summary unless include_bodies)" }),
      ),
    }),
    async execute(_id: string, params: any) {
      const result = listRuntimeTraffic(runtime, {
        limit: params?.limit,
        offset: params?.offset,
        since_sequence: params?.since_sequence,
        include_bodies: params?.include_bodies,
        aggregate_paths: params?.aggregate_paths,
        exchange_id: params?.exchange_id,
      });
      return jsonResult(result);
    },
  };
}
