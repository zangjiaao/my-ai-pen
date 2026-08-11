/**
 * Browser sandbox image resolution + parent-task identity helpers (Spec #330 / #332).
 */

/** Shared explicit env pins for pen-sandbox family (browser + shell). */
export function readExplicitSandboxImageEnv(opts?: {
  /** Browser path: NODE4_BROWSER override wins. Shell path: unified pin first. */
  preferBrowserOverride?: boolean;
}): string {
  const browser =
    process.env.NODE4_BROWSER_SANDBOX_IMAGE?.trim() ||
    process.env.NODE2_BROWSER_SANDBOX_IMAGE?.trim() ||
    "";
  const unified =
    process.env.PEN_SANDBOX_IMAGE?.trim() || process.env.PEN_TOOLS_IMAGE?.trim() || "";
  if (opts?.preferBrowserOverride) {
    return browser || unified || "";
  }
  return unified || browser || "";
}

/** Thrown when browser sandbox image env is missing (fail closed; no Strix). */
export class BrowserSandboxImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserSandboxImageError";
  }
}

/**
 * Explicit-env-only browser sandbox image (Spec #330).
 * Order: browser override → unified pen-sandbox → shell-family pin (still explicit).
 */
export function resolveBrowserSandboxImage(): string {
  const image = readExplicitSandboxImageEnv({ preferBrowserOverride: true });
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
