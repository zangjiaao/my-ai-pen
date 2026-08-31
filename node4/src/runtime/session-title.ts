/**
 * Case session-title Task hint + harness auto-title write (Spec #457 / #548).
 *
 * Auto path is a harness write on Free Main start — not an Agent tool turn.
 * Graph stages and Package workers do not own this.
 */
import { isDefaultConversationTitle, writeConversationTitle } from "../tools/platform.js";
import type { ConversationTitleWriteRuntime } from "../tools/platform.js";
import type { TaskEnvelope } from "../types.js";

export function taskHasStructuredTargetOrScope(
  task: Pick<TaskEnvelope, "target" | "scope">,
): boolean {
  return Boolean(structuredTargetHint(task));
}

/** First host[:port] from structured target / scope.allow — no free-text scan. */
export function structuredTargetHint(task: Pick<TaskEnvelope, "target" | "scope">): string {
  for (const raw of structuredScopeBlobs(task)) {
    const parsed = hostPortFromBlob(raw);
    if (parsed) return parsed;
  }
  return "";
}

/** Title text from structured envelope only (no instruction NLP). */
export function harnessAutoTitleFromEnvelope(
  task: Pick<TaskEnvelope, "target" | "scope">,
): string {
  return structuredTargetHint(task).slice(0, 40);
}

export function shouldApplyHarnessAutoTitle(
  task: Pick<TaskEnvelope, "conversationTitle" | "target" | "scope">,
  opts?: { graphStage?: boolean; worker?: boolean },
): boolean {
  if (opts?.graphStage || opts?.worker) return false;
  if (!isDefaultConversationTitle(task.conversationTitle)) return false;
  return taskHasStructuredTargetOrScope(task);
}

export async function applyHarnessAutoTitle(
  runtime: ConversationTitleWriteRuntime,
  opts?: { graphStage?: boolean; worker?: boolean },
): Promise<{ applied: boolean; skipped?: string; title?: string }> {
  if (!shouldApplyHarnessAutoTitle(runtime.task, opts)) {
    return { applied: false, skipped: "gate" };
  }
  const title = harnessAutoTitleFromEnvelope(runtime.task);
  if (!title) return { applied: false, skipped: "no-hint" };
  const written = await writeConversationTitle(runtime, title, { onlyIfDefault: true });
  if (!written.ok || written.skipped) {
    return { applied: false, skipped: written.skipped ? "only_if_default" : "write-failed" };
  }
  const next = String(written.title || title).trim();
  if (next) runtime.task.conversationTitle = next;
  return { applied: true, title: next };
}

export type SessionTitleHintOptions = {
  /** Default Free still has the title tool for user-asked rename. */
  titleToolAvailable?: boolean;
};

/**
 * Task-layer session title block. Auto-title is a harness write (#548).
 * Hint does not tell act-expert packs to call a title tool.
 */
export function formatSessionTitleHint(
  task: Pick<TaskEnvelope, "conversationTitle" | "target" | "scope">,
  options?: SessionTitleHintOptions,
): string {
  const sessionTitle = String(task.conversationTitle ?? "").trim();
  const tool = options?.titleToolAvailable === true;
  const userAsked = tool
    ? " If the user asks to rename: platform_set_conversation_title(only_if_default=false)."
    : "";
  if (!isDefaultConversationTitle(sessionTitle)) {
    if (!sessionTitle) return "";
    return [
      "### Session title",
      `Current title: «${sessionTitle}». Do not change unless the user asks to rename.${tool ? " Then platform_set_conversation_title with only_if_default=false." : ""}`,
    ].join("\n");
  }
  if (!taskHasStructuredTargetOrScope(task)) {
    return [
      "### Session title",
      `Title is still the default. Do not auto-title greetings or ledger chat.${userAsked}`,
    ].join("\n");
  }
  return [
    "### Session title",
    "Title is still the default. Harness will name this Case from the structured target/scope. Do not announce the rename. Do not add a todo for this.",
  ].join("\n");
}

function structuredScopeBlobs(task: Pick<TaskEnvelope, "target" | "scope">): string[] {
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
