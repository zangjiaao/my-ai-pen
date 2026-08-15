/**
 * Harness housekeeping — chores that must not occupy the Expert.
 *
 * Not a Participant Session. Not a chat persona. Fire-and-forget beside the
 * Expert turn. First chore: Spec #457 auto-title.
 */
import type { Node4Config } from "../config.js";
import type { PlatformSink, TaskEnvelope, ToolRuntime } from "../types.js";
import {
  createPlatformSetConversationTitleTool,
  isDefaultConversationTitle,
} from "../tools/platform.js";
import { resolveNode4Model, runNode4Agent } from "./run-node4-agent.js";

const TITLE_HOUSEKEEPING_TIMEOUT_MS = 20_000;

const TITLE_HOUSEKEEPING_SYSTEM = [
  "You are Case housekeeping, not the Expert. You do not test, recon, or chat.",
  "This turn has one job: name the Case.",
  "Call platform_set_conversation_title once with only_if_default=true and a short title",
  "(kind of work + host/port; ≤~24 Chinese chars or ~40 Latin; no quotes, no trailing period).",
  "Do not write user-visible text. Do not call any other tool.",
].join(" ");

export function taskHasStructuredTargetOrScope(task: TaskEnvelope): boolean {
  return Boolean(structuredTargetHint(task));
}

export function shouldRunTitleHousekeeping(task: TaskEnvelope): boolean {
  if (!isDefaultConversationTitle(task.conversationTitle)) return false;
  return taskHasStructuredTargetOrScope(task);
}

/** First host[:port] from structured target / scope.allow — no free-text scan. */
export function structuredTargetHint(task: TaskEnvelope): string {
  for (const raw of structuredScopeBlobs(task)) {
    const parsed = hostPortFromBlob(raw);
    if (parsed) return parsed;
  }
  return "";
}

export function composeStructuredTitle(
  task: TaskEnvelope,
  pack: { id?: string; label?: string },
): string {
  const hint = structuredTargetHint(task);
  const kind = String(pack.id || "").trim() || "case";
  const title = hint ? `${kind} · ${hint}` : kind;
  return title.slice(0, 40);
}

export function formatExpertSessionTitleHint(title: string | undefined | null): string {
  const sessionTitle = String(title ?? "").trim();
  if (isDefaultConversationTitle(sessionTitle)) {
    return [
      "### Session title",
      "Housekeeping names the Case while the title is still the default.",
      "If the user asks to rename: platform_set_conversation_title(only_if_default=false).",
    ].join("\n");
  }
  if (!sessionTitle) return "";
  return [
    "### Session title",
    `Current title: «${sessionTitle}». Do not change unless the user asks to rename (then platform_set_conversation_title with only_if_default=false).`,
  ].join("\n");
}

export function createHousekeepingSink(
  inner: PlatformSink,
  onTitle?: () => void,
): PlatformSink {
  return {
    async send(message) {
      if (String(message.type || "") !== "conversation_title_updated") return;
      onTitle?.();
      await inner.send(message);
    },
  };
}

export function buildTitleHousekeepingUserPrompt(
  task: TaskEnvelope,
  pack: { id?: string; label?: string },
): string {
  return [
    `Current title: «${String(task.conversationTitle || "新会话").trim() || "新会话"}»`,
    `Pack: ${pack.id || "?"} (${pack.label || pack.id || "?"})`,
    `Target: ${JSON.stringify(task.target || {})}`,
    `Scope: ${JSON.stringify(task.scope || {})}`,
    "User:",
    String(task.instruction || "").trim() || "(empty)",
  ].join("\n");
}

/** Kick chores in the background. Never throws to the Expert path. */
export function kickHousekeeping(opts: {
  config: Node4Config;
  platform: PlatformSink;
  task: TaskEnvelope;
  pack: { id: string; label?: string };
  signal?: AbortSignal;
}): void {
  void runHousekeeping(opts).catch(() => {});
}

export async function runHousekeeping(opts: {
  config: Node4Config;
  platform: PlatformSink;
  task: TaskEnvelope;
  pack: { id: string; label?: string };
  signal?: AbortSignal;
}): Promise<void> {
  if (opts.signal?.aborted) return;
  if (!opts.config.nodeToken) return;
  if (shouldRunTitleHousekeeping(opts.task)) {
    await runTitleHousekeeping(opts);
  }
}

async function runTitleHousekeeping(opts: {
  config: Node4Config;
  platform: PlatformSink;
  task: TaskEnvelope;
  pack: { id: string; label?: string };
  signal?: AbortSignal;
}): Promise<void> {
  let titled = false;
  const hush = createHousekeepingSink(opts.platform, () => {
    titled = true;
  });
  const runtime = housekeepingRuntime(opts.config, hush, opts.task);
  const tool = createPlatformSetConversationTitleTool(runtime);

  const fallback = async () => {
    if (titled) return;
    await tool.execute("housekeeping-title-fallback", {
      title: composeStructuredTitle(opts.task, opts.pack),
      only_if_default: true,
    });
  };

  try {
    const session = await runNode4Agent({
      systemPrompt: TITLE_HOUSEKEEPING_SYSTEM,
      tools: [tool],
      model: resolveNode4Model(opts.config),
      thinkingLevel: "off",
    });
    try {
      await Promise.race([
        session.prompt(buildTitleHousekeepingUserPrompt(opts.task, opts.pack)),
        abortOrTimeout(opts.signal, TITLE_HOUSEKEEPING_TIMEOUT_MS),
      ]);
    } finally {
      try {
        session.abort();
      } catch {
        /* ignore */
      }
      try {
        await session.dispose();
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* structured compose still runs */
  }
  await fallback();
}

function abortOrTimeout(signal: AbortSignal | undefined, ms: number): Promise<never> {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error("housekeeping timeout")), ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("housekeeping aborted"));
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function housekeepingRuntime(
  config: Node4Config,
  platform: PlatformSink,
  task: TaskEnvelope,
): ToolRuntime {
  return {
    task,
    workspaceDir: config.workspaceDir,
    taskDir: config.workspaceDir,
    platform,
    platformApi: config.nodeToken
      ? { baseUrl: config.platformHttpUrl, nodeToken: config.nodeToken }
      : undefined,
    todo: { openCount: () => 0 } as ToolRuntime["todo"],
    evidence: {
      async create() {
        return { id: "", path: "" };
      },
      async read() {
        return undefined;
      },
      async list() {
        return [];
      },
    },
    findingsDir: config.workspaceDir,
    goals: { formatForPrompt: () => "" } as ToolRuntime["goals"],
    lifecycle: {},
  };
}

function structuredScopeBlobs(task: TaskEnvelope): string[] {
  const out: string[] = [];
  const add = (raw: unknown) => {
    if (raw == null) return;
    if (typeof raw === "string") {
      const s = raw.trim();
      if (s) out.push(s);
      return;
    }
    if (typeof raw === "object") {
      const o = raw as Record<string, unknown>;
      for (const k of ["value", "url", "host", "address"]) add(o[k]);
    }
  };
  add(task.target);
  const scope = task.scope && typeof task.scope === "object" ? task.scope : {};
  const allow = (scope as { allow?: unknown }).allow;
  if (Array.isArray(allow)) {
    for (const item of allow) add(item);
  }
  return out;
}

function hostPortFromBlob(raw: string): string {
  const text = String(raw || "").trim();
  if (!text) return "";
  try {
    const u = new URL(text.includes("://") ? text : `http://${text}`);
    const host = String(u.hostname || "").trim();
    if (!host) return "";
    return u.port ? `${host}:${u.port}` : host;
  } catch {
    return "";
  }
}
