/**
 * Surface tool — Case attack-surface ledger (Spec #368 / #370 / #383 D5).
 *
 * Primary Agent ops: summary | list | get | mark | unmark | skip.
 * Normal fill is Runtime: Traffic settle + TARGET seed; booked via finding(confirm).
 * Coverage work-state is Agent-maintained (mark/skip). upsert cannot write coverage.
 *
 * Working store: Node SQLite (caseDir/surfaces/ledger.sqlite). Offline ok without Platform.
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
  SKIP_REASON_REQUIRED_ERROR,
  UPSERT_TERMINAL_STATUS_ERROR,
  coerceSurfaceSkipReason,
} from "../stores/surface-coverage.js";
import {
  enqueueSurfacePlatformSync,
  isSurfacePlatformOnline,
} from "../runtime/surface-platform-sync.js";
import { isAdmittedSurfaceHost } from "../runtime/surface-settle.js";
import { parseLocation } from "../stores/surface-identity.js";
import { selectNewUntestedSurfaces } from "../runtime/surface-harness.js";

function resolveSourceAgentId(runtime: ToolRuntime): string {
  const wa = runtime.lifecycle.workerAudit?.agentId;
  if (wa != null && String(wa).trim()) return String(wa).trim();
  if ((runtime.lifecycle.subagentDepth || 0) >= 1) return "worker";
  return "main";
}

function hostFromWriteParams(params: Record<string, unknown> | undefined, fallbackLocation?: string): string {
  const location = String(params?.location || fallbackLocation || "").trim();
  if (location) {
    const parsed = parseLocation(location);
    if (parsed.ok) return parsed.host;
  }
  const origin = String(params?.origin_key || "").trim();
  if (origin) {
    const parsed = parseLocation(origin);
    if (parsed.ok) return parsed.host;
  }
  return "";
}

function rejectForeignSurfaceWrite(runtime: ToolRuntime, host: string) {
  if (isAdmittedSurfaceHost(host, runtime.task)) return null;
  return textResult(
    "error: origin is not an admitted Case Host — surface write fail-closed",
    { isError: true },
  );
}

function resolveCoverageMarkedBy(runtime: ToolRuntime): string {
  const expert = String(runtime.task?.expertId || "").trim() || "main";
  const wa = runtime.lifecycle.workerAudit?.agentId;
  if (wa != null && String(wa).trim()) return `${expert}/${String(wa).trim()}`;
  if ((runtime.lifecycle.subagentDepth || 0) >= 1) return `${expert}/worker`;
  return expert;
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
      "Query and maintain the Case attack-surface working ledger (Node SQLite).",
      "PRIMARY ops: summary | list | get | mark | unmark | skip.",
      "Identities are born from Traffic settle + TARGET seed — do not invent paths.",
      "Coverage work-state (Case-shared): untested (default) | tested | skipped. Who tests, marks. Operators do not tick.",
      "mark: existing identity → tested. unmark → untested. skip: existing identity → skipped with reason=deadend|roe.",
      "Origin/root may be marked without HTTP if the seed row exists; child paths must already be on the tree.",
      "summary: tested/untested/skipped counts from work-state (not Traffic purpose=test). Primary duty: look at the tree → plan → act → mark/skip → look again.",
      `list: default seen+touched untested queue; limit default ${SURFACE_LIST_DEFAULT_LIMIT}. status=all for full ledger.`,
      "get: by id, location, or origin_key+path_key.",
      "Platform vuln priors alone ≠ TESTED / ≠ coverage complete. Disclose remaining untested on pause. Coverage never hard-blocks booking.",
      "Optional upsert (non-primary): rare correctives for identity attrs. Cannot set booked. Cannot set coverage. status=deadend|skipped_roe is rejected — use skip.",
      "Main and Worker share the same Case ledger. Offline ok — no Platform required.",
      "Prefer this tool over fact(op=surface).",
      `Write hard-cap ${SURFACE_WRITE_HARD_CAP} rows; prefer ≤${SURFACE_UPSERT_BATCH_MAX} per optional upsert call.`,
    ].join(" "),
    parameters: Type.Object({
      op: Type.String({ description: "summary | list | get | mark | unmark | skip | upsert (upsert non-primary)" }),
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
            "upsert: seen only (not booked; not deadend/skipped_roe — use skip). list: filter or comma-list or 'all' (default seen+touched untested)",
        }),
      ),
      reason: Type.Optional(
        Type.String({ description: "skip: deadend | roe (required for op=skip)" }),
      ),
      coverage: Type.Optional(
        Type.String({ description: "list filter: untested | tested | skipped" }),
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
            coverage: s.coverage,
          })),
          ...bookedSample.surfaces.map((s) => ({
            location: s.location,
            path_key: s.path_key,
            origin_key: s.origin_key,
            status: s.status,
            coverage: s.coverage,
          })),
        ].slice(0, SURFACE_SUMMARY_SAMPLE_MAX);
        const allRows = await store.all();
        const newQueue = selectNewUntestedSurfaces(allRows, SURFACE_SUMMARY_SAMPLE_MAX);
        return jsonResult({
          ok: true,
          op: "summary",
          total: cov.total,
          seen: cov.open,
          touched: cov.in_probe,
          tested: cov.tested,
          untested: cov.untested,
          skipped: cov.skipped,
          new_untested: newQueue.count,
          booked: cov.booked,
          actionable: cov.actionable,
          counts: {
            seen: cov.open,
            touched: cov.in_probe,
            tested: cov.tested,
            untested: cov.untested,
            skipped: cov.skipped,
            new_untested: newQueue.count,
            booked: cov.booked,
          },
          new_untested_samples: newQueue.samples,
          new_untested_mode: newQueue.mode,
          sample_paths,
          samples,
          guidance:
            cov.total === 0
              ? "Ledger empty. Fill is Runtime-passive: real Traffic settle + TARGET seed. Explore with http/session/browser so requests land; then re-check summary. Coverage: surface(op=mark|unmark|skip) on existing identities."
              : "Coverage snapshot (work-state). Primary duty: look at untested/new → plan → act → surface(op=mark) or surface(op=skip, reason=deadend|roe) → look again. Traffic purpose=test does not mark TESTED. Platform vuln priors ≠ TESTED / ≠ coverage complete. Cannot invent identities. Open untested never blocks booking — disclose on pause. Use surface(list) for pages.",
        });
      }

      if (op === "list") {
        const result = await store.list({
          status: params?.status,
          coverage: params?.coverage,
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
              ? "More rows match — page with offset+=limit. Default filter is seen+touched untested; status=all for full ledger."
              : "Actionable queue page (seen+touched untested by default). Ledger fills from Traffic settle + TARGET seed; coverage via mark/skip. surface(summary) for counts.",
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

      if (op === "mark" || op === "unmark" || op === "skip") {
        const coverage =
          op === "mark" ? "tested" : op === "unmark" ? "untested" : "skipped";
        const reasonRaw = params?.reason;
        if (op === "skip") {
          const r = String(reasonRaw || "").trim().toLowerCase();
          if (r !== "deadend" && r !== "roe") {
            return textResult(`error: ${SKIP_REASON_REQUIRED_ERROR}`, { isError: true });
          }
        }
        const existing = await store.get({
          id: params?.id,
          location: params?.location,
          origin_key: params?.origin_key,
          path_key: params?.path_key,
        });
        const host = hostFromWriteParams(
          params,
          existing ? String(existing.location || existing.origin_key || "") : "",
        );
        const foreign = rejectForeignSurfaceWrite(runtime, host);
        if (foreign) return foreign;
        const written = await store.setCoverage({
          id: params?.id,
          location: params?.location,
          origin_key: params?.origin_key,
          path_key: params?.path_key,
          coverage,
          skip_reason: op === "skip" ? coerceSurfaceSkipReason(reasonRaw) : undefined,
          marked_by: resolveCoverageMarkedBy(runtime),
        });
        if (!written.ok) {
          return textResult(`error: ${written.error}`, { isError: true });
        }
        const platformOnline = isSurfacePlatformOnline(runtime);
        if (platformOnline) {
          void enqueueSurfacePlatformSync(runtime, [written.surface]);
        }
        return jsonResult({
          ok: true,
          op,
          surface: written.surface,
          coverage: written.surface.coverage,
          coverage_skip_reason: written.surface.coverage_skip_reason,
          guidance:
            op === "skip"
              ? "Coverage skipped. Graph todo(done) treats skipped as not-open. Status (seen/touched/booked) is unchanged."
              : op === "mark"
                ? "Coverage tested. Who-tests-marks. Status (seen/touched/booked) is unchanged."
                : "Coverage returned to untested.",
        });
      }

      if (op === "upsert") {
        const items = asItemList(params || {});
        if (!items.length) {
          return textResult(
            "error: surface(upsert) requires location or surfaces[{location,…}]",
            { isError: true },
          );
        }
        const terminal = items.find((it) => {
          const st = String(it.status || "").trim().toLowerCase();
          return st === "deadend" || st === "skipped_roe";
        });
        if (terminal) {
          return textResult(`error: ${UPSERT_TERMINAL_STATUS_ERROR}`, { isError: true });
        }
        if (items.length > SURFACE_UPSERT_BATCH_MAX) {
          return textResult(
            `error: surface(upsert) batch max is ${SURFACE_UPSERT_BATCH_MAX} per call (got ${items.length})`,
            { isError: true },
          );
        }
        for (const item of items) {
          const host = hostFromWriteParams({ location: item.location });
          const foreign = rejectForeignSurfaceWrite(runtime, host);
          if (foreign) return foreign;
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

      return textResult("error: op must be summary|list|get|mark|unmark|skip|upsert", { isError: true });
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
