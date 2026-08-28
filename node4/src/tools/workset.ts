/**
 * Spec #532 — park external-exposure candidates on Case Workset.
 * Not a Host, not a Surface ledger row, not a Finding.
 */
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolRuntime } from "../types.js";
import { jsonResult, textResult } from "./common.js";
import { platformLedgerFetch } from "./platform.js";
import type { WorksetCandidate, WorksetFamily } from "../runtime/workset-emit.js";

const INTEL_SOURCES = new Set(["ct", "dns", "shodan", "fofa", "ssl_history", "other"]);
const CONFIDENCES = new Set(["low", "medium", "high"]);
const SCOPE_DECISIONS = new Set(["pending", "in_scope", "out_of_scope", "needs_authorization"]);

export const AGENT_WORKSET_LIST_CAP = 24;

export type WorksetListRow = {
  id?: string;
  family?: string;
  status?: string;
  title?: string;
  summary?: string;
  host?: string;
  location?: string;
  intel_source?: string;
  attribution?: string;
  confidence?: string;
  scope_decision?: string;
  passive?: boolean;
  source?: string;
};

function worksetDedupeKey(row: WorksetListRow | WorksetCandidate): string {
  const fam = String(row.family || "t_host");
  const host = String(row.host || "").trim().toLowerCase();
  const loc = String(row.location || "").trim().toLowerCase();
  if (fam === "t_host") return `t_host:${host}`;
  return `t_surface:${loc || host}`;
}

export function mergeStashIntoCaseList(
  caseItems: WorksetListRow[],
  stash: WorksetCandidate[] | undefined,
): WorksetListRow[] {
  const out: WorksetListRow[] = [];
  const seen = new Set<string>();
  for (const row of caseItems) {
    if (!row || typeof row !== "object") continue;
    const key = worksetDedupeKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  for (const row of stash || []) {
    const mapped: WorksetListRow = {
      family: row.family,
      title: row.title,
      summary: row.summary,
      host: row.host,
      location: row.location,
      intel_source: row.intel_source,
      attribution: row.attribution,
      confidence: row.confidence,
      scope_decision: row.scope_decision,
      passive: row.passive,
      source: row.source,
      status: "proposed",
    };
    const key = worksetDedupeKey(mapped);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(mapped);
  }
  return out;
}

export function filterWorksetForAgent(
  items: WorksetListRow[],
  opts: { family?: string; status?: string; needle?: string; itemId?: string; cap?: number } = {},
): { items: WorksetListRow[]; total: number; omitted: number; cap: number } {
  const cap = Math.max(1, Math.min(Number(opts.cap) || AGENT_WORKSET_LIST_CAP, 40));
  const wantId = String(opts.itemId || "").trim();
  const fam = String(opts.family || "").trim().toLowerCase();
  const st = String(opts.status || "").trim().toLowerCase();
  const q = String(opts.needle || "").trim().toLowerCase();
  const matched: WorksetListRow[] = [];
  for (const item of items) {
    if (wantId) {
      if (String(item.id || "") !== wantId) continue;
    } else {
      const cur = String(item.status || "proposed").toLowerCase();
      if (st) {
        if (cur !== st) continue;
      } else if (cur !== "proposed" && cur !== "adopted") {
        continue;
      }
      if (fam && String(item.family || "").toLowerCase() !== fam) continue;
      if (q) {
        const blob = [item.id, item.title, item.summary, item.host, item.location, item.attribution]
          .map((x) => String(x || ""))
          .join(" ")
          .toLowerCase();
        if (!blob.includes(q)) continue;
      }
    }
    matched.push(item);
    if (wantId) break;
  }
  return {
    items: matched.slice(0, cap),
    total: matched.length,
    omitted: Math.max(0, matched.length - cap),
    cap,
  };
}

async function fetchCaseWorkset(
  runtime: ToolRuntime,
  params: { family?: string; status?: string; needle?: string; itemId?: string; cap?: number },
): Promise<WorksetListRow[] | null> {
  const cid = String(runtime.task?.conversationId || "").trim();
  if (!cid || !runtime.platformApi?.baseUrl || !runtime.platformApi.nodeToken) return null;
  const qs = new URLSearchParams();
  if (params.family) qs.set("family", params.family);
  if (params.status) qs.set("status", params.status);
  if (params.needle) qs.set("q", params.needle);
  if (params.itemId) qs.set("id", params.itemId);
  if (params.cap) qs.set("limit", String(params.cap));
  const qstr = qs.toString();
  const path = `/api/node/ledger/conversations/${encodeURIComponent(cid)}/workset${qstr ? `?${qstr}` : ""}`;
  const res = await platformLedgerFetch(runtime, "GET", path);
  if (!res.ok || !res.data || typeof res.data !== "object") return null;
  const items = (res.data as { items?: unknown }).items;
  if (!Array.isArray(items)) return null;
  return items.filter((i) => i && typeof i === "object") as WorksetListRow[];
}

function fallbackFromCaseContext(runtime: ToolRuntime): WorksetListRow[] {
  const open = runtime.task?.caseContext?.next_work?.workset_open;
  if (!Array.isArray(open)) return [];
  return open.map((i) => ({
    id: i.id,
    family: i.family,
    title: i.title,
    status: i.status,
  }));
}

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
      "Park pending-admission candidates on Case Workset. Not a Host, not Surface coverage, not Intel.",
      "Ops: propose | list | get.",
      "list/get read Case Workset SoT (filtered, capped) — not this-burst stash only.",
      "propose: host (or location URL), intel_source (ct|dns|shodan|fofa|ssl_history|other), attribution evidence, confidence (low|medium|high), scope_decision (pending|in_scope|out_of_scope|needs_authorization).",
      "Do not http-probe, surface(mark), or create_asset until the user adopts. No Host means no Intel hang.",
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
      status: Type.Optional(Type.String()),
      q: Type.Optional(Type.String()),
      id: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Number()),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const op = String(params.op || "list").trim().toLowerCase();
      if (op === "list" || op === "get") {
        const filters = {
          family: String(params.family || "").trim() || undefined,
          status: String(params.status || "").trim() || undefined,
          needle: String(params.q || "").trim() || undefined,
          itemId: op === "get" ? String(params.id || "").trim() : undefined,
          cap: Number(params.limit) || AGENT_WORKSET_LIST_CAP,
        };
        if (op === "get" && !filters.itemId) {
          return jsonResult({ ok: false, error: "get requires id" });
        }
        const fetched = await fetchCaseWorkset(runtime, filters);
        const caseItems = fetched ?? fallbackFromCaseContext(runtime);
        const merged = mergeStashIntoCaseList(caseItems, runtime.lifecycle.worksetProposed);
        const listed = filterWorksetForAgent(merged, filters);
        return jsonResult({
          ok: true,
          op,
          ...listed,
          note:
            "Case Workset pending admission. Not Host, not Surface coverage, not Intel. Adopt is a user action.",
        });
      }
      if (op !== "propose") {
        return textResult("error: op must be propose, list, or get");
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
