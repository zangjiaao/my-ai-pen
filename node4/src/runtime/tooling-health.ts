/**
 * L2 pen-sandbox / pen-tools tooling health probe (observability only).
 * Never gates task start, tool use, booking, or settlement.
 *
 * See docs/specs/pen-tools-sandbox.md § tooling health.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { buildShellEnv, isPenToolsPathEnabled, resolvePenToolsBinDir } from "./pen-tools-path.js";
import {
  dockerImageExists,
  isShellInPenToolsEnabled,
  resolvePenToolsImage,
} from "./pen-tools-shell.js";
import type { PlatformSink, TaskEnvelope } from "../types.js";

/** Key scanners expected for pentest shell path (cheap host/container checks). */
export const TOOLING_HEALTH_KEY_TOOLS = [
  "nuclei",
  "nmap",
  "sqlmap",
  "ffuf",
  "redis-cli",
] as const;

export type ToolAvailability = {
  name: string;
  present: boolean;
  /** host | container | both | none */
  via: "host" | "container" | "both" | "none";
  path?: string | null;
  detail?: string;
};

export type ToolingHealthReport = {
  ts: string;
  /** Always false — health is never a product gate. */
  gating: false;
  sandbox: {
    image: string;
    imagePresent: boolean;
    shellInContainer: boolean;
    /** How shell will run on this node. */
    shellMode: "container" | "host";
  };
  hostShim: {
    penToolsPathEnabled: boolean;
    binDir: string | null;
  };
  tools: ToolAvailability[];
  /** True when nuclei is missing and neither container nor host shim provides it. */
  degraded: boolean;
  summary: string;
};

export type ToolingHealthDeps = {
  resolveImage: () => string;
  imageExists: (image: string) => boolean;
  isShellInContainer: () => boolean;
  isPathEnabled: () => boolean;
  resolveBinDir: () => string | null;
  /** Host-side presence (PATH / shim). */
  checkHostTool: (name: string, env: NodeJS.ProcessEnv) => { present: boolean; path?: string | null; detail?: string };
  /**
   * Optional batch container check. Return map of tool name → present.
   * May return empty when docker unavailable — probe treats as unknown/absent.
   */
  checkContainerTools: (image: string, names: readonly string[]) => Record<string, boolean>;
  now?: () => string;
};

const HOST_CHECK_TIMEOUT_MS = 2_000;
const CONTAINER_CHECK_TIMEOUT_MS = 20_000;

function dockerBin(): string {
  return process.env.NODE4_DOCKER_BIN?.trim() || process.env.NODE2_DOCKER_BIN?.trim() || "docker";
}

export function defaultCheckHostTool(
  name: string,
  env: NodeJS.ProcessEnv,
): { present: boolean; path?: string | null; detail?: string } {
  try {
    const r = spawnSync("bash", ["-lc", `command -v ${shellQuote(name)}`], {
      encoding: "utf8",
      env,
      timeout: HOST_CHECK_TIMEOUT_MS,
    });
    if (r.status === 0) {
      const path = String(r.stdout || "").trim().split("\n")[0] || null;
      return { present: Boolean(path), path, detail: path ? "command -v" : undefined };
    }
  } catch {
    /* fall through */
  }
  return { present: false, path: null };
}

