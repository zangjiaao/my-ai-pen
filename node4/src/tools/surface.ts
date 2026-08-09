/**
 * Surface tool — Case attack-surface ledger deposit / list / get (Spec #368 / #370).
 *
 * Working store: Node SQLite (taskDir/surfaces/ledger.sqlite). Offline ok without Platform.
 * Online (#374): local commit required for ok; async Platform surface_upsert (platform_sync pending→ok|error).
 */

import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolRuntime } from "../types.js";
import { jsonResult, textResult } from "./common.js";
import {
  SURFACE_LIST_DEFAULT_LIMIT,
  SURFACE_UPSERT_BATCH_MAX,
  SURFACE_WRITE_HARD_CAP,
  type SurfaceUpsertItem,
} from "../stores/surface-sqlite.js";
import {
  enqueueSurfacePlatformSync,
  isSurfacePlatformOnline,
} from "../runtime/surface-platform-sync.js";

function resolveSourceAgentId(runtime: ToolRuntime): string {
  const wa = runtime.lifecycle.workerAudit?.agentId;
  if (wa != null && String(wa).trim()) return String(wa).trim();
  if ((runtime.lifecycle.subagentDepth || 0) >= 1) return "worker";
  return "main";
}

function asItemList(params: Record<string, unknown>): SurfaceUpsertItem[] {
  if (Array.isArray(params.surfaces)) {
    return params.surfaces.map((s) => {
      const rec = s && typeof s === "object" ? (s as Record<string, unknown>) : {};
      return {
        location: String(rec.location ?? ""),
        methods: Array.isArray(rec.methods) ? (rec.methods as string[]) : undefined,
        params: Array.isArray(rec.params) ? (rec.params as string[]) : undefined,
        status: rec.status != null ? String(rec.status) : undefined,
        kind: rec.kind != null ? String(rec.kind) : undefined,
        auth: rec.auth != null ? String(rec.auth) : undefined,
        note: rec.note != null ? String(rec.note) : undefined,
        source: rec.source != null ? String(rec.source) : undefined,
      };
    });
  }
  const location = params.location != null ? String(params.location) : "";
  if (!location.trim()) return [];
  return [
    {
      location,
      methods: Array.isArray(params.methods) ? (params.methods as string[]) : undefined,
      params: Array.isArray(params.params) ? (params.params as string[]) : undefined,
      status: params.status != null ? String(params.status) : undefined,
      kind: params.kind != null ? String(params.kind) : undefined,
      auth: params.auth != null ? String(params.auth) : undefined,
      note: params.note != null ? String(params.note) : undefined,
      source: params.source != null ? String(params.source) : undefined,
    },
  ];
}

