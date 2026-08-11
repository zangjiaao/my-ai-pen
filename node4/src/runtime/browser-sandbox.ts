/**
 * Browser sandbox for Node4 — unified pen-sandbox (same image as shell).
 * Spec #330: browser image is explicit env only; no Strix / ambient-tag fallback.
 * Spec #331: BrowserSandboxRuntime — ensure / reuse / dispose by parent task id,
 * with an injectable Docker port for unit tests.
 * Spec #332: sub-agents share parent sandbox + session; browser tool calls serialized per parent.
 * Spec #334: ownership labels, lease heartbeat while task held, janitor reaps expired only.
 *
 * Env:
 * - NODE4_BROWSER_SANDBOX=0|false → force host agent-browser only
 * - PEN_SANDBOX_IMAGE / NODE4_BROWSER_SANDBOX_IMAGE → required pin for sandbox path
 * - NODE4_DOCKER_BIN (default docker)
 * - NODE4_BROWSER_SANDBOX_HEARTBEAT_MS / _LEASE_MS / _JANITOR_MS
 */

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { ToolRuntime } from "../types.js";
import { runAgentBrowser } from "./agent-browser-cli.js";
import {
  BROWSER_SANDBOX_COMPONENT,
  BROWSER_SANDBOX_LABEL,
  BROWSER_SANDBOX_LEASE_PATH,
  buildBrowserSandboxLabels,
  loadBrowserSandboxLeaseConfig,
  parseLeaseUntilUnix,
  shouldReapBrowserSandbox,
  type BrowserSandboxLeaseConfig,
} from "./browser-sandbox-labels.js";

export type SandboxExecResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  unavailable?: boolean;
  error?: string;
  via?: "sandbox" | "host";
};

export type BrowserSandboxListItem = {
  name: string;
  labels: Record<string, string>;
  /** Live lease unix seconds (file preferred, else create-time label). */
  leaseUntilUnix: number | null;
};

/** Injectable Docker operations used by BrowserSandboxRuntime (Spec #331 / #334). */
export type BrowserSandboxDockerPort = {
  rmForce(name: string, timeoutMs?: number): Promise<SandboxExecResult>;
  runDetached(
    opts: {
      name: string;
      image: string;
      env: string[];
      labels?: Record<string, string>;
      entrypoint: string[];
      cmd: string[];
    },
    timeoutMs?: number,
  ): Promise<SandboxExecResult>;
  exec(name: string, argv: string[], timeoutMs?: number): Promise<SandboxExecResult>;
  /** List product browser-sandbox containers (label filter). */
  listBrowserSandboxes(): Promise<BrowserSandboxListItem[]>;
  /** Write live lease file inside the container (labels are immutable after create). */
  writeLease(name: string, leaseUntilUnix: number, timeoutMs?: number): Promise<SandboxExecResult>;
};

export type BrowserSandboxSession = {
  containerName: string;
  image: string;
  parentTaskId: string;
};

type SessionRecord = BrowserSandboxSession & { started: boolean };

/** Thrown when browser sandbox image env is missing (fail closed; no Strix). */
export class BrowserSandboxImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserSandboxImageError";
  }
}

function dockerBin(): string {
  return process.env.NODE4_DOCKER_BIN?.trim() || process.env.NODE2_DOCKER_BIN?.trim() || "docker";
}

/**
 * Explicit-env-only browser sandbox image (Spec #330).
 * Order: browser override → unified pen-sandbox → shell-family pin (still explicit).
 * No local tag discovery and no third-party Strix default.
 */
export function resolveBrowserSandboxImage(): string {
  const image =
    process.env.NODE4_BROWSER_SANDBOX_IMAGE?.trim() ||
    process.env.NODE2_BROWSER_SANDBOX_IMAGE?.trim() ||
    process.env.PEN_SANDBOX_IMAGE?.trim() ||
    process.env.PEN_TOOLS_IMAGE?.trim() ||
    "";
  if (!image) {
    throw new BrowserSandboxImageError(
      "Browser sandbox image not configured. Set PEN_SANDBOX_IMAGE (or NODE4_BROWSER_SANDBOX_IMAGE) " +
        "to a first-party pen-sandbox pin and docker pull it. " +
        "Silent third-party Strix fallback is not used. " +
        "Build: bash sandbox/pen-sandbox/scripts/build.sh",
    );
  }
  return image;
}