function shellQuote(s: string): string {
  if (/^[A-Za-z0-9._+-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * One docker run: `command -v` for each key tool. Cheap when image is warm; times out if hung.
 */
export function defaultCheckContainerTools(
  image: string,
  names: readonly string[],
): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const n of names) out[n] = false;
  if (!image.trim()) return out;
  try {
    const script = names.map((n) => `if command -v ${shellQuote(n)} >/dev/null 2>&1; then echo OK:${n}; else echo MISS:${n}; fi`).join("; ");
    const r = spawnSync(
      dockerBin(),
      ["run", "--rm", "--entrypoint", "bash", image, "-lc", script],
      { encoding: "utf8", timeout: CONTAINER_CHECK_TIMEOUT_MS },
    );
    const text = `${r.stdout || ""}\n${r.stderr || ""}`;
    for (const n of names) {
      if (new RegExp(`OK:${n}\\b`).test(text)) out[n] = true;
    }
  } catch {
    /* leave all false */
  }
  return out;
}

export function createDefaultToolingHealthDeps(): ToolingHealthDeps {
  return {
    resolveImage: () => resolvePenToolsImage(),
    imageExists: (image) => dockerImageExists(image),
    isShellInContainer: () => isShellInPenToolsEnabled(),
    isPathEnabled: () => isPenToolsPathEnabled(),
    resolveBinDir: () => resolvePenToolsBinDir(),
    checkHostTool: defaultCheckHostTool,
    checkContainerTools: defaultCheckContainerTools,
    now: () => new Date().toISOString(),
  };
}

/**
 * Pure probe: resolves sandbox/PATH state and key tool availability.
 * Never throws for missing tools/images — always returns a structured report.
 */
export function probeToolingHealth(opts?: {
  deps?: Partial<ToolingHealthDeps>;
  tools?: readonly string[];
  /** When false, skip docker run tool probe (still reports image/shell/shim). Default true. */
  checkContainerBinaries?: boolean;
}): ToolingHealthReport {
  const deps: ToolingHealthDeps = { ...createDefaultToolingHealthDeps(), ...opts?.deps };
  const tools = opts?.tools ?? TOOLING_HEALTH_KEY_TOOLS;
  const checkContainerBinaries = opts?.checkContainerBinaries !== false;

  let image = "unresolved";
  try {
    image = deps.resolveImage() || "unresolved";
  } catch {
    image = "unresolved";
  }
  let imagePresent = false;
  try {
    imagePresent = image !== "unresolved" && deps.imageExists(image);
  } catch {
    imagePresent = false;
  }

  let shellInContainer = false;
  try {
    shellInContainer = deps.isShellInContainer();
  } catch {
    shellInContainer = false;
  }

  let pathEnabled = false;
  let binDir: string | null = null;
  try {
    pathEnabled = deps.isPathEnabled();
    binDir = pathEnabled ? deps.resolveBinDir() : null;
  } catch {
    pathEnabled = false;
    binDir = null;
  }

  const hostEnv = buildShellEnv(process.env);
  const hostHits: Record<string, { present: boolean; path?: string | null; detail?: string }> = {};
  for (const name of tools) {
    // Shim file is a strong host signal even if not yet on PATH in this process.
    if (binDir && existsSync(resolve(binDir, name))) {
      hostHits[name] = { present: true, path: resolve(binDir, name), detail: "pen-tools shim" };
      continue;
    }
    try {
      hostHits[name] = deps.checkHostTool(name, hostEnv);
    } catch {
      hostHits[name] = { present: false, path: null, detail: "host check error" };
    }
  }

  let containerHits: Record<string, boolean> = {};
  if (checkContainerBinaries && shellInContainer && imagePresent) {
    try {
      containerHits = deps.checkContainerTools(image, tools);
    } catch {
      containerHits = {};
    }
  }

  const toolRows: ToolAvailability[] = tools.map((name) => {
    const host = hostHits[name]?.present === true;
    const container = containerHits[name] === true;
    let via: ToolAvailability["via"] = "none";
    if (host && container) via = "both";
    else if (host) via = "host";
    else if (container) via = "container";
    // When shell runs in container and image is present, scanners live in the image even if
    // we skipped the docker which-check (or it timed out). Mark container-assumed only when
    // check was skipped and host missing — keep present false if we checked and missed.
    if (
      !host &&
      !container &&
      shellInContainer &&
      imagePresent &&
      !checkContainerBinaries
    ) {
      return {
        name,
        present: true,
        via: "container",
        path: null,
        detail: "assumed in sandbox image (binary check skipped)",
      };
    }
    return {
      name,
      present: host || container,
      via,
      path: hostHits[name]?.path ?? null,
      detail: hostHits[name]?.detail,
    };
  });

  const nuclei = toolRows.find((t) => t.name === "nuclei");
  const nucleiOk = nuclei?.present === true;
  // Degraded when nuclei is not available on the path the shell will use.
  const degraded = !nucleiOk;

  const shellMode: "container" | "host" = shellInContainer ? "container" : "host";
  const parts = [
    `image=${image}${imagePresent ? "" : " (missing)"}`,
    `shell=${shellMode}`,
    binDir ? `host_bin=${binDir}` : pathEnabled ? "host_bin=unresolved" : "host_shim=off",
    nucleiOk ? "nuclei=ok" : "nuclei=missing",
  ];
  if (degraded) parts.push("degraded=true");

  return {
    ts: deps.now?.() ?? new Date().toISOString(),
    gating: false,
    sandbox: {
      image,
      imagePresent,
      shellInContainer,
      shellMode,
    },
    hostShim: {
      penToolsPathEnabled: pathEnabled,
      binDir,
    },
    tools: toolRows,
    degraded,
    summary: `tooling-health: ${parts.join(" ")} (non-gating)`,
  };
}

export function formatToolingHealthReport(report: ToolingHealthReport): string {
  const lines: string[] = [];
  lines.push("Node4 pen-sandbox tooling health (observability only — never gates tasks)");
  lines.push(`  time:              ${report.ts}`);
  lines.push(`  gating:            ${report.gating} (always false)`);
  lines.push(`  sandbox.image:     ${report.sandbox.image}`);
  lines.push(`  sandbox.present:   ${report.sandbox.imagePresent}`);
  lines.push(`  shell.mode:        ${report.sandbox.shellMode}`);
  lines.push(`  shell.inContainer: ${report.sandbox.shellInContainer}`);
  lines.push(`  host.shimEnabled:  ${report.hostShim.penToolsPathEnabled}`);
  lines.push(`  host.binDir:       ${report.hostShim.binDir ?? "(none)"}`);
  lines.push("  tools:");
  for (const t of report.tools) {
    const flag = t.present ? "ok" : "MISSING";
    const path = t.path ? ` path=${t.path}` : "";
    const detail = t.detail ? ` (${t.detail})` : "";
    lines.push(`    - ${t.name}: ${flag} via=${t.via}${path}${detail}`);
  }
  lines.push(`  degraded:          ${report.degraded}`);
  lines.push(`  summary:           ${report.summary}`);
  return lines.join("\n");
}

/** Execution-oriented packs with shell — skip chat-only / default seat. */
export function shouldEmitToolingHealth(opts: {
  chatOnly: boolean;
  toolNames: readonly string[];
}): boolean {
  if (opts.chatOnly) return false;
  return opts.toolNames.includes("shell");
}

/**
 * Best-effort: write taskDir/tooling-health.json + status_update.
 * Never throws; never blocks product flow.
 */
export async function recordToolingHealthAtTaskStart(opts: {
  taskDir: string;
  platform: PlatformSink;
  task: TaskEnvelope;
  probe?: () => ToolingHealthReport;
}): Promise<ToolingHealthReport | null> {
  try {
    const report = opts.probe ? opts.probe() : probeToolingHealth();
    const path = join(opts.taskDir, "tooling-health.json");
    try {
      await writeFile(path, JSON.stringify(report, null, 2), "utf8");
    } catch {
      // disk failure must not abort the task
    }
    try {
      await opts.platform.send({
        type: "status_update",
        conversation_id: opts.task.conversationId,
        task_id: opts.task.taskId,
        message: report.summary,
        agent_phase: "tooling_health",
        status: "running",
        tooling_health: {
          gating: false,
          degraded: report.degraded,
          image: report.sandbox.image,
          imagePresent: report.sandbox.imagePresent,
          shellMode: report.sandbox.shellMode,
          nuclei: report.tools.find((t) => t.name === "nuclei")?.present ?? false,
        },
      } as any);
    } catch {
      // platform send failure must not abort
    }
    return report;
  } catch {
    return null;
  }
}
