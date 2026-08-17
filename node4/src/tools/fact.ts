/**
 * Process-fact + Host notebook (Intel) — one Agent tool.
 * Local taskDir/facts stays for Graph process keys. Durable clues hang on Host/Service.
 * Attack surface is the `surface` tool; harness may mirror deposits into facts/.
 */
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolRuntime } from "../types.js";
import { jsonResult, textResult } from "./common.js";
import {
  forgetIntelRow,
  getIntelRow,
  listIntelRows,
  recordIntelRow,
  resolveIntelHang,
} from "./platform-intel.js";

const INTEL_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function hasPlatformApi(runtime: ToolRuntime): boolean {
  return Boolean(runtime.platformApi?.baseUrl && runtime.platformApi?.nodeToken);
}

export function createFactTool(runtime: ToolRuntime): AgentTool<any> {
  return {
    name: "fact",
    label: "Process fact",
    description: [
      "Notebook + this-task process memory. Write-as-you-go when you confirm a cognition — do not wait.",
      "Ops: list | get | upsert | forget.",
      "upsert: this-task fact_key plus Host/Service 线索 when hang is known (asset_id, or the single Scope Host). kind=credential_status|secret|token|flag|path_hint|account|config.",
      "Auth, creds, dead-end lessons that the next Session must not forget → upsert (that is the 情报 tab / Findings 线索). Do not invent a Host to hang a clue.",
      "Correct a living clue with upsert on that id (one call). Inject shows this-Case writes and login kinds first, then frequently opened clues. forget(id, reason) is a hard drop (已忘记); reason required.",
      "Attack surface: use the surface tool. Separate from finding(confirm).",
    ].join(" "),
    parameters: Type.Object({
      op: Type.String(),
      fact_key: Type.Optional(Type.String()),
      summary: Type.Optional(Type.String()),
      body: Type.Optional(Type.String()),
      category: Type.Optional(Type.String()),
      kind: Type.Optional(Type.String()),
      asset_id: Type.Optional(Type.String({ description: "Host asset id to hang the notebook row" })),
      port: Type.Optional(Type.String({ description: "Service port; omit to hang on the Host" })),
      id: Type.Optional(Type.String({ description: "Intel id for get/update/forget" })),
      reason: Type.Optional(Type.String({ description: "Required when forget: why this clue is discarded" })),
    }),
    async execute(_id: string, params: any) {
      const store = runtime.processFacts;
      if (!store) return textResult("error: process fact store not available");
      const op = String(params.op || "list").trim().toLowerCase();

      if (op === "list") {
        const entries = await store.list();
        let intel: unknown[] = [];
        if (hasPlatformApi(runtime)) {
          const res = await listIntelRows(runtime, {
            asset_id: String(params.asset_id || "").trim() || undefined,
            port: String(params.port || "").trim() || undefined,
          });
          if (res.ok && res.data && typeof res.data === "object") {
            const rows = (res.data as { intel?: unknown[] }).intel;
            if (Array.isArray(rows)) intel = rows;
          }
        }
        return jsonResult({
          ok: true,
          op: "list",
          count: entries.length,
          facts: entries,
          intel,
          guidance:
            "intel = living Host/Service notebook (Findings 线索). facts = this-task process index. " +
            "get body via fact(op=get, id=…) or fact_key. Book vulns with finding(confirm), not fact.",
        });
      }

      if (op === "get") {
        const intelId = String(params.id || "").trim();
        const key = String(params.fact_key || intelId || "").trim();
        if (!key && !intelId) return textResult("error: id or fact_key required for get");
        if (hasPlatformApi(runtime) && INTEL_ID_RE.test(intelId || key)) {
          const res = await getIntelRow(runtime, intelId || key);
          return jsonResult(res.data, { isError: !res.ok });
        }
        const result = await store.get(key);
        if ("error" in result) return textResult(`error: ${result.error}`);
        return jsonResult({ ok: true, op: "get", fact: result });
      }

      if (op === "forget") {
        const intelId = String(params.id || params.fact_key || "").trim();
        const reason = String(params.reason || "").trim();
        if (!intelId) return textResult("error: id required for forget", { isError: true });
        if (reason.length < 2) {
          return textResult("error: reason required for forget", { isError: true });
        }
        if (!hasPlatformApi(runtime)) {
          return textResult("error: platform API not configured — cannot forget Host notebook", { isError: true });
        }
        const res = await forgetIntelRow(runtime, intelId, reason);
        return jsonResult(res.data, { isError: !res.ok });
      }

      if (op === "upsert") {
        const kindHint = String(params.kind || params.category || "config").trim() || "config";
        const result = await store.upsert({
          fact_key: String(params.fact_key || "").trim() || `notebook/${kindHint}`,
          summary: String(params.summary || ""),
          body: String(params.body || ""),
          category: params.category != null ? String(params.category) : undefined,
        });
        if ("error" in result) return textResult(`error: ${result.error}`);
        let intel: unknown = null;
        let intelError: string | undefined;
        const hang = resolveIntelHang(params, runtime.task.caseContext?.scope_intel?.hosts);
        if (hasPlatformApi(runtime) && hang) {
          const res = await recordIntelRow(runtime, {
            asset_id: hang.asset_id,
            port: hang.port,
            kind: params.kind || params.category,
            summary: result.summary,
            body: String(params.body || result.summary),
            id: String(params.id || "").trim() || undefined,
          });
          if (res.ok) {
            intel = res.data && typeof res.data === "object" ? (res.data as { intel?: unknown }).intel : res.data;
          } else {
            intelError =
              typeof res.data === "object" && res.data && "detail" in res.data
                ? String((res.data as { detail?: unknown }).detail)
                : `intel persist failed (${res.status})`;
          }
        }
        return jsonResult({
          ok: !intelError,
          op: "upsert",
          fact_key: result.fact_key,
          summary: result.summary,
          updated_at: result.updated_at,
          intel,
          intel_error: intelError,
          hung: Boolean(hang && intel && !intelError),
          guidance: intelError
            ? "This-task fact saved; Host notebook persist failed — retry upsert."
            : hang && hasPlatformApi(runtime)
              ? "This-task fact + Host notebook (情报/线索) saved. Still book product issues with finding(confirm)+proof."
              : "This-task fact saved. Pass asset_id of an existing Host to also write the 情报 notebook (do not invent a Host).",
        }, { isError: Boolean(intelError) });
      }

      if (op === "surface") {
        return textResult(
          "error: use the surface tool (summary|list|get|upsert). fact no longer deposits surfaces.",
          { isError: true },
        );
      }

      return textResult("error: op must be list|get|upsert|forget");
    },
  };
}
