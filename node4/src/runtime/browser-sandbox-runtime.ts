/**
 * BrowserSandboxRuntime — ensure / reuse / dispose, seat locks, hold/heartbeat, janitor.
 * Spec #426 / #427: keyed by Participant Session seat (conversationId + expertId).
 */
import { randomUUID } from "node:crypto";
import {
  BROWSER_SANDBOX_LABEL,
  buildBrowserSandboxLabels,
  loadBrowserSandboxLeaseConfig,
  shouldReapBrowserSandbox,
  type BrowserSandboxLeaseConfig,
} from "./browser-sandbox-labels.js";
import {
  createProcessDockerPort,
  type BrowserSandboxDockerPort,
  type BrowserSandboxListItem,
  type SandboxExecResult,
} from "./browser-sandbox-docker.js";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  agentBrowserSessionName,
  containerNameForSeat,
  formatBrowserSandboxSeatKey,
  resolveBrowserSandboxImage,
  type BrowserSandboxSeat,
} from "./browser-sandbox-image.js";

export type BrowserSandboxSession = {
  containerName: string;
  image: string;
  conversationId: string;
  expertId: string;
  seatKey: string;
  /** Host path mounted at /workspace when created (Spec #428). */
  workspaceHostPath?: string;
};

export type BrowserSandboxEnsureOptions = {
  /** Host Session workspace directory to mount at /workspace (rw). */
  workspaceHostPath?: string;
};

type SessionRecord = BrowserSandboxSession & { started: boolean };

/** Process boot UUID — restart never reuses another live process identity (Spec #334). */
export const BROWSER_SANDBOX_INSTANCE_ID = randomUUID();

export type BrowserSandboxRuntimeOptions = {
  docker?: BrowserSandboxDockerPort;
  resolveImage?: () => string;
  nodeId?: string;
  instanceId?: string;
  now?: () => number;
  leaseConfig?: Partial<BrowserSandboxLeaseConfig>;
};

function normalizeSeat(seat: BrowserSandboxSeat | string): BrowserSandboxSeat {
  if (typeof seat === "string") {
    const key = String(seat || "").trim();
    if (!key) throw new Error("seatKey required for browser sandbox");
    const idx = key.indexOf("::");
    if (idx <= 0 || idx === key.length - 2) {
      // Allow bare seatKey for dispose/ensure after resolve — conversation/expert from key parts if possible.
      const parts = key.split("::");
      if (parts.length >= 2 && parts[0] && parts[1]) {
        return {
          conversationId: parts[0],
          expertId: parts.slice(1).join("::"),
          seatKey: key,
        };
      }
      throw new Error(
        "browser sandbox seatKey must be conversationId::expertId (or pass BrowserSandboxSeat)",
      );
    }
    return {
      conversationId: key.slice(0, idx),
      expertId: key.slice(idx + 2),
      seatKey: key,
    };
  }
  const conversationId = String(seat.conversationId || "").trim();
  const expertId = String(seat.expertId || "").trim();
  const seatKey = String(seat.seatKey || "").trim() || `${conversationId}::${expertId}`;
  if (!conversationId || !expertId) {
    throw new Error("browser sandbox requires conversationId and expertId");
  }
  return { conversationId, expertId, seatKey };
}

/**
 * Process-local browser sandbox lifecycle keyed by Participant Session seat.
 * One container per seat; serialize ensure/exec/dispose; labels + lease for janitor.
 */
export class BrowserSandboxRuntime {
  private readonly docker: BrowserSandboxDockerPort;
  private readonly resolveImage: () => string;
  private readonly nodeId: string;
  private readonly instanceId: string;
  private readonly now: () => number;
  private readonly leaseConfig: BrowserSandboxLeaseConfig;
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly locks = new Map<string, Promise<unknown>>();
  /** Seats with an in-flight work-burst (lease heartbeat priority). */
  private readonly heldSeats = new Set<string>();

