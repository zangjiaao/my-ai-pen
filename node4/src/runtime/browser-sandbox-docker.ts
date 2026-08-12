/**
 * Injectable Docker port for browser sandboxes (Spec #331 / #334).
 * Process CLI implementation lives here so runtime policy stays pure of spawn details.
 */
import { spawn } from "node:child_process";
import {
  BROWSER_SANDBOX_COMPONENT,
  BROWSER_SANDBOX_LABEL,
  BROWSER_SANDBOX_LEASE_PATH,
  parseLeaseUntilUnix,
} from "./browser-sandbox-labels.js";
import { PEN_SANDBOX_HOME_ENV } from "./browser-sandbox-image.js";

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
  /** Resolved lease unix seconds when trusted. */
  leaseUntilUnix: number | null;
  /**
   * false when the live lease file could not be read (exec failure).
   * Janitor must not fall back to a stale create-time label in that case.
   */
  leaseTrusted: boolean;
};

/** Injectable Docker operations used by BrowserSandboxRuntime. */
export type BrowserSandboxDockerPort = {
  rmForce(name: string, timeoutMs?: number): Promise<SandboxExecResult>;
  runDetached(
    opts: {
      name: string;
      image: string;
      env: string[];
      labels?: Record<string, string>;
      /** Host binds e.g. `/host/path:/workspace:rw` */
      volumes?: string[];
      /** Docker network mode (default host for scanners + browser). */
      network?: string;
      entrypoint: string[];
      cmd: string[];
    },
    timeoutMs?: number,
  ): Promise<SandboxExecResult>;
  exec(name: string, argv: string[], timeoutMs?: number): Promise<SandboxExecResult>;
  listBrowserSandboxes(): Promise<BrowserSandboxListItem[]>;
  writeLease(name: string, leaseUntilUnix: number, timeoutMs?: number): Promise<SandboxExecResult>;
  /** Spec #430: stop without rm. */
  stop(name: string, timeoutMs?: number): Promise<SandboxExecResult>;
  /** Spec #430: start a stopped container. */
  start(name: string, timeoutMs?: number): Promise<SandboxExecResult>;
  /**
   * Container existence / run state.
   * missing | running | stopped | unknown
   */
  inspectState(name: string, timeoutMs?: number): Promise<"missing" | "running" | "stopped" | "unknown">;
  /**
   * Container start time in epoch ms (for idle stop after Node restart when
   * process-local lastTrafficMs is empty). null when unknown / missing.
   */
  inspectStartedAtMs?(name: string, timeoutMs?: number): Promise<number | null>;
};

export function dockerBin(): string {
  return process.env.NODE4_DOCKER_BIN?.trim() || process.env.NODE2_DOCKER_BIN?.trim() || "docker";
}

