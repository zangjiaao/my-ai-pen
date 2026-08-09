/**
 * Process-fact tool — cognition vs finding booking (A2/A3/A5).
 * Never creates host assets.
 *
 * fact(op=surface) is a thin wrapper over the surface SQLite store (#370).
 * Prefer the dedicated `surface` tool for deposit/list/get.
 */
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolRuntime } from "../types.js";
import { jsonResult, textResult } from "./common.js";
import { depositSurfaceLocation } from "./surface.js";

export function createFactTool(runtime: ToolRuntime): AgentTool<any> {
  return {
    name: "fact",
    label: "Process fact",
    description: [
      "Persist process cognition (ports, auth state, failed probes, surface notes) under the task workspace.",
      "Ops: list | get | upsert | surface.",
      "list returns short index (key+summary). get returns full body. upsert writes/overwrites one fact_key.",
      "surface: thin wrapper — deposits one location into the surface SQLite ledger (prefer surface(op=upsert) for batches/list).",
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
      /** Surface ledger location (op=surface). */
      location: Type.Optional(Type.String()),
      kind: Type.Optional(Type.String()),
      auth: Type.Optional(Type.String()),
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

      // Spec #125 / #370: serial surface deposit — thin wrapper over surface SQLite store.
      if (op === "surface") {
        const location = String(params.location || params.body || "").trim();
        if (!location || location.length < 2) {
          return textResult("error: fact(op=surface) requires location (observed URL/path)");
        }
        const kind = String(params.kind || "").trim() || undefined;
        const auth = String(params.auth || "").trim() || undefined;
        const note = String(params.summary || params.body || "").trim() || undefined;
        const deposited = await depositSurfaceLocation(runtime, {
          location,
          kind,
          auth,
          note,
          source_agent_id:
            (runtime.lifecycle.subagentDepth || 0) >= 1
              ? runtime.lifecycle.workerAudit?.agentId || "worker"
              : "main_serial",
        });
        if (!deposited.ok) {
          return textResult(`error: ${deposited.error}`);
        }
        // Mirror as process fact for captain continuity.
        await store
          .upsert({
            fact_key: `surface:${location}`.slice(0, 120),
            summary: note || `surface ${location}`,
            body: JSON.stringify({ location, kind, auth }),
            category: "surface",
          })
          .catch(() => ({}));
        return jsonResult({
          ok: true,
          op: "surface",
          location,
          added: deposited.created,
          updated: deposited.updated,
          total: deposited.total,
          platform_sync: deposited.platform_sync,
          guidance:
            "Surface deposited to SQLite working ledger (prefer surface tool for list/get/batch). Do not write result.json for handoff.",
        });
      }

      return textResult("error: op must be list|get|upsert|surface");
    },
  };
}
