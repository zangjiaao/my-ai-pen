/**
 * Spec #368 / #374 — Case Surface online dual-write (Node → Platform).
 *
 * After local SQLite commit, when Node is bound to Platform, publish
 * `surface_upsert` asynchronously. Tool ok never waits on Platform latency.
 *
 * platform_sync on rows: pending → ok | error (with retry/recovery).
 * Offline / standalone: no publish; store writes platform_sync=offline.
 */

import type { PlatformMessage, PlatformSink, ToolRuntime } from "../types.js";
import type { SurfaceRow } from "../stores/surface-sqlite.js";

/** Default retry budget for a single dual-write batch. */
export const SURFACE_SYNC_MAX_ATTEMPTS = 3;

/** Base delay between retries (ms); multiplied by attempt index. */
export const SURFACE_SYNC_BASE_DELAY_MS = 100;

/** In-flight dual-write promises (test flush + avoid unhandled rejections). */
const inflight = new Set<Promise<void>>();

export type SurfacePlatformSyncOptions = {
  maxAttempts?: number;
  baseDelayMs?: number;
  /** Inject sleep for tests (default setTimeout). */
  sleep?: (ms: number) => Promise<void>;
};

/**
 * Online when Node has Platform HTTP/token binding (main/session-runner sets
 * platformApi from nodeToken) and a non-empty conversationId.
 * Standalone/lab without platformApi stays offline/local-only.
 */
export function isSurfacePlatformOnline(runtime: ToolRuntime): boolean {
  const conv = String(runtime.task?.conversationId || "").trim();
  if (!conv) return false;
  return Boolean(runtime.platformApi);
}

/** Project a SQLite row into the Platform surface_upsert payload shape (#373). */
export function surfaceRowToPlatformPayload(row: SurfaceRow): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: row.id,
    origin_key: row.origin_key,
    path_key: row.path_key,
    location: row.location,
    methods: row.methods,
    params: row.params,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  if (row.kind) out.kind = row.kind;
  if (row.auth) out.auth = row.auth;
  if (row.note) out.note = row.note;
  if (row.source) out.source = row.source;
  if (row.source_agent_id) out.source_agent_id = row.source_agent_id;
  // platform_sync is Node-side only — never sent to Case document.
  return out;
}

export function buildSurfaceUpsertMessage(input: {
  conversationId: string;
  taskId?: string;
  surfaces: SurfaceRow[];
}): PlatformMessage {
  const msg: PlatformMessage = {
    type: "surface_upsert",
    conversation_id: input.conversationId,
    surfaces: input.surfaces.map(surfaceRowToPlatformPayload),
  };
  if (input.taskId) msg.task_id = input.taskId;
  return msg;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Publish one batch to Platform with retry; update row platform_sync to ok|error.
 * Callers should not block tool returns on this promise.
 */
export async function runSurfacePlatformSync(
  runtime: ToolRuntime,
  rows: SurfaceRow[],
  options: SurfacePlatformSyncOptions = {},
): Promise<void> {
  const store = runtime.surfaceSqlite;
  if (!store || !rows.length) return;

  const conversationId = String(runtime.task.conversationId || "").trim();
  if (!conversationId) return;

  const ids = rows.map((r) => r.id).filter(Boolean);
  if (!ids.length) return;

  const maxAttempts = Math.max(1, options.maxAttempts ?? SURFACE_SYNC_MAX_ATTEMPTS);
  const baseDelayMs = Math.max(0, options.baseDelayMs ?? SURFACE_SYNC_BASE_DELAY_MS);
  const sleep = options.sleep ?? defaultSleep;
  const platform: PlatformSink = runtime.platform;
  const message = buildSurfaceUpsertMessage({
    conversationId,
    taskId: runtime.task.taskId,
    surfaces: rows,
  });

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await platform.send(message);
      await store.setPlatformSync(ids, "ok");
      return;
    } catch (err) {
      lastError = err;
      await store.setPlatformSync(ids, "error").catch(() => {});
      if (attempt < maxAttempts && baseDelayMs > 0) {
        await sleep(baseDelayMs * attempt);
      }
    }
  }

  // Final state already error; log for operators.
  console.warn(
    `[node4] surface dual-write failed after ${maxAttempts} attempt(s) conv=${conversationId}: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

/**
 * Enqueue async dual-write. Returns the background promise (tool path uses void;
 * tests may await or call waitSurfacePlatformSyncs).
 */
export function enqueueSurfacePlatformSync(
  runtime: ToolRuntime,
  rows: SurfaceRow[],
  options?: SurfacePlatformSyncOptions,
): Promise<void> {
  if (!rows.length || !isSurfacePlatformOnline(runtime)) {
    return Promise.resolve();
  }
  const p = runSurfacePlatformSync(runtime, rows, options)
    .catch((err) => {
      console.warn(
        `[node4] surface dual-write unhandled: ${err instanceof Error ? err.message : String(err)}`,
      );
    })
    .finally(() => {
      inflight.delete(p);
    });
  inflight.add(p);
  return p;
}

/** Test helper: wait for all enqueued dual-writes to settle. */
export async function waitSurfacePlatformSyncs(): Promise<void> {
  while (inflight.size > 0) {
    await Promise.all([...inflight]);
  }
}

/** Test helper: clear tracked inflight set (does not cancel work). */
export function resetSurfacePlatformSyncTracking(): void {
  inflight.clear();
}