export function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function runProcess(
  command: string,
  argv: string[],
  timeoutMs: number,
): Promise<SandboxExecResult> {
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
      const network = opts.network?.trim() || process.env.PEN_TOOLS_NETWORK?.trim() || "host";
      const argv: string[] = [
        "run",
        "-d",
        "--name",
        opts.name,
        "--network",
        network,
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
      for (const vol of opts.volumes || []) {
        if (vol) argv.push("-v", vol);
      }
      if (opts.entrypoint.length) {
        argv.push("--entrypoint", opts.entrypoint[0]);
      }
      argv.push(opts.image, ...opts.cmd);
      return runProcess(bin, argv, timeoutMs);
    },
    async exec(name, argv, timeoutMs = 120_000) {
      // Run argv as-is (no outer bash -lc). Callers pass ["bash","-lc",script] when shell is needed.
      // Force HOME off /workspace on every exec so legacy sticky boxes still get AF_UNIX.
      if (!argv.length) {
        return { exitCode: 1, stdout: "", stderr: "exec argv empty" };
      }
      const envArgs: string[] = [];
      for (const pair of PEN_SANDBOX_HOME_ENV) {
        envArgs.push("-e", pair);
      }
      return runProcess(bin, ["exec", ...envArgs, name, ...argv], timeoutMs);
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

      // Parallel inspect + lease reads (bounded by orphan count on one daemon).
      const rows = await Promise.all(
        ids.map(async (id): Promise<BrowserSandboxListItem | null> => {
          const inspected = await runProcess(
            bin,
            ["inspect", "--format", "{{.Name}}\t{{json .Config.Labels}}", id],
            15_000,
          );
          if (inspected.exitCode !== 0) return null;
          const line = inspected.stdout.trim();
          const tab = line.indexOf("\t");
          const rawName = tab >= 0 ? line.slice(0, tab) : line;
          const name = rawName.replace(/^\//, "");
          let labels: Record<string, string> = {};
          try {
            const json = tab >= 0 ? line.slice(tab + 1) : "{}";
            const parsed = JSON.parse(json || "{}") as Record<string, string | null>;
            for (const [k, v] of Object.entries(parsed || {})) {
              if (v != null) labels[k] = String(v);
            }
          } catch {
            labels = {};
          }

          // exit 0 = file present; 2 = missing (use label); other = untrusted (do not reap).
          const leaseFile = await runProcess(
            bin,
            [
              "exec",
              name,
              "bash",
              "-lc",
              `if [ -f ${BROWSER_SANDBOX_LEASE_PATH} ]; then cat ${BROWSER_SANDBOX_LEASE_PATH}; exit 0; else exit 2; fi`,
            ],
            10_000,
          );
          const fromLabel = parseLeaseUntilUnix(labels[BROWSER_SANDBOX_LABEL.leaseUntil]);
          if (leaseFile.unavailable || leaseFile.exitCode === null) {
            return { name, labels, leaseUntilUnix: null, leaseTrusted: false };
          }
          if (leaseFile.exitCode === 0) {
            const fromFile = parseLeaseUntilUnix(leaseFile.stdout);
            return {
              name,
              labels,
              leaseUntilUnix: fromFile,
              leaseTrusted: fromFile != null,
            };
          }
          if (leaseFile.exitCode === 2) {
            // No live file yet (or disposed mid-read): create-time label is authoritative.
            return { name, labels, leaseUntilUnix: fromLabel, leaseTrusted: true };
          }
          // Unexpected exec failure — never fall back to stale label for reaping.
          return { name, labels, leaseUntilUnix: null, leaseTrusted: false };
        }),
      );
      return rows.filter((r): r is BrowserSandboxListItem => r != null);
    },
    async stop(name, timeoutMs = 60_000) {
      return runProcess(bin, ["stop", name], timeoutMs);
    },
    async start(name, timeoutMs = 60_000) {
      return runProcess(bin, ["start", name], timeoutMs);
    },
    async inspectState(name, timeoutMs = 15_000) {
      const r = await runProcess(
        bin,
        ["inspect", "--format", "{{.State.Running}}", name],
        timeoutMs,
      );
      if (r.unavailable) return "unknown";
      if (r.exitCode !== 0) return "missing";
      const raw = r.stdout.trim().toLowerCase();
      if (raw === "true") return "running";
      if (raw === "false") return "stopped";
      return "unknown";
    },
    async inspectStartedAtMs(name, timeoutMs = 15_000) {
      const r = await runProcess(
        bin,
        ["inspect", "--format", "{{.State.StartedAt}}", name],
        timeoutMs,
      );
      if (r.unavailable || r.exitCode !== 0) return null;
      const raw = r.stdout.trim();
      if (!raw || raw.startsWith("0001-01-01")) return null;
      const ms = Date.parse(raw);
      return Number.isFinite(ms) ? ms : null;
    },
    async writeLease(name, leaseUntilUnix, timeoutMs = 15_000) {
      const body = String(Math.floor(leaseUntilUnix));
      const cmd = `mkdir -p /run/myaipen && printf '%s' ${shellQuote(body)} > ${BROWSER_SANDBOX_LEASE_PATH}`;
      return runProcess(bin, ["exec", name, "bash", "-lc", cmd], timeoutMs);
    },
  };
}
