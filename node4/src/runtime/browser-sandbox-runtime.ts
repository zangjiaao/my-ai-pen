/**
 * BrowserSandboxRuntime — ensure / reuse / dispose, parent locks, hold/heartbeat, janitor.
 * Spec #331–#334.
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
  type SandboxExecResult,
} from "./browser-sandbox-docker.js";
import {
  agentBrowserSessionName,
  containerNameForParentTask,
  resolveBrowserSandboxImage,
} from "./browser-sandbox-image.js";

export type BrowserSandboxSession = {
  containerName: string;
  image: string;
  parentTaskId: string;
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

/**
 * Process-local browser sandbox lifecycle keyed by parent task id.
 * One container per parent; serialize ensure/exec/dispose; labels + lease for janitor.
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
  private readonly heldParents = new Set<string>();

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

  holdParentTask(parentTaskId: string): void {
    const key = String(parentTaskId || "").trim();
    if (key) this.heldParents.add(key);
  }

  releaseParentTask(parentTaskId: string): void {
    const key = String(parentTaskId || "").trim();
    if (key) this.heldParents.delete(key);
  }

  listHeldParentTasks(): string[] {
    return [...this.heldParents];
  }

  private async withParentLock<T>(parentTaskId: string, fn: () => Promise<T>): Promise<T> {
    const key = String(parentTaskId || "").trim();
    if (!key) throw new Error("parentTaskId required for browser sandbox");
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
      // GC lock entry when this chain segment is still the map tail.
      void tail.then(() => {
        if (this.locks.get(key) === tail) this.locks.delete(key);
      });
    }
  }

  private leaseUntilFromNow(): number {
    return Math.floor((this.now() + this.leaseConfig.leaseMs) / 1000);
  }

  async ensure(parentTaskId: string): Promise<BrowserSandboxSession> {
    return this.withParentLock(parentTaskId, () => this.ensureUnlocked(parentTaskId));
  }

  private async ensureUnlocked(parentTaskId: string): Promise<BrowserSandboxSession> {
    const key = String(parentTaskId || "").trim();
    if (!key) throw new Error("parentTaskId required for browser sandbox");

    const existing = this.sessions.get(key);
    if (existing?.started) {
      return {
        containerName: existing.containerName,
        image: existing.image,
        parentTaskId: existing.parentTaskId,
      };
    }

    const image = this.resolveImage();
    const name = containerNameForParentTask(key);
    const leaseUntil = this.leaseUntilFromNow();
    const labels = buildBrowserSandboxLabels({
      nodeId: this.nodeId,
      instanceId: this.instanceId,
      parentTaskId: key,
      leaseUntilUnix: leaseUntil,
    });

    await this.docker.rmForce(name, 30_000);

    const started = await this.docker.runDetached(
      {
        name,
        image,
        env: [
          "NO_PROXY=localhost,127.0.0.1,host.docker.internal",
          "no_proxy=localhost,127.0.0.1,host.docker.internal",
          `AGENT_BROWSER_SESSION=${agentBrowserSessionName(key)}`,
        ],
        labels,
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
      parentTaskId: key,
      started: true,
    };
    this.sessions.set(key, record);
    return {
      containerName: record.containerName,
      image: record.image,
      parentTaskId: record.parentTaskId,
    };
  }

  async exec(
    parentTaskId: string,
    argv: string[],
    timeoutMs = 120_000,
  ): Promise<SandboxExecResult> {
    return this.withParentLock(parentTaskId, async () => {
      const session = await this.ensureUnlocked(parentTaskId);
      const result = await this.docker.exec(session.containerName, argv, timeoutMs);
      return { ...result, via: "sandbox" };
    });
  }

  async dispose(parentTaskId: string): Promise<void> {
    const key = String(parentTaskId || "").trim();
    if (!key) return;
    this.heldParents.delete(key);
    return this.withParentLock(key, async () => {
      const session = this.sessions.get(key);
      const name = session?.containerName ?? containerNameForParentTask(key);

      if (session) {
        await this.docker.exec(name, ["agent-browser", "close", "--all"], 30_000).catch(() => {});
      }
      await this.docker.rmForce(name, 30_000);
      this.sessions.delete(key);
    });
  }

  async disposeAll(): Promise<void> {
    const keys = [...new Set([...this.sessions.keys(), ...this.heldParents])];
    await Promise.all(keys.map((k) => this.dispose(k)));
    this.heldParents.clear();
  }

  async renewLeasesForHeldTasks(): Promise<number> {
    const leaseUntil = this.leaseUntilFromNow();
    let n = 0;
    for (const parentId of this.heldParents) {
      const session = this.sessions.get(parentId);
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
    for (const item of items) {
      // Never reap a parent this process still holds (heartbeat authority).
      const parentFromLabel = item.labels?.[BROWSER_SANDBOX_LABEL.parentTaskId];
      if (parentFromLabel && this.heldParents.has(parentFromLabel)) continue;

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
      for (const [pid, rec] of this.sessions) {
        if (rec.containerName === item.name) this.sessions.delete(pid);
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

export function holdBrowserSandboxTask(parentTaskId: string): void {
  defaultRuntime.holdParentTask(parentTaskId);
}

export function releaseBrowserSandboxTask(parentTaskId: string): void {
  defaultRuntime.releaseParentTask(parentTaskId);
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

export async function ensureBrowserSandbox(taskId: string): Promise<BrowserSandboxSession> {
  return defaultRuntime.ensure(taskId);
}

export async function execInBrowserSandbox(
  taskId: string,
  argv: string[],
  timeoutMs = 120_000,
): Promise<SandboxExecResult> {
  return defaultRuntime.exec(taskId, argv, timeoutMs);
}

export async function disposeBrowserSandbox(parentTaskId: string): Promise<void> {
  return defaultRuntime.dispose(parentTaskId);
}

export async function disposeAllBrowserSandboxes(): Promise<void> {
  return defaultRuntime.disposeAll();
}

/** @deprecated Prefer disposeBrowserSandbox */
export async function stopBrowserSandbox(taskId: string): Promise<void> {
  return defaultRuntime.dispose(taskId);
}

export type { BrowserSandboxDockerPort, BrowserSandboxListItem, SandboxExecResult };
