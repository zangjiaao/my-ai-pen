/**
 * Spec #532 — park external-exposure candidates on Case Workset.
 * Not a Host, not a Surface ledger row, not a Finding.
 */
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolRuntime } from "../types.js";
import { jsonResult, textResult } from "./common.js";
import type { WorksetCandidate, WorksetFamily } from "../runtime/workset-emit.js";

const INTEL_SOURCES = new Set(["ct", "dns", "shodan", "fofa", "ssl_history", "other"]);
const CONFIDENCES = new Set(["low", "medium", "high"]);
const SCOPE_DECISIONS = new Set(["pending", "in_scope", "out_of_scope", "needs_authorization"]);

function clip(text: string, n: number): string {
  const t = String(text || "").trim();
  return t.length <= n ? t : `${t.slice(0, Math.max(0, n - 1))}…`;
}

function stashProposal(runtime: ToolRuntime, row: WorksetCandidate): void {
  const prev = runtime.lifecycle.worksetProposed;
  runtime.lifecycle.worksetProposed = Array.isArray(prev) ? [...prev, row] : [row];
}

export function buildPassiveWorksetCandidate(params: {
  host?: string;
  location?: string;
  port?: string;
  family?: string;
  intel_source?: string;
  attribution?: string;
  confidence?: string;
  scope_decision?: string;
  title?: string;
  summary?: string;
}): WorksetCandidate | { error: string } {
  const host = String(params.host || "").trim().toLowerCase();
  const location = String(params.location || "").trim();
  if (!host && !location) {
    return { error: "host or location required" };
  }
  const intel = String(params.intel_source || "other").trim().toLowerCase();
  const intel_source = INTEL_SOURCES.has(intel) ? intel : "other";
  const attribution = clip(String(params.attribution || ""), 800);
  if (!attribution) {
    return { error: "attribution required (tool/output that named this candidate)" };
  }
  const conf = String(params.confidence || "medium").trim().toLowerCase();
  const confidence = CONFIDENCES.has(conf) ? conf : "medium";
  const decision = String(params.scope_decision || "pending").trim().toLowerCase();
  const scope_decision = SCOPE_DECISIONS.has(decision) ? decision : "pending";
  let family = String(params.family || "").trim() as WorksetFamily | "";
  if (family !== "t_surface" && family !== "t_host") {
    family = location && host ? "t_host" : location ? "t_surface" : "t_host";
    // Exposure candidates default to t_host (new name) unless caller names a surface path.
    if (!location || !location.includes("/")) family = "t_host";
  }
  if (family === "t_host" && !host) {
    return { error: "t_host requires host" };
  }
  const port = String(params.port || "").trim() || undefined;
  const title =
    clip(String(params.title || ""), 200) ||
    (family === "t_host" ? (port ? `${host}:${port}` : host) : location.slice(0, 200));
  const summary =
    clip(String(params.summary || ""), 400) ||
    `Passive ${intel_source}: ${attribution}`.slice(0, 240);
  return {
    family,
    title,
    summary,
    host: host || undefined,
    port,
    location: location || undefined,
    urls: location ? [location] : undefined,
    in_scope: false,
    source: "workset_propose",
    intel_source,
    attribution,
    confidence,
    scope_decision,
    passive: true,
  };
}

export function createWorksetTool(runtime: ToolRuntime): AgentTool<any> {
  return {
    name: "workset",
    label: "Workset",
    description: [
      "Park external-exposure candidates on Case Workset. Not a Host, not a Surface, not a Finding.",
      "Ops: propose | list.",
      "propose: host (or location URL), intel_source (ct|dns|shodan|fofa|ssl_history|other), attribution evidence, confidence (low|medium|high), scope_decision (pending|in_scope|out_of_scope|needs_authorization).",
      "Do not http-probe or create_asset until the user adopts the Workset row.",
      "A missing optional intel source is not a failure — propose what the tools you have actually returned.",
    ].join(" "),
    parameters: Type.Object({
      op: Type.String(),
      host: Type.Optional(Type.String()),
      location: Type.Optional(Type.String()),
      port: Type.Optional(Type.String()),
      family: Type.Optional(Type.String()),
      intel_source: Type.Optional(Type.String()),
      attribution: Type.Optional(Type.String()),
      confidence: Type.Optional(Type.String()),
      scope_decision: Type.Optional(Type.String()),
      title: Type.Optional(Type.String()),
      summary: Type.Optional(Type.String()),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const op = String(params.op || "list").trim().toLowerCase();
      if (op === "list") {
        const items = runtime.lifecycle.worksetProposed || [];
        return jsonResult({
          ok: true,
          op: "list",
          count: items.length,
          items,
          guidance:
            "This-run proposals only. Case Workset on the platform is SoT after propose lands. Adopt is a user action.",
        });
      }
      if (op !== "propose") {
        return textResult("error: op must be propose or list");
      }
      const built = buildPassiveWorksetCandidate({
        host: String(params.host || ""),
        location: String(params.location || ""),
        port: String(params.port || ""),
        family: String(params.family || ""),
        intel_source: String(params.intel_source || ""),
        attribution: String(params.attribution || ""),
        confidence: String(params.confidence || ""),
        scope_decision: String(params.scope_decision || ""),
        title: String(params.title || ""),
        summary: String(params.summary || ""),
      });
      if ("error" in built) {
        return jsonResult({ ok: false, error: built.error });
      }
      stashProposal(runtime, built);
      const task = runtime.task;
      if (task?.conversationId && task.taskId) {
        await runtime.platform
          .send({
            type: "workset_propose",
            conversation_id: task.conversationId,
            task_id: task.taskId,
            expert_id: task.expertId,
            expert_name: task.expertName,
            workset_candidates: [built],
            workset_source: "workset_propose",
          })
          .catch(() => {});
      }
      return jsonResult({
        ok: true,
        op: "propose",
        item: built,
        guidance:
          "Parked on Workset. Do not create_asset or active-test this host until the user adopts it.",
      });
    },
  };
}