  constructor(opts: BrowserSandboxRuntimeOptions = {}) {
    this.docker = opts.docker ?? createProcessDockerPort();
    this.resolveImage = opts.resolveImage ?? resolveBrowserSandboxImage;
    this.nodeId = opts.nodeId?.trim() || process.env.NODE_NAME?.trim() || "pentest-node4-01";
    this.instanceId = opts.instanceId?.trim() || BROWSER_SANDBOX_INSTANCE_ID;
    this.now = opts.now ?? (() => Date.now());
    const base = loadBrowserSandboxLeaseConfig();
    this.leaseConfig = {
      heartbeatMs: opts.leaseConfig?.heartbeatMs ?? base.heartbeatMs,
      leaseMs: opts.leaseConfig?.leaseMs ?? base.leaseMs,
      janitorMs: opts.leaseConfig?.janitorMs ?? base.janitorMs,
    };
  }

  getLeaseConfig(): BrowserSandboxLeaseConfig {
    return { ...this.leaseConfig };
  }

  getInstanceId(): string {
    return this.instanceId;
  }

  getNodeId(): string {
    return this.nodeId;
  }

  holdSeat(seat: BrowserSandboxSeat | string): void {
    const key = normalizeSeat(seat).seatKey;
    if (key) this.heldSeats.add(key);
  }

  releaseSeat(seat: BrowserSandboxSeat | string): void {
    const key = normalizeSeat(seat).seatKey;
    if (key) this.heldSeats.delete(key);
  }

  /** @deprecated Use holdSeat — seat key, not parent task id. */
  holdParentTask(seatKey: string): void {
    this.holdSeat(seatKey);
  }

  /** @deprecated Use releaseSeat */
  releaseParentTask(seatKey: string): void {
    this.releaseSeat(seatKey);
  }

  listHeldSeats(): string[] {
    return [...this.heldSeats];
  }

  /** @deprecated Use listHeldSeats */
  listHeldParentTasks(): string[] {
    return this.listHeldSeats();
  }

  private async withSeatLock<T>(seatKey: string, fn: () => Promise<T>): Promise<T> {
    const key = String(seatKey || "").trim();
    if (!key) throw new Error("seatKey required for browser sandbox");
    const prev = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const tail = prev.then(
      () => held,
      () => held,
    );
    this.locks.set(key, tail);
    try {
      await prev.catch(() => {});
      return await fn();
    } finally {
      release();
      void tail.then(() => {
        if (this.locks.get(key) === tail) this.locks.delete(key);
      });
    }
  }

  private leaseUntilFromNow(): number {
    return Math.floor((this.now() + this.leaseConfig.leaseMs) / 1000);
  }

  async ensure(
    seat: BrowserSandboxSeat | string,
    opts?: BrowserSandboxEnsureOptions,
  ): Promise<BrowserSandboxSession> {
    const s = normalizeSeat(seat);
    return this.withSeatLock(s.seatKey, () => this.ensureUnlocked(s, opts));
  }

  private async ensureUnlocked(
    seat: BrowserSandboxSeat,
    opts?: BrowserSandboxEnsureOptions,
  ): Promise<BrowserSandboxSession> {
    const key = seat.seatKey;
    const existing = this.sessions.get(key);
    if (existing?.started) {
      return {
        containerName: existing.containerName,
        image: existing.image,
        conversationId: existing.conversationId,
        expertId: existing.expertId,
        seatKey: existing.seatKey,
        workspaceHostPath: existing.workspaceHostPath,
      };
    }

    const image = this.resolveImage();
    const name = containerNameForSeat(key);
    const leaseUntil = this.leaseUntilFromNow();
    const labels = buildBrowserSandboxLabels({
      nodeId: this.nodeId,
      instanceId: this.instanceId,
      conversationId: seat.conversationId,
      expertId: seat.expertId,
      seatKey: key,
      leaseUntilUnix: leaseUntil,
    });

    const workspaceHostPath = opts?.workspaceHostPath
      ? resolve(String(opts.workspaceHostPath).trim())
      : undefined;
    const volumes: string[] = [];
    if (workspaceHostPath) {
      volumes.push(`${workspaceHostPath}:/workspace:rw`);
    }
    const tplHost =
      process.env.PEN_TOOLS_NUCLEI_TEMPLATES?.trim() ||
      resolve(process.env.HOME || "/tmp", ".cache/pen-tools/nuclei-templates");
    if (existsSync(tplHost)) {
      volumes.push(`${tplHost}:/root/nuclei-templates:ro`);
    }

    await this.docker.rmForce(name, 30_000);

    const started = await this.docker.runDetached(
      {
        name,
        image,
        env: [
          "NO_PROXY=localhost,127.0.0.1,host.docker.internal",
          "no_proxy=localhost,127.0.0.1,host.docker.internal",
          "HOME=/workspace",
          `AGENT_BROWSER_SESSION=${agentBrowserSessionName(key)}`,
        ],
        labels,
        volumes,
        network: process.env.PEN_TOOLS_NETWORK?.trim() || "host",
        entrypoint: ["bash"],
        cmd: ["-lc", "sleep infinity"],
      },
      120_000,
    );

    if (started.unavailable || started.exitCode !== 0) {
      throw new Error(
        `Failed to start browser sandbox: ${started.error || started.stderr || started.stdout || `exit ${started.exitCode}`}`,
      );
    }

    await this.docker.writeLease(name, leaseUntil).catch(() => {});

    const record: SessionRecord = {
      containerName: name,
      image,
      conversationId: seat.conversationId,
      expertId: seat.expertId,
      seatKey: key,
      workspaceHostPath,
      started: true,
    };
    this.sessions.set(key, record);
    return {
      containerName: record.containerName,
      image: record.image,
      conversationId: record.conversationId,
      expertId: record.expertId,
      seatKey: record.seatKey,
      workspaceHostPath: record.workspaceHostPath,
    };
  }

