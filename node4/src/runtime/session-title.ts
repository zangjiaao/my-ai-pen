/**
 * Case session-title Task hint (Spec #457).
 *
 * Main (Default / Expert Free) owns auto-title via the assembled Task layer.
 * Not a separate Agent Session. Graph stages and Package workers do not own this.
 */
import { isDefaultConversationTitle } from "../tools/platform.js";
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

/**
 * Task-layer session title block. Auto-title only when the Case is still a
 * placeholder and this turn has a structured target/scope.
 */
export function formatSessionTitleHint(
  task: Pick<TaskEnvelope, "conversationTitle" | "target" | "scope">,
): string {
  const sessionTitle = String(task.conversationTitle ?? "").trim();
  if (!isDefaultConversationTitle(sessionTitle)) {
    if (!sessionTitle) return "";
    return [
      "### Session title",
      `Current title: «${sessionTitle}». Do not change unless the user asks to rename (then platform_set_conversation_title with only_if_default=false).`,
    ].join("\n");
  }
  if (!taskHasStructuredTargetOrScope(task)) {
    return [
      "### Session title",
      "Title is still the default. Do not auto-title greetings or ledger chat. If the user asks to rename: platform_set_conversation_title(only_if_default=false).",
    ].join("\n");
  }
  return [
    "### Session title",
    "Title is still the default. This turn has a structured target/scope — call platform_set_conversation_title once with only_if_default=true and a short title (user focus + host/port; ≤~24 Chinese or ~40 Latin; no quotes, no trailing period). Do not announce the rename. Do not add a todo for this.",
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
