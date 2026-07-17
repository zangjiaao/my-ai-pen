/**
 * S4: run shell commands inside unified pen-sandbox (scanners + browser image).
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

const STDOUT_CAP = 250_000;
const STDERR_CAP = 100_000;

export type PenToolsShellResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
};

function dockerBin(): string {
  return process.env.NODE4_DOCKER_BIN?.trim() || process.env.NODE2_DOCKER_BIN?.trim() || "docker";
}

/** Unified sandbox image (pen-sandbox preferred). */
export function resolvePenToolsImage(): string {
  return resolvePentestSandboxImage({ allowStrixFallback: false });
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
 * docker run --rm --network host -v taskDir:/workspace pen-sandbox bash -lc <cmd>
 */
export function runShellInPenTools(
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
    });
  }

  const image = resolvePenToolsImage();
  const name = `node4-shell-${randomBytes(4).toString("hex")}`;
  const docker = dockerBin();
  const tplHost =
    process.env.PEN_TOOLS_NUCLEI_TEMPLATES?.trim() ||
    resolve(process.env.HOME || "/tmp", ".cache/pen-tools/nuclei-templates");

  // Override image ENTRYPOINT (legacy pentest-sandbox used `bash -c` as entrypoint).
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
      resolvePromise(value);
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
      });
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      settle({
        exitCode: 127,
        stdout,
        stderr: err.message,
        timedOut,
        aborted,
      });
    });
  });
}
