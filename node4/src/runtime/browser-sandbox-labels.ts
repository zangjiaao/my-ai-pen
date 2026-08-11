/**
 * Spec #334: ownership labels + lease knobs for browser sandboxes.
 * Labels are inspectable on the Docker host for multi-node reaping safety.
 */

/** Docker label keys (normalized product namespace). */
export const BROWSER_SANDBOX_LABEL = {
  component: "myaipen.component",
  nodeId: "myaipen.node_id",
  instanceId: "myaipen.instance_id",
  /** Participant Session seat (Spec #427). */
  conversationId: "myaipen.conversation_id",
  expertId: "myaipen.expert_id",
  seatKey: "myaipen.seat_key",
  /**
   * Legacy label: now stores seatKey for hold/janitor matching during cutover.
   * Prefer conversation_id + expert_id for operator search (Spec #431).
   */
  parentTaskId: "myaipen.parent_task_id",
  /** Initial lease at create; live lease is also written inside the container. */
  leaseUntil: "myaipen.lease_until",
} as const;

export const BROWSER_SANDBOX_COMPONENT = "browser-sandbox";

/** In-container path for live lease renewal (labels are immutable after create). */
export const BROWSER_SANDBOX_LEASE_PATH = "/run/myaipen/lease_until";

export type BrowserSandboxLeaseConfig = {
  /** Heartbeat interval while a seat is held or has a live session. Default 90s. */
  heartbeatMs: number;
  /** Lease TTL without renewal. Default 12 min (~8× heartbeat). */
  leaseMs: number;
  /** Janitor period. Default 120s. */
  janitorMs: number;
};

const MIN_MS = 5_000;

function envPositiveMsFrom(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const n = Number(env[key]);
  if (!Number.isFinite(n) || n < MIN_MS) return fallback;
  return Math.floor(n);
}

/** Env-tunable lease knobs (Spec #334 defaults). */
export function loadBrowserSandboxLeaseConfig(
  env: NodeJS.ProcessEnv = process.env,
): BrowserSandboxLeaseConfig {
  return {
    heartbeatMs: envPositiveMsFrom(env, "NODE4_BROWSER_SANDBOX_HEARTBEAT_MS", 90_000),
    leaseMs: envPositiveMsFrom(env, "NODE4_BROWSER_SANDBOX_LEASE_MS", 12 * 60_000),
    janitorMs: envPositiveMsFrom(env, "NODE4_BROWSER_SANDBOX_JANITOR_MS", 120_000),
  };
}

export function buildBrowserSandboxLabels(input: {
  nodeId: string;
  instanceId: string;
  conversationId: string;
  expertId: string;
  seatKey: string;
  leaseUntilUnix: number;
}): Record<string, string> {
  const seatKey = String(input.seatKey || "").slice(0, 128);
  return {
    [BROWSER_SANDBOX_LABEL.component]: BROWSER_SANDBOX_COMPONENT,
    [BROWSER_SANDBOX_LABEL.nodeId]: String(input.nodeId || "unknown").slice(0, 128),
    [BROWSER_SANDBOX_LABEL.instanceId]: String(input.instanceId || "").slice(0, 64),
    [BROWSER_SANDBOX_LABEL.conversationId]: String(input.conversationId || "").slice(0, 128),
    [BROWSER_SANDBOX_LABEL.expertId]: String(input.expertId || "").slice(0, 128),
    [BROWSER_SANDBOX_LABEL.seatKey]: seatKey,
    // Legacy field mirrors seatKey so older hold/janitor paths still match.
    [BROWSER_SANDBOX_LABEL.parentTaskId]: seatKey,
    [BROWSER_SANDBOX_LABEL.leaseUntil]: String(Math.floor(input.leaseUntilUnix)),
  };
}

export function isProductBrowserSandboxLabels(labels: Record<string, string> | null | undefined): boolean {
  if (!labels) return false;
  return labels[BROWSER_SANDBOX_LABEL.component] === BROWSER_SANDBOX_COMPONENT;
}

/** Parse lease unix seconds from label or file body. */
export function parseLeaseUntilUnix(raw: string | undefined | null): number | null {
  if (raw == null) return null;
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

/**
 * Pure janitor decision: should this labeled container be reaped?
 * Only product browser-sandbox with an expired, **trusted** lease; never non-expired (any node).
 * When leaseTrusted is false (live lease file unreadable), do not reap — avoids stale-label kills.
 */
export function shouldReapBrowserSandbox(input: {
  labels: Record<string, string>;
  leaseUntilUnix: number | null;
  nowUnix: number;
  /** Default true. false → never reap (unknown live lease). */
  leaseTrusted?: boolean;
}): boolean {
  if (input.leaseTrusted === false) return false;
  if (!isProductBrowserSandboxLabels(input.labels)) return false;
  if (input.leaseUntilUnix == null) return false;
  return input.leaseUntilUnix < input.nowUnix;
}
