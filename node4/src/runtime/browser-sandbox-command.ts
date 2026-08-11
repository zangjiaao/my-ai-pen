/**
 * Tool-facing browser command runner (sandbox preferred + host fallback).
 * Spec #427: seat-keyed sticky sandbox (conversationId + expertId).
 */
import type { ToolRuntime } from "../types.js";
import { runAgentBrowser } from "./agent-browser-cli.js";
import {
  agentBrowserSessionName,
  BrowserSandboxImageError,
  BrowserSandboxSeatError,
  isBrowserSandboxPreferred,
  resolveBrowserSandboxImage,
  resolveBrowserSandboxSeat,
} from "./browser-sandbox-image.js";
import { getDefaultBrowserSandboxRuntime } from "./browser-sandbox-runtime.js";
import type { SandboxExecResult } from "./browser-sandbox-docker.js";

/**
 * Run agent-browser: sandbox first (default), host fallback when sandbox disabled or fails to start.
 */
export async function runBrowserCommand(
  runtime: ToolRuntime,
  args: string[],
  timeoutMs = 120_000,
): Promise<SandboxExecResult & { text: string }> {
  let seatKey: string;
  try {
    seatKey = resolveBrowserSandboxSeat(runtime.task).seatKey;
  } catch (e) {
    if (e instanceof BrowserSandboxSeatError) {
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

  const preferSandbox = isBrowserSandboxPreferred();
  const sandboxRuntime = getDefaultBrowserSandboxRuntime();

  if (preferSandbox) {
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
      const result = await sandboxRuntime.exec(seatKey, ["agent-browser", ...args], timeoutMs);
      const text = `${result.stdout || ""}${result.stderr ? `\n${result.stderr}` : ""}`.trim();
      if (result.unavailable) {
        throw new Error(result.error || "docker unavailable");
      }
      return { ...result, text, via: "sandbox" };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const host = await runAgentBrowser(args, {
        taskId: seatKey,
        taskDir: runtime.taskDir,
        timeoutMs,
        env: { AGENT_BROWSER_SESSION: agentBrowserSessionName(seatKey) },
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
    taskId: seatKey,
    taskDir: runtime.taskDir,
    timeoutMs,
    env: { AGENT_BROWSER_SESSION: agentBrowserSessionName(seatKey) },
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