  async exec(
    seat: BrowserSandboxSeat | string,
    argv: string[],
    timeoutMs = 120_000,
    opts?: BrowserSandboxEnsureOptions,
  ): Promise<SandboxExecResult> {
    const s = normalizeSeat(seat);
    return this.withSeatLock(s.seatKey, async () => {
      const session = await this.ensureUnlocked(s, opts);
      const result = await this.docker.exec(session.containerName, argv, timeoutMs);
      return { ...result, via: "sandbox" };
    });
  }

  async dispose(seat: BrowserSandboxSeat | string): Promise<void> {
    let key: string;
    try {
      key = normalizeSeat(seat).seatKey;
    } catch {
      key = String(seat || "").trim();
    }
    if (!key) return;
    this.heldSeats.delete(key);
    return this.withSeatLock(key, async () => {
      const session = this.sessions.get(key);
      const name = session?.containerName ?? containerNameForSeat(key);

      if (session) {
        await this.docker.exec(name, ["agent-browser", "close", "--all"], 30_000).catch(() => {});
      }
      await this.docker.rmForce(name, 30_000);
      this.sessions.delete(key);
    });
  }

  /**
   * Spec #429: rm all sticky boxes for a Case (conversationId).
   * Matches seatKeys `conv` or `conv::*` in process map + held set.
   */
  async disposeForConversation(conversationId: string): Promise<number> {
    const c = String(conversationId || "").trim();
    if (!c) return 0;
    const prefix = `${c}::`;
    const keys = new Set<string>();
    for (const k of this.sessions.keys()) {
      if (k === c || k.startsWith(prefix)) keys.add(k);
    }
    for (const k of this.heldSeats) {
      if (k === c || k.startsWith(prefix)) keys.add(k);
    }
    await Promise.all([...keys].map((k) => this.dispose(k)));
    return keys.size;
  }

  async disposeAll(): Promise<void> {
    const keys = [...new Set([...this.sessions.keys(), ...this.heldSeats])];
    await Promise.all(keys.map((k) => this.dispose(k)));
    this.heldSeats.clear();
  }

  /**
   * Renew leases for held seats and any process-local sticky sessions
   * so task-end release does not orphan a still-mapped sticky box to janitor.
   */
  async renewLeasesForHeldTasks(): Promise<number> {
    const leaseUntil = this.leaseUntilFromNow();
    let n = 0;
    const keys = new Set([...this.heldSeats, ...this.sessions.keys()]);
    for (const seatKey of keys) {
      const session = this.sessions.get(seatKey);
      if (!session?.started) continue;
      try {
        await this.docker.writeLease(session.containerName, leaseUntil);
        n += 1;
      } catch {
        /* best-effort */
      }
    }
    return n;
  }

