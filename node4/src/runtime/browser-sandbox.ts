/**
 * Browser sandbox barrel — stable import path for Node4.
 *
 * Modules:
 * - browser-sandbox-image.ts   — image pin + Session seat keys (#426/#427)
 * - browser-sandbox-docker.ts  — injectable Docker port
 * - browser-sandbox-runtime.ts — ensure/reuse/dispose, lease, janitor
 * - browser-sandbox-command.ts — tool-facing runBrowserCommand
 * - browser-sandbox-labels.ts  — pure labels + reap rules
 */

export type {
  BrowserSandboxDockerPort,
  BrowserSandboxListItem,
  SandboxExecResult,
} from "./browser-sandbox-docker.js";
export { createProcessDockerPort } from "./browser-sandbox-docker.js";

export type { BrowserSandboxSeat } from "./browser-sandbox-image.js";
export {
  agentBrowserSessionName,
  BrowserSandboxImageError,
  BrowserSandboxSeatError,
  containerNameForParentTask,
  containerNameForSeat,
  formatBrowserSandboxSeatKey,
  isBrowserSandboxPreferred,
  readExplicitSandboxImageEnv,
  resolveBrowserSandboxImage,
  resolveBrowserSandboxParentTaskId,
  resolveBrowserSandboxSeat,
  seatKeySlug,
} from "./browser-sandbox-image.js";

export type {
  BrowserSandboxBackgroundHandles,
  BrowserSandboxRuntimeOptions,
  BrowserSandboxSession,
} from "./browser-sandbox-runtime.js";
export {
  BROWSER_SANDBOX_INSTANCE_ID,
  BrowserSandboxRuntime,
  disposeAllBrowserSandboxes,
  disposeBrowserSandbox,
  disposeBrowserSandboxForCase,
  disposeBrowserSandboxForSeat,
  getDefaultBrowserSandboxRuntime,
  holdBrowserSandboxSeat,
  holdBrowserSandboxTask,
  releaseBrowserSandboxSeat,
  releaseBrowserSandboxTask,
  startBrowserSandboxBackgroundJobs,
} from "./browser-sandbox-runtime.js";

export { rewriteUrlForSandbox, runBrowserCommand } from "./browser-sandbox-command.js";

export {
  ensureSessionWorkspace,
  resolveSessionWorkspaceDir,
} from "./session-workspace.js";
