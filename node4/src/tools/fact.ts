/**
 * Process-fact tool — cognition vs finding booking (A2/A3/A5).
 * Never creates host assets.
 */
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ToolRuntime } from "../types.js";
import { jsonResult, textResult } from "./common.js";

export function createFactTool(runtime: ToolRuntime): ToolDefinition<any> {
  return {
    name: "fact",
    label: "Process fact",
    description: [
      "Persist process cognition (ports, auth state, failed probes, surface notes) under the task workspace.",
      "Ops: list | get | upsert.",
      "list returns short index (key+summary). get returns full body. upsert writes/overwrites one fact_key.",
      "Separate from finding(confirm): facts are working memory; product vulns need finding + grounded proof.",
      "Does NOT create platform host IP/domain assets (user-created only).",
      "Write-as-you-go: upsert when you confirm a cognition — do not wait for session end.",
      "Do not invent detail from list summaries alone — get the body.",
    ].join(" "),
    parameters: Type.Object({
      op: Type.String(),
      fact_key: Type.Optional(Type.String()),
      summary: Type.Optional(Type.String()),
      body: Type.Optional(Type.String()),
      category: Type.Optional(Type.String()),
    }),
    async execute(_id: string, params: any) {
      const store = runtime.processFacts;
      if (!store) return textResult("error: process fact store not available");
      const op = String(params.op || "list").trim().toLowerCase();

      if (op === "list") {
        const entries = await store.list();
        return jsonResult({
          ok: true,
          op: "list",
          count: entries.length,
          facts: entries,
          guidance:
            "Index only. fact(op=get, fact_key=...) for body. Book vulns with finding(confirm), not fact.",
        });
      }

      if (op === "get") {
        const key = String(params.fact_key || "").trim();
        if (!key) return textResult("error: fact_key required for get");
        const result = await store.get(key);
        if ("error" in result) return textResult(`error: ${result.error}`);
        return jsonResult({ ok: true, op: "get", fact: result });
      }

      if (op === "upsert") {
        const result = await store.upsert({
          fact_key: String(params.fact_key || ""),
          summary: String(params.summary || ""),
          body: String(params.body || ""),
          category: params.category != null ? String(params.category) : undefined,
        });
        if ("error" in result) return textResult(`error: ${result.error}`);
        return jsonResult({
          ok: true,
          op: "upsert",
          fact_key: result.fact_key,
          summary: result.summary,
          updated_at: result.updated_at,
          guidance:
            "Fact stored under task facts/. Still book product issues with finding(confirm)+proof when ready.",
        });
      }

      return textResult("error: op must be list|get|upsert");
    },
  };
}
