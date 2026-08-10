/**
 * Surface tool — Case attack-surface ledger (Spec #368 / #370 / #383 D5).
 *
 * Primary Agent ops: summary | list | get (management view).
 * Normal fill is Runtime: Traffic settle + TARGET seed; booked via finding(confirm).
 * upsert remains registered as non-primary (corrective / debug / import / tests).
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
import { selectNewUntestedSurfaces } from "../runtime/surface-harness.js";

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

/** Sample path count for surface(op=summary) agent management view (#383). */
const SURFACE_SUMMARY_SAMPLE_MAX = 8;

export function createSurfaceTool(runtime: ToolRuntime): AgentTool<any> {
  return {
    name: "surface",
    label: "Attack surface ledger",
    description: [
      "Query the Case attack-surface working ledger (Node SQLite) — Agent management view.",
      "PRIMARY ops: summary | list | get.",
      "summary: counts + new_untested + tested(=case_tested from purpose=test traffic) + samples; primary duty NEW→TESTED (or deadend).",
      `list: default seen+touched actionable queue; limit default ${SURFACE_LIST_DEFAULT_LIMIT} (max same); returns returned/total_matching/has_more.`,
      "get: by id, location, or origin_key+path_key.",
      "Normal ledger fill is Runtime-passive: Traffic settle + TARGET seed; TESTED only via purpose=test Traffic (case_tested; ≥1 enough); booked only via finding(confirm).",
      "Platform vuln priors alone ≠ this-Case TESTED / ≠ coverage complete — re-verify context only.",
      "Optional upsert (non-primary): rare correctives — cannot set booked; cannot fake TESTED/case_tested without traffic.",
      "Main and Worker share the same Case ledger. Offline ok — no Platform required.",
      "Prefer this tool over fact(op=surface).",
      `Write hard-cap ${SURFACE_WRITE_HARD_CAP} rows; prefer ≤${SURFACE_UPSERT_BATCH_MAX} per optional upsert call.`,
    ].join(" "),
    parameters: Type.Object({
      op: Type.String({ description: "summary | list | get | upsert (upsert non-primary)" }),
      /** Single location (upsert/get) */
      location: Type.Optional(Type.String()),
      /** Batch upsert items (non-primary) */
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
            "upsert: seen|deadend|skipped_roe (not booked; touched/TESTED only via Traffic settle — agent cannot fake). list: filter or comma-list or 'all' (default seen+touched)",
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

      if (op === "summary") {
        // Spec #383 D5: Agent management view — counts + sample paths (tool-first, no every-turn inject).
        const cov = await store.summary();
        // Richer samples: path_key (or location) with status for actionable + a few booked.
        const actionable = await store.list({
          status: "seen,touched",
          limit: SURFACE_SUMMARY_SAMPLE_MAX,
          offset: 0,
        });
        const bookedSample = await store.list({
          status: "booked",
          limit: Math.min(4, SURFACE_SUMMARY_SAMPLE_MAX),
          offset: 0,
        });
        const sample_paths = [
          ...actionable.surfaces.map((s) => s.path_key || s.location),
          ...bookedSample.surfaces.map((s) => s.path_key || s.location),
        ].slice(0, SURFACE_SUMMARY_SAMPLE_MAX);
        const samples = [
          ...actionable.surfaces.map((s) => ({
            location: s.location,
            path_key: s.path_key,
            origin_key: s.origin_key,
            status: s.status,
            case_tested: s.case_tested === true,
          })),
          ...bookedSample.surfaces.map((s) => ({
            location: s.location,
            path_key: s.path_key,
            origin_key: s.origin_key,
            status: s.status,
            case_tested: s.case_tested === true,
          })),
        ].slice(0, SURFACE_SUMMARY_SAMPLE_MAX);
        // Spec #411/#413: NEW untested queue — prefer is_new when present; untested = !case_tested.
        const allRows = await store.all();
        const newQueue = selectNewUntestedSurfaces(allRows, SURFACE_SUMMARY_SAMPLE_MAX);
        const testedCount = allRows.filter((r) => r.case_tested === true).length;
        return jsonResult({
          ok: true,
          op: "summary",
          total: cov.total,
          seen: cov.open,
          touched: cov.in_probe,
          /** Operator vocabulary: TESTED = case_tested (≥1 purpose=test this Case). */
          tested: testedCount,
          case_tested: testedCount,
          /** Primary coverage queue: NEW untested (or !case_tested fallback until is_new dual-write). */
          new_untested: newQueue.count,
          booked: cov.booked,
          deadend: cov.deadend,
          skipped_roe: cov.skipped,
          /** seen + touched still needing act */
          actionable: cov.actionable,
          counts: {
            seen: cov.open,
            touched: cov.in_probe,
            tested: testedCount,
            case_tested: testedCount,
            new_untested: newQueue.count,
            booked: cov.booked,
            deadend: cov.deadend,
            skipped_roe: cov.skipped,
          },
          new_untested_samples: newQueue.samples,
          new_untested_mode: newQueue.mode,
          sample_paths,
          samples,
          guidance:
            cov.total === 0
              ? "Ledger empty. Fill is Runtime-passive: real Traffic settle + TARGET seed. Explore with http/session/browser so requests land; then re-check summary. upsert is optional corrective only — not required."
              : "Coverage snapshot. Primary duty: NEW untested → TESTED (purpose=test traffic sets case_tested; ≥1 enough) or deadend. Browse/seed alone ≠ TESTED. Platform vuln priors ≠ TESTED / ≠ coverage complete. upsert cannot fake case_tested. Open NEW untested never blocks booking — disclose on pause. Use surface(list) for pages.",
        });
      }

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
              ? "More rows match — page with offset+=limit. Default filter is seen+touched; status=all for full ledger."
              : "Actionable queue page (seen+touched by default). Ledger fills from Traffic settle + TARGET seed; finding(confirm) marks booked. surface(summary) for counts; upsert is optional corrective only.",
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
            ? "Local SQLite commit ok (optional corrective path). Prefer Traffic settle + seed for normal fill; surface(summary|list) for coverage. Platform surface_ledger sync is async."
            : "Local SQLite commit ok (optional corrective; offline). Prefer Traffic settle + seed for normal fill; surface(summary|list) for coverage.",
        });
      }

      return textResult("error: op must be summary|list|get|upsert", { isError: true });
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