  async reapExpired(nowUnix?: number): Promise<{ reaped: string[]; inspected: number }> {
    const now = nowUnix ?? Math.floor(this.now() / 1000);
    const items = await this.docker.listBrowserSandboxes();
    const reaped: string[] = [];
    const liveNames = new Set(
      [...this.sessions.values()].filter((s) => s.started).map((s) => s.containerName),
    );
    for (const item of items) {
      const seatFromLabel =
        item.labels?.[BROWSER_SANDBOX_LABEL.seatKey] ||
        item.labels?.[BROWSER_SANDBOX_LABEL.parentTaskId];
      if (seatFromLabel && this.heldSeats.has(seatFromLabel)) continue;
      // Never reap a sticky session still mapped in this process (task-end does not dispose).
      if (liveNames.has(item.name)) continue;

      if (
        !shouldReapBrowserSandbox({
          labels: item.labels,
          leaseUntilUnix: item.leaseUntilUnix,
          nowUnix: now,
          leaseTrusted: item.leaseTrusted,
        })
      ) {
        continue;
      }
      await this.docker.rmForce(item.name, 30_000).catch(() => {});
      reaped.push(item.name);
      for (const [sid, rec] of this.sessions) {
        if (rec.containerName === item.name) this.sessions.delete(sid);
      }
    }
    return { reaped, inspected: items.length };
  }

  activeSessionCount(): number {
    return this.sessions.size;
  }
}

const defaultRuntime = new BrowserSandboxRuntime();

export function getDefaultBrowserSandboxRuntime(): BrowserSandboxRuntime {
  return defaultRuntime;
}

export function holdBrowserSandboxSeat(seat: BrowserSandboxSeat | string): void {
  defaultRuntime.holdSeat(seat);
}

export function releaseBrowserSandboxSeat(seat: BrowserSandboxSeat | string): void {
  defaultRuntime.releaseSeat(seat);
}

/** @deprecated Use holdBrowserSandboxSeat */
export function holdBrowserSandboxTask(seatKey: string): void {
  holdBrowserSandboxSeat(seatKey);
}

/** @deprecated Use releaseBrowserSandboxSeat */
export function releaseBrowserSandboxTask(seatKey: string): void {
  releaseBrowserSandboxSeat(seatKey);
}

export type BrowserSandboxBackgroundHandles = {
  stop: () => void;
};

export function startBrowserSandboxBackgroundJobs(
  runtime: BrowserSandboxRuntime = defaultRuntime,
): BrowserSandboxBackgroundHandles {
  const { heartbeatMs, janitorMs } = runtime.getLeaseConfig();
  let stopped = false;

  const runJanitor = () => {
    if (stopped) return;
    void runtime
      .reapExpired()
      .then((r) => {
        if (r.reaped.length) {
          console.log(
            `[node4] browser-sandbox janitor reaped ${r.reaped.length}/${r.inspected}: ${r.reaped.join(", ")}`,
          );
        }
      })
      .catch((err) => {
        console.warn(
          `[node4] browser-sandbox janitor failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  };

  const runHeartbeat = () => {
    if (stopped) return;
    void runtime.renewLeasesForHeldTasks().catch(() => {});
  };

  runJanitor();

  const janitorTimer = setInterval(runJanitor, janitorMs);
  const heartbeatTimer = setInterval(runHeartbeat, heartbeatMs);
  janitorTimer.unref?.();
  heartbeatTimer.unref?.();

  return {
    stop: () => {
      stopped = true;
      clearInterval(janitorTimer);
      clearInterval(heartbeatTimer);
    },
  };
}

/** Process-default dispose for one seat (Session delete / inject — not task-end). */
export async function disposeBrowserSandbox(seatKey: string): Promise<void> {
  return defaultRuntime.dispose(seatKey);
}

/** Spec #429: rm sticky box for one Participant Session seat. */
export async function disposeBrowserSandboxForSeat(
  conversationId: string,
  expertId: string,
): Promise<void> {
  const c = String(conversationId || "").trim();
  const e = String(expertId || "").trim();
  if (!c || !e) return;
  const seatKey = formatBrowserSandboxSeatKey(c, e);
  return defaultRuntime.dispose({ conversationId: c, expertId: e, seatKey });
}

/** Spec #429: rm all sticky boxes under a Case. */
export async function disposeBrowserSandboxForCase(conversationId: string): Promise<number> {
  return defaultRuntime.disposeForConversation(conversationId);
}

/** Process-default dispose of all sandboxes on this instance (graceful shutdown → #430 prefers stop). */
export async function disposeAllBrowserSandboxes(): Promise<void> {
  return defaultRuntime.disposeAll();
}

export type { BrowserSandboxDockerPort, BrowserSandboxListItem, SandboxExecResult } from "./browser-sandbox-docker.js";
