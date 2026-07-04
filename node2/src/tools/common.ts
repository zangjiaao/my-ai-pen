import type { PlatformMessage, ToolRuntime } from "../types.js";

type ToolTextResult = {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
};

export function textResult(text: string, details: Record<string, unknown> = {}): ToolTextResult {
  return { content: [{ type: "text", text }], details };
}

export function jsonResult(value: unknown, details: Record<string, unknown> = {}): ToolTextResult {
  return textResult(JSON.stringify(value, null, 2), details);
}

export async function emitToolEvidence(
  runtime: ToolRuntime,
  sourceTool: string,
  summary: string,
  data: unknown,
): Promise<string> {
  const evidence = await runtime.evidence.create({ type: "tool_output", sourceTool, summary, data });
  await runtime.platform.send({
    type: "evidence_created",
    conversation_id: runtime.task.conversationId,
    task_id: runtime.task.taskId,
    evidence_id: evidence.id,
    source_tool: sourceTool,
    summary,
  } as PlatformMessage);
  return evidence.id;
}

export function targetBase(runtime: ToolRuntime): string | undefined {
  const value = runtime.task.target?.value;
  return typeof value === "string" && value ? value : undefined;
}

export function resolveTargetUrl(runtime: ToolRuntime, raw: string): string {
  if (/^https?:\/\//i.test(raw)) return raw;
  const base = targetBase(runtime);
  if (!base) throw new Error(`relative url requires task target.value: ${raw}`);
  const normalizedBase = /^https?:\/\//i.test(base) ? base : `http://${base}`;
  return new URL(raw, normalizedBase.endsWith("/") ? normalizedBase : `${normalizedBase}/`).toString();
}

export function isInScope(runtime: ToolRuntime, rawUrlOrHost: string): boolean {
  const allow = Array.isArray(runtime.task.scope?.allow) ? runtime.task.scope.allow : [];
  if (allow.length === 0) return true;
  const value = rawUrlOrHost.toLowerCase();
  return allow.some((entry) => {
    if (typeof entry !== "string" || !entry) return false;
    const normalized = entry.toLowerCase().replace(/^https?:\/\//, "");
    return value.includes(normalized);
  });
}
