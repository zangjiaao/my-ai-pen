/**
 * Browser sandbox barrel — stable import path for Node4.
 *
 * Modules:
 * - browser-sandbox-image.ts   — image pin + parent-task keys (#330/#332)
 * - browser-sandbox-docker.ts  — injectable Docker port
 * - browser-sandbox-runtime.ts — ensure/reuse/dispose, lease, janitor (#331–#334)
 * - browser-sandbox-command.ts — tool-facing runBrowserCommand
 * - browser-sandbox-labels.ts  — pure labels + reap rules
 */

export type {
  BrowserSandboxDockerPort,
  BrowserSandboxListItem,
  SandboxExecResult,
} from "./browser-sandbox-docker.js";
export { createProcessDockerPort } from "./browser-sandbox-docker.js";

export {
  agentBrowserSessionName,
  BrowserSandboxImageError,
  containerNameForParentTask,
  isBrowserSandboxPreferred,
  readExplicitSandboxImageEnv,
  resolveBrowserSandboxImage,
  resolveBrowserSandboxParentTaskId,
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
  ensureBrowserSandbox,
  execInBrowserSandbox,
  getDefaultBrowserSandboxRuntime,
  holdBrowserSandboxTask,
  releaseBrowserSandboxTask,
  startBrowserSandboxBackgroundJobs,
  stopBrowserSandbox,
} from "./browser-sandbox-runtime.js";

export { rewriteUrlForSandbox, runBrowserCommand } from "./browser-sandbox-command.js";