export function isBrowserSandboxPreferred(): boolean {
  const raw = (process.env.NODE4_BROWSER_SANDBOX ?? "1").trim().toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "off" || raw === "host");
}

export function containerNameForParentTask(parentTaskId: string): string {
  const safe = parentTaskId.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 48);
  return `node4-browser-${safe}`;
}

/**
 * Spec #332: sandbox / agent-browser session key for a work unit.
 * Prefer structured parentTaskId; else strip `{parent}/sub/...` child task ids.
 */
export function resolveBrowserSandboxParentTaskId(
  task: { taskId?: string; parentTaskId?: string } | null | undefined,
): string {
  const explicit = String(task?.parentTaskId || "").trim();
  if (explicit) return explicit;
  const tid = String(task?.taskId || "").trim();
  const idx = tid.indexOf("/sub/");
  if (idx > 0) return tid.slice(0, idx);
  return tid;
}

/** Shared agent-browser session name for a parent task (cookies/storage). */
export function agentBrowserSessionName(parentTaskId: string): string {
  return `node4-${String(parentTaskId || "").slice(0, 32)}`;
}

function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function runProcess(command: string, argv: string[], timeoutMs: number): Promise<SandboxExecResult> {
  return new Promise((resolve) => {
    const child = spawn(command, argv, { shell: false });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    const finish = (result: SandboxExecResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    child.stdout?.on("data", (c: Buffer) => stdout.push(c));
    child.stderr?.on("data", (c: Buffer) => stderr.push(c));
    child.on("error", (error: NodeJS.ErrnoException) => {
      finish({
        exitCode: null,
        stdout: "",
        stderr: "",
        unavailable: error.code === "ENOENT",
        error: error.message,
      });
    });
    child.on("close", (exitCode) => {
      finish({
        exitCode,
        stdout: Buffer.concat(stdout).toString("utf8").slice(0, 256 * 1024),
        stderr: Buffer.concat(stderr).toString("utf8").slice(0, 64 * 1024),
      });
    });
  });
}

/** Real Docker CLI port used in production. */
export function createProcessDockerPort(bin: string = dockerBin()): BrowserSandboxDockerPort {
  return {
    async rmForce(name, timeoutMs = 30_000) {
      return runProcess(bin, ["rm", "-f", name], timeoutMs);
    },
    async runDetached(opts, timeoutMs = 120_000) {
      const argv: string[] = [
        "run",
        "-d",
        "--name",
        opts.name,
        "--add-host",
        "host.docker.internal:host-gateway",
        "--cap-add",
        "NET_ADMIN",
        "--cap-add",
        "NET_RAW",
      ];
      for (const e of opts.env) {
        argv.push("-e", e);
      }
      if (opts.labels) {
        for (const [k, v] of Object.entries(opts.labels)) {
          argv.push("--label", `${k}=${v}`);
        }
      }
      if (opts.entrypoint.length) {
        argv.push("--entrypoint", opts.entrypoint[0]);
      }
      argv.push(opts.image, ...opts.cmd);
      return runProcess(bin, argv, timeoutMs);
    },
    async exec(name, argv, timeoutMs = 120_000) {
      const shellCmd = argv.map(shellQuote).join(" ");
      return runProcess(bin, ["exec", name, "bash", "-lc", shellCmd], timeoutMs);
    },
    async listBrowserSandboxes() {
      const listed = await runProcess(
        bin,
        [
          "ps",
          "-aq",
          "--filter",
          `label=${BROWSER_SANDBOX_LABEL.component}=${BROWSER_SANDBOX_COMPONENT}`,
        ],
        30_000,
      );
      if (listed.unavailable || listed.exitCode !== 0) return [];
      const ids = listed.stdout
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      const out: BrowserSandboxListItem[] = [];
      for (const id of ids) {
        const inspected = await runProcess(
          bin,
          ["inspect", "--format", "{{.Name}}\t{{json .Config.Labels}}", id],
          15_000,
        );
        if (inspected.exitCode !== 0) continue;
        const line = inspected.stdout.trim();
        const tab = line.indexOf("\t");
        const rawName = tab >= 0 ? line.slice(0, tab) : line;
        const name = rawName.replace(/^\//, "");
        let labels: Record<string, string> = {};
        try {
          const json = tab >= 0 ? line.slice(tab + 1) : "{}";
          const parsed = JSON.parse(json || "{}") as Record<string, string | null>;
          labels = {};
          for (const [k, v] of Object.entries(parsed || {})) {
            if (v != null) labels[k] = String(v);
          }
        } catch {
          labels = {};
        }
        const leaseFile = await runProcess(
          bin,
          ["exec", name, "bash", "-lc", `cat ${BROWSER_SANDBOX_LEASE_PATH} 2>/dev/null || true`],
          10_000,
        );
        const fromFile = parseLeaseUntilUnix(leaseFile.stdout);
        const fromLabel = parseLeaseUntilUnix(labels[BROWSER_SANDBOX_LABEL.leaseUntil]);
        out.push({
          name,
          labels,
          leaseUntilUnix: fromFile ?? fromLabel,
        });
      }
      return out;
    },
    async writeLease(name, leaseUntilUnix, timeoutMs = 15_000) {
      const body = String(Math.floor(leaseUntilUnix));
      const cmd = `mkdir -p /run/myaipen && printf '%s' ${shellQuote(body)} > ${BROWSER_SANDBOX_LEASE_PATH}`;
      return runProcess(bin, ["exec", name, "bash", "-lc", cmd], timeoutMs);
    },
  };
}

/** Process boot UUID — restart never reuses another live process identity (Spec #334). */
export const BROWSER_SANDBOX_INSTANCE_ID = randomUUID();

export type BrowserSandboxRuntimeOptions = {
  docker?: BrowserSandboxDockerPort;
  resolveImage?: () => string;
  /** Node identity for labels (default NODE_NAME). */
  nodeId?: string;
  /** Process instance id (default boot UUID). */
  instanceId?: string;
  /** Clock for lease/janitor tests. */
  now?: () => number;
  leaseConfig?: Partial<BrowserSandboxLeaseConfig>;
};

/**
 * Process-local browser sandbox lifecycle keyed by parent task id (Spec #331 / #332 / #334).
 * One container per parent; reuse while held; dispose drops container + session.
 * Browser ensure/exec/dispose for a parent are serialized (concurrent sub-agents queue).
 * Labels + lease for distributed janitor; heartbeat while parent task is held.
 * No cross-task warm pool.
 */
export class BrowserSandboxRuntime {
  private readonly docker: BrowserSandboxDockerPort;
  private readonly resolveImage: () => string;
  private readonly nodeId: string;
  private readonly instanceId: string;
  private readonly now: () => number;
  private readonly leaseConfig: BrowserSandboxLeaseConfig;
  private readonly sessions = new Map<string, SessionRecord>();
  /** Spec #332: per-parent promise chain — browser tool calls do not interleave. */
  private readonly locks = new Map<string, Promise<unknown>>();
  /**
   * Spec #334: parent tasks still held by this process (session/task registration).
   * Heartbeat renews lease for sandboxes whose parent is in this set.
   */
  private readonly heldParents = new Set<string>();

  constructor(opts: BrowserSandboxRuntimeOptions = {}) {
    this.docker = opts.docker ?? createProcessDockerPort();
    this.resolveImage = opts.resolveImage ?? resolveBrowserSandboxImage;
    this.nodeId =
      opts.nodeId?.trim() ||
      process.env.NODE_NAME?.trim() ||
      "pentest-node4-01";
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

  /** Mark parent task held for lease heartbeat (call at task start). */
  holdParentTask(parentTaskId: string): void {
    const key = String(parentTaskId || "").trim();
    if (key) this.heldParents.add(key);
  }

  /** Drop hold registration (call at task end; dispose still owns container delete). */
  releaseParentTask(parentTaskId: string): void {
    const key = String(parentTaskId || "").trim();
    if (key) this.heldParents.delete(key);
  }

  listHeldParentTasks(): string[] {
    return [...this.heldParents];
  }

  /**
   * Serialize work for one parent task. Does not serialize across different parents
   * (shell/http stay free of this lock entirely — they never call this runtime).
   */
  private async withParentLock<T>(parentTaskId: string, fn: () => Promise<T>): Promise<T> {
    const key = String(parentTaskId || "").trim();
    if (!key) throw new Error("parentTaskId required for browser sandbox");
    const prev = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    this.locks.set(
      key,
      prev.then(
        () => held,
        () => held,
      ),
    );
    try {
      await prev.catch(() => {});
      return await fn();
    } finally {
      release();
    }
  }

  private leaseUntilFromNow(): number {
    return Math.floor((this.now() + this.leaseConfig.leaseMs) / 1000);
  }

  /** Create or reuse the long-lived browser container for this parent task. */
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

    // Clear any stale same-name container on the daemon before create.
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

  /**
   * Remove the parent-scoped container immediately and drop the local session.
   * Idempotent: safe when no session is tracked (still best-effort rm by name).
   */
  async dispose(parentTaskId: string): Promise<void> {
    const key = String(parentTaskId || "").trim();
    if (!key) return;
    this.heldParents.delete(key);
    return this.withParentLock(key, async () => {
      const session = this.sessions.get(key);
      const name = session?.containerName ?? containerNameForParentTask(key);

      if (session) {
        // Best-effort browser UI teardown; container delete is the lifecycle authority.
        await this.docker.exec(name, ["agent-browser", "close", "--all"], 30_000).catch(() => {});
      }
      await this.docker.rmForce(name, 30_000);
      this.sessions.delete(key);
    });
  }

  /** Dispose every parent-scoped sandbox held by this runtime (graceful process shutdown). */
  async disposeAll(): Promise<void> {
    const keys = [...new Set([...this.sessions.keys(), ...this.heldParents])];
    await Promise.all(keys.map((k) => this.dispose(k)));
    this.heldParents.clear();
  }

  /**
   * Spec #334: renew lease for sandboxes whose parent task is still held.
   * Does not require recent browser tool traffic.
   */
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

  /**
   * Spec #334: reap product-labeled browser sandboxes whose lease is past.
   * Never deletes non-expired containers (including other nodes' live sandboxes).
   * Ignores unlabeled / non-product containers.
   */
  async reapExpired(nowUnix?: number): Promise<{ reaped: string[]; inspected: number }> {
    const now = nowUnix ?? Math.floor(this.now() / 1000);
    const items = await this.docker.listBrowserSandboxes();
    const reaped: string[] = [];
    for (const item of items) {
      if (
        !shouldReapBrowserSandbox({
          labels: item.labels,
          leaseUntilUnix: item.leaseUntilUnix,
          nowUnix: now,
        })
      ) {
        continue;
      }
      await this.docker.rmForce(item.name, 30_000).catch(() => {});
      reaped.push(item.name);
      // Drop local session if we were tracking this name
      for (const [pid, rec] of this.sessions) {
        if (rec.containerName === item.name) this.sessions.delete(pid);
      }
    }
    return { reaped, inspected: items.length };
  }

  /** How many parent tasks currently have a live session record (tests / observability). */
  activeSessionCount(): number {
    return this.sessions.size;
  }
}

/** Process-default runtime used by module-level helpers and browser tool. */
const defaultRuntime = new BrowserSandboxRuntime();

/** Default process-local runtime (for lifecycle wiring / tests). */
export function getDefaultBrowserSandboxRuntime(): BrowserSandboxRuntime {
  return defaultRuntime;
}

/** Spec #334: register parent task as held for lease heartbeat. */
export function holdBrowserSandboxTask(parentTaskId: string): void {
  defaultRuntime.holdParentTask(parentTaskId);
}

/** Spec #334: clear hold registration for a parent task. */
export function releaseBrowserSandboxTask(parentTaskId: string): void {
  defaultRuntime.releaseParentTask(parentTaskId);
}

export type BrowserSandboxBackgroundHandles = {
  stop: () => void;
};

/**
 * Spec #334: startup janitor pass + periodic janitor + heartbeat renewals.
 * Call once from Node4 main after boot.
 */
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

  // Startup sweep without waiting for first interval.
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

/** @deprecated Prefer BrowserSandboxRuntime.ensure — kept for call-site compatibility. */
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

/** Runtime dispose for a parent task (alias: stopBrowserSandbox). */
export async function disposeBrowserSandbox(parentTaskId: string): Promise<void> {
  return defaultRuntime.dispose(parentTaskId);
}

/** Best-effort dispose of all sandboxes owned by this process instance (Spec #333). */
export async function disposeAllBrowserSandboxes(): Promise<void> {
  return defaultRuntime.disposeAll();
}

/** @deprecated Prefer disposeBrowserSandbox / BrowserSandboxRuntime.dispose */
export async function stopBrowserSandbox(taskId: string): Promise<void> {
  return defaultRuntime.dispose(taskId);
}

/**
 * Run agent-browser: sandbox first (default), host fallback when sandbox disabled or fails to start.
 */
export async function runBrowserCommand(
  runtime: ToolRuntime,
  args: string[],
  timeoutMs = 120_000,
): Promise<SandboxExecResult & { text: string }> {
  // Spec #332: parent work unit key (sub-agents share parent sandbox + session).
  const parentKey = resolveBrowserSandboxParentTaskId(runtime.task);
  const preferSandbox = isBrowserSandboxPreferred();

  if (preferSandbox) {
    // Spec #330: misconfigured image fails closed — do not host-fallback or Strix.
    try {
      resolveBrowserSandboxImage();
    } catch (e) {
      if (e instanceof BrowserSandboxImageError) {
        return {
          exitCode: null,
          stdout: "",
          stderr: "",
          unavailable: true,
          error: e.message,
          text: e.message,
          via: "sandbox",
        };
      }
      throw e;
    }
    try {
      const result = await defaultRuntime.exec(parentKey, ["agent-browser", ...args], timeoutMs);
      const text = `${result.stdout || ""}${result.stderr ? `\n${result.stderr}` : ""}`.trim();
      if (result.unavailable) {
        throw new Error(result.error || "docker unavailable");
      }
      return { ...result, text, via: "sandbox" };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Fall through to host only if sandbox cannot start (image was configured)
      const host = await runAgentBrowser(args, {
        taskId: parentKey,
        taskDir: runtime.taskDir,
        timeoutMs,
        env: { AGENT_BROWSER_SESSION: agentBrowserSessionName(parentKey) },
      });
      const text = `${host.stdout || ""}${host.stderr ? `\n${host.stderr}` : ""}${host.error ? `\n${host.error}` : ""}`.trim();
      return {
        exitCode: host.exitCode,
        stdout: host.stdout,
        stderr: host.stderr,
        unavailable: host.unavailable,
        error: host.error
          ? `sandbox failed (${msg.slice(0, 200)}); host fallback: ${host.error}`
          : `sandbox failed (${msg.slice(0, 200)}); used host agent-browser`,
        text,
        via: "host",
      };
    }
  }

  const host = await runAgentBrowser(args, {
    taskId: parentKey,
    taskDir: runtime.taskDir,
    timeoutMs,
    env: { AGENT_BROWSER_SESSION: agentBrowserSessionName(parentKey) },
  });
  const text = `${host.stdout || ""}${host.stderr ? `\n${host.stderr}` : ""}`.trim();
  return {
    exitCode: host.exitCode,
    stdout: host.stdout,
    stderr: host.stderr,
    unavailable: host.unavailable,
    error: host.error,
    text,
    via: "host",
  };
}

/** Rewrite localhost targets so container can reach host services. */
export function rewriteUrlForSandbox(value: string): string {
  if (!/^https?:\/\//i.test(value)) return value;
  try {
    const url = new URL(value);
    if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname)) return value;
    url.hostname = "host.docker.internal";
    return url.toString();
  } catch {
    return value;
  }
}