export function createSurfaceTool(runtime: ToolRuntime): AgentTool<any> {
  return {
    name: "surface",
    label: "Attack surface ledger",
    description: [
      "Deposit and query the Case attack-surface working ledger (Node SQLite).",
      "Ops: upsert | list | get.",
      "upsert: merge by origin_key+path_key (scheme://host:port + path; query/body not in key). methods/params union-merge. Status never downgrades; cannot set booked (finding booking only).",
      `list: default open+in_probe actionable queue; limit default ${SURFACE_LIST_DEFAULT_LIMIT}; returns returned/total_matching/has_more.`,
      "get: by id, location, or origin_key+path_key.",
      "Main and Worker write the same Case ledger. Offline ok — no Platform required.",
      "Online: local SQLite ok is enough; Platform Case ledger syncs async (platform_sync pending|ok|error).",
      "Prefer this tool over fact(op=surface). Do not dump every Traffic URL — deposit after analysis.",
      `Write hard-cap ${SURFACE_WRITE_HARD_CAP} rows; prefer ≤${SURFACE_UPSERT_BATCH_MAX} per upsert call.`,
    ].join(" "),
    parameters: Type.Object({
      op: Type.String({ description: "upsert | list | get" }),
      /** Single location (upsert/get) */
      location: Type.Optional(Type.String()),
      /** Batch upsert items */
      surfaces: Type.Optional(
        Type.Array(
          Type.Object({
            location: Type.String(),
            methods: Type.Optional(Type.Array(Type.String())),
            params: Type.Optional(Type.Array(Type.String())),
            status: Type.Optional(Type.String()),
            kind: Type.Optional(Type.String()),
            auth: Type.Optional(Type.String()),
            note: Type.Optional(Type.String()),
            source: Type.Optional(Type.String()),
          }),
        ),
      ),
      methods: Type.Optional(Type.Array(Type.String())),
      params: Type.Optional(Type.Array(Type.String())),
      status: Type.Optional(
        Type.String({
          description:
            "upsert: open|in_probe|probed|deadend|skipped_roe (not booked). list: filter or comma-list or 'all'",
        }),
      ),
      kind: Type.Optional(Type.String()),
      auth: Type.Optional(Type.String()),
      note: Type.Optional(Type.String()),
      source: Type.Optional(Type.String()),
      id: Type.Optional(Type.String({ description: "get by stable row id" })),
      origin_key: Type.Optional(Type.String({ description: "list filter or get identity" })),
      path_key: Type.Optional(Type.String({ description: "get identity with origin_key" })),
      limit: Type.Optional(Type.Number({ description: `list page size (default ${SURFACE_LIST_DEFAULT_LIMIT}, max ${SURFACE_LIST_DEFAULT_LIMIT})` })),
      offset: Type.Optional(Type.Number({ description: "list pagination offset (default 0)" })),
    }),
    async execute(_id: string, params: any) {
      const store = runtime.surfaceSqlite;
      if (!store) {
        return textResult("error: surface SQLite working store not available on this runtime", {
          isError: true,
        });
      }
      // Ensure open (idempotent)
      try {
        await store.open();
      } catch (e) {
        return textResult(
          `error: surface store open failed: ${e instanceof Error ? e.message : String(e)}`,
          { isError: true },
        );
      }

      const op = String(params?.op || "list").trim().toLowerCase();

      if (op === "list") {
        const result = await store.list({
          status: params?.status,
          origin_key: params?.origin_key,
          limit: params?.limit,
          offset: params?.offset,
        });
        return jsonResult({
          ok: true,
          op: "list",
          surfaces: result.surfaces,
          returned: result.returned,
          total_matching: result.total_matching,
          has_more: result.has_more,
          limit: result.limit,
          offset: result.offset,
          guidance:
            result.has_more
              ? "More rows match — page with offset+=limit. Default filter is open+in_probe; status=all for full ledger."
              : "Actionable queue page. Prefer surface(upsert) as recon deepens; finding(confirm) marks booked via booking path.",
        });
      }

      if (op === "get") {
        const row = await store.get({
          id: params?.id,
          location: params?.location,
          origin_key: params?.origin_key,
          path_key: params?.path_key,
        });
        if (!row) {
          return textResult(
            "error: surface not found — pass id, location (scheme://…), or origin_key+path_key",
            { isError: true },
          );
        }
        return jsonResult({ ok: true, op: "get", surface: row });
      }

      if (op === "upsert") {
        const items = asItemList(params || {});
        if (!items.length) {
          return textResult(
            "error: surface(upsert) requires location or surfaces[{location,…}]",
            { isError: true },
          );
        }
        if (items.length > SURFACE_UPSERT_BATCH_MAX) {
          return textResult(
            `error: surface(upsert) batch max is ${SURFACE_UPSERT_BATCH_MAX} per call (got ${items.length})`,
            { isError: true },
          );
        }
        const source_agent_id = resolveSourceAgentId(runtime);
        const platformOnline = isSurfacePlatformOnline(runtime);
        const result = await store.upsert(items, {
          source_agent_id,
          source: "agent",
          platformOnline,
        });
        if (!result.ok) {
          return textResult(`error: ${result.error}`, {
            isError: true,
            hard_cap: result.hard_cap,
            total: result.total,
          });
        }

        // Graph gates read SQLite (#371). One-shot JSON→SQLite migrate remains in store.open().
        // Spec #374: async Platform dual-write — never block tool ok on Platform latency.
        if (platformOnline && result.upserted.length) {
          void enqueueSurfacePlatformSync(runtime, result.upserted);
        }

        return jsonResult({
          ok: true,
          op: "upsert",
          created: result.created,
          updated: result.updated,
          total: result.total,
          surfaces: result.upserted,
          platform_sync: result.platform_sync,
          source_agent_id,
          hard_cap: SURFACE_WRITE_HARD_CAP,
          guidance: platformOnline
            ? "Local SQLite commit ok; Platform surface_ledger sync is async (platform_sync pending→ok|error). List open queue with surface(op=list)."
            : "Local SQLite commit ok (offline/standalone does not need Platform). List open queue with surface(op=list).",
        });
      }

      return textResult("error: op must be upsert|list|get", { isError: true });
    },
  };
}

/**
 * Thin helper for fact(op=surface) and other callers that deposit one location
 * into the SQLite working store (Graph gates read the same store — #371).
 */
export async function depositSurfaceLocation(
  runtime: ToolRuntime,
  input: {
    location: string;
    kind?: string;
    auth?: string;
    note?: string;
    methods?: string[];
    params?: string[];
    status?: string;
    source_agent_id?: string;
  },
): Promise<
  | { ok: true; created: number; updated: number; total: number; platform_sync: string }
  | { ok: false; error: string }
> {
  const source_agent_id = input.source_agent_id || resolveSourceAgentId(runtime);
  const items: SurfaceUpsertItem[] = [
    {
      location: input.location,
      kind: input.kind,
      auth: input.auth,
      note: input.note,
      methods: input.methods,
      params: input.params,
      status: input.status,
    },
  ];
  const store = runtime.surfaceSqlite;
  if (!store) {
    // Partial runtimes / tests without SQLite: fall back to legacy JSON ledger only.
    const ledger = runtime.surfaceLedger;
    if (!ledger) return { ok: false, error: "surface working store not available" };
    const { added, total } = await ledger.upsertFromRecon(
      [
        {
          location: input.location,
          kind: input.kind,
          auth: input.auth,
          note: input.note,
          params: input.params,
        },
      ],
      { source_subagent_id: source_agent_id },
    );
    return { ok: true, created: added, updated: 0, total, platform_sync: "offline" };
  }
  await store.open();
  const platformOnline = isSurfacePlatformOnline(runtime);
  const result = await store.upsert(items, {
    source_agent_id,
    source: "agent",
    platformOnline,
  });
  if (!result.ok) return { ok: false, error: result.error };
  if (platformOnline && result.upserted.length) {
    void enqueueSurfacePlatformSync(runtime, result.upserted);
  }
  return {
    ok: true,
    created: result.created,
    updated: result.updated,
    total: result.total,
    platform_sync: result.platform_sync,
  };
}
