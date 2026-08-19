/**
 * Spec #493 — Worker-only result submission (pi-coding-agent yield, v1 terminal only).
 */
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolRuntime } from "../types.js";
import { jsonResult, textResult } from "./common.js";
import type { WorkerYieldRecord } from "../runtime/worker-yield.js";

function parseYield(params: Record<string, unknown> | null | undefined): WorkerYieldRecord {
  const raw = params && typeof params === "object" ? params : {};
  const result = raw.result && typeof raw.result === "object" ? (raw.result as Record<string, unknown>) : raw;
  const err = String(result.error ?? raw.error ?? "").trim();
  if (err) {
    return { status: "error", error: err.slice(0, 4000) };
  }
  const hasData = Object.prototype.hasOwnProperty.call(result, "data");
  if (!hasData || result.data === undefined || result.data === null) {
    return { status: "success", useLastTurn: true };
  }
  return { status: "success", data: result.data };
}

export function createYieldTool(runtime: ToolRuntime): AgentTool<any> {
  return {
    name: "yield",
    label: "Submit Result",
    description: [
      "Submit this package's result to the parent. Omit data to use your last assistant message as the report.",
      "Success: yield({ result: { data: <markdown or object> } }) or yield({ result: {} }) after you already wrote the report in chat.",
      "Failure: yield({ result: { error: \"what blocked you\" } }).",
      "Do not write settlement.json / result.json as the return channel. Parent books findings — you never finding(confirm).",
    ].join(" "),
    parameters: Type.Object({
      result: Type.Optional(
        Type.Object({
          data: Type.Optional(Type.Unknown()),
          error: Type.Optional(Type.String()),
        }),
      ),
      data: Type.Optional(Type.Unknown()),
      error: Type.Optional(Type.String()),
    }),
    async execute(_id: string, params: any) {
      const depth = Number(runtime.lifecycle?.subagentDepth ?? 0);
      if (depth < 1) {
        return textResult("error: yield is only available on Worker sessions", { isError: true });
      }
      const record = parseYield(params);
      runtime.lifecycle.workerYield = record;
      return jsonResult({
        ok: record.status === "success",
        yielded: true,
        use_last_turn: Boolean(record.useLastTurn),
        guidance:
          record.status === "error"
            ? "Host will mark this package failed and pass the error to Main."
            : record.useLastTurn
              ? "Host will use your last assistant message as the report to Main."
              : "Host will pass this yield payload to Main. Stop unless more work remains.",
      });
    },
  };
}
