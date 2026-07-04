import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ToolRuntime } from "../types.js";
import { jsonResult, textResult } from "./common.js";

export function createTrafficTool(runtime: ToolRuntime): ToolDefinition<any> {
  return {
    name: "traffic",
    label: "Traffic",
    description: "Inspect captured/replayed traffic. Actions: list, get, endpoints, snapshot, add_snapshot. Use this before testing so authenticated requests and real parameters are not missed.",
    promptSnippet: "Inspect captured traffic and session snapshots",
    promptGuidelines: [
      "Use traffic(endpoints) to build the attack-surface list before choosing scan or http probes.",
      "Use traffic(snapshot) to recover cookies/session state before authenticated http replay.",
    ],
    parameters: Type.Object({
      action: Type.String(),
      id: Type.Optional(Type.String()),
      url_contains: Type.Optional(Type.String()),
      method: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Number()),
      snapshot: Type.Optional(Type.Record(Type.String(), Type.Any())),
    }),
    async execute(_toolCallId: string, params: any) {
      if (params.action === "list") {
        return jsonResult(runtime.traffic.list({ urlContains: params.url_contains, method: params.method, limit: params.limit }));
      }
      if (params.action === "get") {
        if (!params.id) return textResult("error: id is required");
        return jsonResult(runtime.traffic.get(params.id) || { error: `not found: ${params.id}` });
      }
      if (params.action === "endpoints") return jsonResult(runtime.traffic.endpoints());
      if (params.action === "snapshot") return jsonResult(runtime.traffic.snapshot() || {});
      if (params.action === "add_snapshot") {
        if (!params.snapshot) return textResult("error: snapshot is required");
        runtime.traffic.setSnapshot(params.snapshot);
        return textResult("snapshot stored");
      }
      return textResult("error: action must be list, get, endpoints, snapshot, or add_snapshot");
    },
  };
}
