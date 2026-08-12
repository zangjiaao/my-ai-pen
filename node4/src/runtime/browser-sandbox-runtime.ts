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
  PEN_SANDBOX_HOME_ENV,
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

type SessionRecord = BrowserSandboxSession & {
  /** Container believed running (false after idle/Node stop). */
  started: boolean;
};

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
    const sep = key.indexOf("::");
    if (sep <= 0 || sep >= key.length - 2) {
      throw new Error(
        "browser sandbox seatKey must be conversationId::expertId (or pass BrowserSandboxSeat)",
      );
    }
    const conversationId = key.slice(0, sep);
    const expertId = key.slice(sep + 2);
    if (!conversationId || !expertId) {
      throw new Error("browser sandbox seatKey must be conversationId::expertId");
    }
    return { conversationId, expertId, seatKey: key };
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
  /**
   * Constructor overrides only. Live knobs re-read from process.env on each
   * getLeaseConfig(). Prefer `tsx --import ./src/load-env.ts` + lazy singleton
   * so env is ready before first construct; re-read is belt-and-suspenders.
   */
  private readonly leaseConfigOverrides: Partial<BrowserSandboxLeaseConfig>;
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly locks = new Map<string, Promise<unknown>>();
  /** Seats with an in-flight work-burst (lease heartbeat priority). */
  private readonly heldSeats = new Set<string>();
  /** Last pen-sandbox tool traffic (ensure/exec) per seat — idle stop clock. */
  private readonly lastTrafficMs = new Map<string, number>();

  constructor(opts: BrowserSandboxRuntimeOptions = {}) {
    this.docker = opts.docker ?? createProcessDockerPort();
    this.resolveImage = opts.resolveImage ?? resolveBrowserSandboxImage;
    this.nodeId = opts.nodeId?.trim() || process.env.NODE_NAME?.trim() || "pentest-node4-01";
    this.instanceId = opts.instanceId?.trim() || BROWSER_SANDBOX_INSTANCE_ID;
    this.now = opts.now ?? (() => Date.now());
    this.leaseConfigOverrides = { ...(opts.leaseConfig || {}) };
  }

  /**
   * Env is source of truth at call time; constructor leaseConfig is test/prod override.
   * Must not snapshot env at construct — main imports this module before loadDotEnv().
   */
  getLeaseConfig(): BrowserSandboxLeaseConfig {
    const base = loadBrowserSandboxLeaseConfig();
    const o = this.leaseConfigOverrides;
    return {
      heartbeatMs: o.heartbeatMs ?? base.heartbeatMs,
      leaseMs: o.leaseMs ?? base.leaseMs,
      janitorMs: o.janitorMs ?? base.janitorMs,
      idleStopMs: o.idleStopMs ?? base.idleStopMs,
    };
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

  listHeldSeats(): string[] {
    return [...this.heldSeats];
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
    return Math.floor((this.now() + this.getLeaseConfig().leaseMs) / 1000);
  }

  async ensure(
    seat: BrowserSandboxSeat | string,
    opts?: BrowserSandboxEnsureOptions,
  ): Promise<BrowserSandboxSession> {
    const s = normalizeSeat(seat);
    return this.withSeatLock(s.seatKey, () => this.ensureUnlocked(s, opts));
  }

  private touchTraffic(seatKey: string): void {
    this.lastTrafficMs.set(seatKey, this.now());
  }

  private sessionView(record: SessionRecord): BrowserSandboxSession {
    return {
      containerName: record.containerName,
      image: record.image,
      conversationId: record.conversationId,
      expertId: record.expertId,
      seatKey: record.seatKey,
      workspaceHostPath: record.workspaceHostPath,
    };
  }

  private workspaceFromOpts(opts?: BrowserSandboxEnsureOptions): string | undefined {
    if (opts?.workspaceHostPath == null) return undefined;
    const p = String(opts.workspaceHostPath).trim();
    return p ? resolve(p) : undefined;
  }

  private async rememberRunning(
    seat: BrowserSandboxSeat,
    name: string,
    image: string,
    workspaceHostPath?: string,
  ): Promise<BrowserSandboxSession> {
    const record: SessionRecord = {
      containerName: name,
      image,
      conversationId: seat.conversationId,
      expertId: seat.expertId,
      seatKey: seat.seatKey,
      workspaceHostPath,
      started: true,
    };
    this.sessions.set(seat.seatKey, record);
    await this.docker.writeLease(name, this.leaseUntilFromNow()).catch(() => {});
    return this.sessionView(record);
  }

  /** Start a known container; false if start failed (caller may recreate). */
  private async tryStartContainer(name: string): Promise<boolean> {
    const startResult = await this.docker.start(name, 60_000);
    if (startResult.unavailable) return false;
    if (startResult.exitCode != null && startResult.exitCode !== 0) return false;
    return true;
  }

  private async ensureUnlocked(
    seat: BrowserSandboxSeat,
    opts?: BrowserSandboxEnsureOptions,
  ): Promise<BrowserSandboxSession> {
    const key = seat.seatKey;
    this.touchTraffic(key);
    const image = this.resolveImage();
    const name = containerNameForSeat(key);
    const workspaceHostPath =
      this.workspaceFromOpts(opts) ?? this.sessions.get(key)?.workspaceHostPath;

    // 1) Process map — re-verify Docker (never trust started=true blindly).
    const existing = this.sessions.get(key);
    if (existing) {
      const state = await this.docker.inspectState(existing.containerName, 15_000);
      if (state === "running") {
        existing.started = true;
        if (workspaceHostPath) existing.workspaceHostPath = workspaceHostPath;
        return this.sessionView(existing);
      }
      if (state === "stopped") {
        if (await this.tryStartContainer(existing.containerName)) {
          existing.started = true;
          if (workspaceHostPath) existing.workspaceHostPath = workspaceHostPath;
          await this.docker.writeLease(existing.containerName, this.leaseUntilFromNow()).catch(() => {});
          return this.sessionView(existing);
        }
      }
      // missing / unknown / start failed → drop map entry and continue
      this.sessions.delete(key);
    }

    // 2) Host may still have the named box (Node restart / map miss).
    const hostState = await this.docker.inspectState(name, 15_000);
    if (hostState === "running") {
      return this.rememberRunning(seat, name, image, workspaceHostPath);
    }
    if (hostState === "stopped") {
      if (await this.tryStartContainer(name)) {
        return this.rememberRunning(seat, name, image, workspaceHostPath);
      }
      await this.docker.rmForce(name, 30_000).catch(() => {});
    }

    // 3) Create fresh
    const leaseUntil = this.leaseUntilFromNow();
    const labels = buildBrowserSandboxLabels({
      nodeId: this.nodeId,
      instanceId: this.instanceId,
      conversationId: seat.conversationId,
      expertId: seat.expertId,
      seatKey: key,
      leaseUntilUnix: leaseUntil,
    });

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

    const env = [
      "NO_PROXY=localhost,127.0.0.1,host.docker.internal",
      "no_proxy=localhost,127.0.0.1,host.docker.internal",
      `AGENT_BROWSER_SESSION=${agentBrowserSessionName(key)}`,
      ...PEN_SANDBOX_HOME_ENV,
    ];

    await this.docker.rmForce(name, 30_000);

    const started = await this.docker.runDetached(
      {
        name,
        image,
        env,
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

    return this.rememberRunning(seat, name, image, workspaceHostPath);
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
      this.touchTraffic(s.seatKey);
      return { ...result, via: "sandbox" };
    });
  }

  /**
   * Spec #430: docker stop only — keep map entry so ensure can start again.
   */
  async stop(seat: BrowserSandboxSeat | string): Promise<void> {
    let key: string;
    try {
      key = normalizeSeat(seat).seatKey;
    } catch {
      key = String(seat || "").trim();
    }
    if (!key) return;
    return this.withSeatLock(key, async () => {
      const session = this.sessions.get(key);
      const name = session?.containerName ?? containerNameForSeat(key);
      await this.docker.stop(name, 60_000).catch(() => {});
      if (session) {
        session.started = false;
      } else {
        // Remember stopped box for later start even if we had no map entry.
        this.sessions.set(key, {
          containerName: name,
          image: "",
          conversationId: key.includes("::") ? key.split("::")[0]! : "",
          expertId: key.includes("::") ? key.slice(key.indexOf("::") + 2) : "",
          seatKey: key,
          started: false,
        });
      }
    });
  }

  /** Spec #430: stop all process-known sticky boxes (Node shutdown). */
  async stopAll(): Promise<number> {
    const keys = [...this.sessions.keys()];
    await Promise.all(keys.map((k) => this.stop(k)));
    return keys.length;
  }

  /**
   * Spec #430: stop seats with no pen-sandbox tool traffic for idleStopMs (never rm).
   * Skips currently held seats (mid-burst).
   *
   * Also scans Docker labels so sticky boxes survive a Node restart with an empty
   * process map — previously idle stop only walked `sessions` + required
   * lastTrafficMs, so host boxes stayed Up forever after restart (lab: 5m idle
   * env looked "ignored").
   */
  async stopIdleSeats(nowMs?: number): Promise<string[]> {
    const idleMs = this.getLeaseConfig().idleStopMs;
    if (!idleMs || idleMs <= 0) return [];
    const now = nowMs ?? this.now();
    const stopped: string[] = [];
    const considered = new Set<string>();

    const lastActivityMs = async (key: string, containerName: string): Promise<number | null> => {
      const t = this.lastTrafficMs.get(key);
      if (t != null) return t;
      if (this.docker.inspectStartedAtMs) {
        return this.docker.inspectStartedAtMs(containerName, 15_000);
      }
      return null;
    };

    for (const [key, rec] of this.sessions) {
      if (!rec.started) continue;
      if (this.heldSeats.has(key)) continue;
      considered.add(key);
      const lastMs = await lastActivityMs(key, rec.containerName);
      // No traffic clock and no StartedAt → do not stop map-known seats (avoid
      // killing a box mid first-ensure). Host orphans handled below.
      if (lastMs == null) continue;
      if (now - lastMs < idleMs) continue;
      await this.stop(key);
      stopped.push(key);
    }

    // Host scan: process restart left sticky boxes running with empty map.
    try {
      const items = await this.docker.listBrowserSandboxes();
      const candidates = items.filter((item) => {
        const seatKey = String(
          item.labels?.[BROWSER_SANDBOX_LABEL.seatKey] ||
            item.labels?.[BROWSER_SANDBOX_LABEL.parentTaskId] ||
            "",
        ).trim();
        return Boolean(seatKey) && !considered.has(seatKey) && !this.heldSeats.has(seatKey);
      });
      // Parallel inspect — avoid serial docker RPC per box.
      // Clock policy matches map seats: no lastTraffic and no StartedAt → skip
      // (do not fail-open into stop on inspect jitter / unknown age).
      const decisions = await Promise.all(
        candidates.map(async (item) => {
          const seatKey = String(
            item.labels?.[BROWSER_SANDBOX_LABEL.seatKey] ||
              item.labels?.[BROWSER_SANDBOX_LABEL.parentTaskId] ||
              "",
          ).trim();
          const state = await this.docker.inspectState(item.name, 15_000);
          if (state !== "running") return null;
          const lastMs = await lastActivityMs(seatKey, item.name);
          if (lastMs == null) {
            console.warn(
              `[node4] pen-sandbox idle skip (no clock): seat=${seatKey} name=${item.name}`,
            );
            return null;
          }
          if (now - lastMs < idleMs) return null;
          return { seatKey, item };
        }),
      );
      for (const d of decisions) {
        if (!d) continue;
        const { seatKey, item } = d;
        if (considered.has(seatKey)) continue;
        // Stop by Docker name; remember stopped sticky for later ensure/start.
        await this.docker.stop(item.name, 60_000).catch(() => {});
        const conv = String(item.labels?.[BROWSER_SANDBOX_LABEL.conversationId] || "").trim();
        const expert = String(item.labels?.[BROWSER_SANDBOX_LABEL.expertId] || "").trim();
        const existing = this.sessions.get(seatKey);
        if (existing) {
          existing.started = false;
          existing.containerName = item.name;
        } else {
          this.sessions.set(seatKey, {
            containerName: item.name,
            image: "",
            conversationId: conv,
            expertId: expert,
            seatKey,
            started: false,
          });
        }
        stopped.push(seatKey);
        considered.add(seatKey);
      }
    } catch {
      /* best-effort label scan */
    }

    return stopped;
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
    this.lastTrafficMs.delete(key);
    return this.withSeatLock(key, async () => {
      const session = this.sessions.get(key);
      const name = session?.containerName ?? containerNameForSeat(key);

      // Skip agent-browser close (up to 30s): docker rm -f tears down the box
      // and kills the browser process. Prefer fast Case/Session Delete paths.
      await this.docker.rmForce(name, 30_000);
      this.sessions.delete(key);
    });
  }

  /**
   * Spec #429: rm all sticky boxes for a Case (conversationId).
   * Process map/held keys **and** Docker labels (covers Node restart / empty map).
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
    // Scan Docker by conversation label so Case close works after process restart.
    const orphanNames: string[] = [];
    try {
      const items = await this.docker.listBrowserSandboxes();
      for (const item of items) {
        const conv = item.labels?.[BROWSER_SANDBOX_LABEL.conversationId];
        if (conv !== c) continue;
        const seatKey =
          item.labels?.[BROWSER_SANDBOX_LABEL.seatKey] ||
          item.labels?.[BROWSER_SANDBOX_LABEL.parentTaskId];
        if (seatKey) keys.add(seatKey);
        else orphanNames.push(item.name);
      }
    } catch {
      /* best-effort label scan */
    }
    await Promise.all([...keys].map((k) => this.dispose(k)));
    for (const name of orphanNames) {
      await this.docker.rmForce(name, 30_000).catch(() => {});
      for (const [sid, rec] of this.sessions) {
        if (rec.containerName === name) this.sessions.delete(sid);
      }
    }
    return keys.size + orphanNames.length;
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
    // Running or stopped sticky seats still in process map must not be janitor-rm'd
    // (idle stop leaves started=false; product rm only on seat death).
    const mappedNames = new Set([...this.sessions.values()].map((s) => s.containerName));
    for (const item of items) {
      const seatFromLabel =
        item.labels?.[BROWSER_SANDBOX_LABEL.seatKey] ||
        item.labels?.[BROWSER_SANDBOX_LABEL.parentTaskId];
      if (seatFromLabel && this.heldSeats.has(seatFromLabel)) continue;
      if (seatFromLabel && this.sessions.has(seatFromLabel)) continue;
      // Never reap a sticky session still mapped in this process.
      if (mappedNames.has(item.name)) continue;

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

/**
 * Lazy singleton — construct only after loadDotEnv / --import load-env so
 * process.env knobs (e.g. PEN_SANDBOX_IDLE_STOP_MS) are visible. getLeaseConfig
 * still re-reads env at call time as belt-and-suspenders.
 */
let defaultRuntime: BrowserSandboxRuntime | null = null;

export function getDefaultBrowserSandboxRuntime(): BrowserSandboxRuntime {
  if (!defaultRuntime) defaultRuntime = new BrowserSandboxRuntime();
  return defaultRuntime;
}

export function holdBrowserSandboxSeat(seat: BrowserSandboxSeat | string): void {
  getDefaultBrowserSandboxRuntime().holdSeat(seat);
}

export function releaseBrowserSandboxSeat(seat: BrowserSandboxSeat | string): void {
  getDefaultBrowserSandboxRuntime().releaseSeat(seat);
}

export type BrowserSandboxBackgroundHandles = {
  stop: () => void;
};

export function startBrowserSandboxBackgroundJobs(
  runtime: BrowserSandboxRuntime = getDefaultBrowserSandboxRuntime(),
): BrowserSandboxBackgroundHandles {
  let stopped = false;
  // Boot log from live config (getLeaseConfig re-reads env).
  const boot = runtime.getLeaseConfig();
  console.log(
    `[node4] pen-sandbox idle stop: ${
      boot.idleStopMs > 0
        ? `${boot.idleStopMs}ms (~${Math.round(boot.idleStopMs / 60_000)}m)`
        : "disabled"
    }`,
  );

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

  const runIdleStop = () => {
    if (stopped) return;
    // Always use live getLeaseConfig().idleStopMs inside stopIdleSeats.
    void runtime
      .stopIdleSeats()
      .then((keys) => {
        if (keys.length) {
          console.log(`[node4] pen-sandbox idle stop (${keys.length}): ${keys.join(", ")}`);
        }
      })
      .catch(() => {});
  };

  /** Idle poll period from current knobs — min(idle/4, 5m), floor 60s when enabled. */
  const idlePeriodMs = (): number => {
    const idleStopMs = runtime.getLeaseConfig().idleStopMs;
    if (!idleStopMs || idleStopMs <= 0) return 0;
    return Math.min(Math.max(Math.floor(idleStopMs / 4), 60_000), 5 * 60_000);
  };

  runJanitor();
  // First idle pass at boot (same as janitor) so restart reclaims aged host boxes
  // without waiting for the first interval.
  if (idlePeriodMs() > 0) runIdleStop();

  // Heartbeat / janitor periods: re-read on each fire via nested setTimeout so
  // env changes after boot are not frozen (idle threshold already live in stopIdleSeats).
  let janitorTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleJanitor = () => {
    if (stopped) return;
    const ms = runtime.getLeaseConfig().janitorMs;
    janitorTimer = setTimeout(() => {
      runJanitor();
      scheduleJanitor();
    }, ms);
    janitorTimer.unref?.();
  };
  const scheduleHeartbeat = () => {
    if (stopped) return;
    const ms = runtime.getLeaseConfig().heartbeatMs;
    heartbeatTimer = setTimeout(() => {
      runHeartbeat();
      scheduleHeartbeat();
    }, ms);
    heartbeatTimer.unref?.();
  };
  const scheduleIdle = () => {
    if (stopped) return;
    const ms = idlePeriodMs();
    if (ms <= 0) return;
    idleTimer = setTimeout(() => {
      runIdleStop();
      scheduleIdle();
    }, ms);
    idleTimer.unref?.();
  };

  scheduleJanitor();
  scheduleHeartbeat();
  scheduleIdle();

  return {
    stop: () => {
      stopped = true;
      if (janitorTimer) clearTimeout(janitorTimer);
      if (heartbeatTimer) clearTimeout(heartbeatTimer);
      if (idleTimer) clearTimeout(idleTimer);
    },
  };
}

/** Process-default dispose for one seat (Session delete / inject — not task-end). */
export async function disposeBrowserSandbox(seatKey: string): Promise<void> {
  return getDefaultBrowserSandboxRuntime().dispose(seatKey);
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
  return getDefaultBrowserSandboxRuntime().dispose({ conversationId: c, expertId: e, seatKey });
}

/** Spec #429: rm all sticky boxes under a Case. */
export async function disposeBrowserSandboxForCase(conversationId: string): Promise<number> {
  return getDefaultBrowserSandboxRuntime().disposeForConversation(conversationId);
}

/** Process-default dispose of all sandboxes on this instance (prefer stopAll on graceful shutdown). */
export async function disposeAllBrowserSandboxes(): Promise<void> {
  return getDefaultBrowserSandboxRuntime().disposeAll();
}

/** Spec #430: stop all sticky boxes (Node graceful shutdown). */
export async function stopAllBrowserSandboxes(): Promise<number> {
  return getDefaultBrowserSandboxRuntime().stopAll();
}

export type { BrowserSandboxDockerPort, BrowserSandboxListItem, SandboxExecResult } from "./browser-sandbox-docker.js";
