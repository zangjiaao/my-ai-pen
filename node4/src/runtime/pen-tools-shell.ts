/**
 * Shell in pen-sandbox (Spec #428): prefer sticky Session box via docker exec.
 * Fallback: short-lived docker run --rm when seat/workspace unavailable.
 *
 * Env:
 * - NODE4_SHELL_IN_PEN_TOOLS=auto|1|0 (default auto when image present)
 * - PEN_SANDBOX_IMAGE / PEN_TOOLS_IMAGE
 * - NODE4_DOCKER_BIN
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import {
  dockerImageExists,
  pentestSandboxImagePresent,
  resolvePentestSandboxImage,
} from "./pentest-sandbox-image.js";
import type { BrowserSandboxSeat } from "./browser-sandbox-image.js";
import { getDefaultBrowserSandboxRuntime } from "./browser-sandbox-runtime.js";
import { ensureSessionWorkspace } from "./session-workspace.js";

const STDOUT_CAP = 250_000;
const STDERR_CAP = 100_000;

export type PenToolsShellResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  /** How the command ran (for tests / observability). */
  via?: "sticky-exec" | "sticky-failed" | "ephemeral-run" | "host";
};

export type PenToolsShellOptions = {
  /** Participant Session seat — when set with workspaceHostPath, uses sticky exec. */
  seat?: BrowserSandboxSeat | null;
  /** Host Session workspace mounted at /workspace. */
  workspaceHostPath?: string | null;
};

function dockerBin(): string {
  return process.env.NODE4_DOCKER_BIN?.trim() || process.env.NODE2_DOCKER_BIN?.trim() || "docker";
}

/** Unified sandbox image (pen-sandbox preferred). */
export function resolvePenToolsImage(): string {
  return resolvePentestSandboxImage();
}

export { dockerImageExists };

/**
 * Default on when image exists; set NODE4_SHELL_IN_PEN_TOOLS=0 to force host.
 */
export function isShellInPenToolsEnabled(): boolean {
  const raw = (process.env.NODE4_SHELL_IN_PEN_TOOLS ?? "auto").trim().toLowerCase();
  if (raw === "0" || raw === "false" || raw === "off" || raw === "host" || raw === "no") return false;
  if (raw === "1" || raw === "true" || raw === "on" || raw === "yes" || raw === "container") return true;
  return pentestSandboxImagePresent();
}

/**
 * Run shell in pen-sandbox.
 * With seat+workspace: **sticky only** (fail-closed — never silent ephemeral twin box).
 * Without seat: ephemeral `docker run --rm`.
 */
export async function runShellInPenTools(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
  opts?: PenToolsShellOptions,
): Promise<PenToolsShellResult> {
  if (signal?.aborted) {
    return {
      exitCode: null,
      stdout: "",
      stderr: "aborted before start",
      timedOut: false,
      aborted: true,
    };
  }

  const seat = opts?.seat;
  const workspaceHostPath = opts?.workspaceHostPath?.trim();
  if (seat && workspaceHostPath) {
    try {
      const absWs = await ensureSessionWorkspace(workspaceHostPath);
      const rt = getDefaultBrowserSandboxRuntime();
      // Single bash -lc (docker port runs argv as-is under docker exec).
      const result = await rt.exec(
        seat,
        ["bash", "-lc", `cd /workspace && ${command}`],
        timeoutMs,
        { workspaceHostPath: absWs },
      );
      if (result.unavailable) {
        const msg =
          result.error ||
          "Sticky pen-sandbox unavailable (docker). Not falling back to ephemeral shell.";
        return {
          exitCode: null,
          stdout: "",
          stderr: msg,
          timedOut: false,
          aborted: false,
          via: "sticky-failed",
        };
      }
      return {
        exitCode: result.exitCode,
        stdout: (result.stdout || "").slice(-STDOUT_CAP),
        stderr: (result.stderr || "").slice(-STDERR_CAP),
        timedOut: false,
        aborted: false,
        via: "sticky-exec",
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        exitCode: 1,
        stdout: "",
        stderr: `Sticky pen-sandbox shell failed: ${msg}`,
        timedOut: false,
        aborted: false,
        via: "sticky-failed",
      };
    }
  }

  return runShellEphemeralPenTools(command, cwd, timeoutMs, signal);
}

/**
 * Legacy short-lived container (no seat sticky). Mounts cwd at /workspace.
 */
export function runShellEphemeralPenTools(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<PenToolsShellResult> {
  const absCwd = resolve(cwd);
  if (!existsSync(absCwd)) {
    return Promise.resolve({
      exitCode: 1,
      stdout: "",
      stderr: `task dir missing: ${absCwd}`,
      timedOut: false,
      aborted: false,
      via: "ephemeral-run",
    });
  }

  const image = resolvePenToolsImage();
  const name = `node4-shell-${randomBytes(4).toString("hex")}`;
  const docker = dockerBin();
  const tplHost =
    process.env.PEN_TOOLS_NUCLEI_TEMPLATES?.trim() ||
    resolve(process.env.HOME || "/tmp", ".cache/pen-tools/nuclei-templates");

  const args = [
    "run",
    "--rm",
    "--name",
    name,
    "--network",
    process.env.PEN_TOOLS_NETWORK?.trim() || "host",
    "--entrypoint",
    "bash",
    "-v",
    `${absCwd}:/workspace:rw`,
    "-w",
    "/workspace",
    "-e",
    "HOME=/workspace",
  ];
  if (existsSync(tplHost)) {
    args.push("-v", `${tplHost}:/root/nuclei-templates:ro`);
  }
  args.push(image, "-lc", command);

  return new Promise((resolvePromise) => {
    let settled = false;
    const settle = (value: PenToolsShellResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise({ ...value, via: value.via || "ephemeral-run" });
    };

    const child = spawn(docker, args, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;

    const killContainer = () => {
      try {
        spawn(docker, ["kill", name], { stdio: "ignore" });
      } catch {
        /* ignore */
      }
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killContainer();
    }, timeoutMs);

    const onAbort = () => {
      aborted = true;
      killContainer();
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };

    child.stdout?.on("data", (d) => {
      stdout += String(d);
      if (stdout.length > STDOUT_CAP) stdout = stdout.slice(-STDOUT_CAP);
    });
    child.stderr?.on("data", (d) => {
      stderr += String(d);
      if (stderr.length > STDERR_CAP) stderr = stderr.slice(-STDERR_CAP);
    });
    child.on("close", (code) => {
      settle({
        exitCode: code,
        stdout,
        stderr,
        timedOut,
        aborted,
        via: "ephemeral-run",
      });
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      settle({
        exitCode: 127,
        stdout,
        stderr: err.message,
        timedOut,
        aborted,
        via: "ephemeral-run",
      });
    });
  });
}
