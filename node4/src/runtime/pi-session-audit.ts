/**
 * Incremental pi-format session JSONL for audit (not Product SOT).
 *
 * One file per pi-agent-core instance:
 *   {workspace}/sessions/{conversationId}/{expertId}/pi/{sessionId}.jsonl
 *
 * Format matches pi-coding-agent session v3 (header + tree entries) so the
 * same JSONL readers work. Extra header fields are product metadata.
 * Assembled system prompt is snapshotted as a `custom` entry (pi itself
 * does not persist system — we do, because ours is assembled at runtime).
 *
 * Park continue appends the same file. Reset mints a new sessionId → new file.
 * Never used as a gate / Feedback / salvage input.
 */

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { resolvePiInstanceDir } from "./session-workspace.js";
import type { Node4AgentSession } from "./run-node4-agent.js";
import type { ToolRuntime } from "../types.js";

export const PI_SESSION_AUDIT_SCHEMA = "node4.pi-session-audit.v1";
export const SYSTEM_PROMPT_CUSTOM_TYPE = "system_prompt";

export type PiSessionAuditKind = "captain" | "stage" | "worker";

export type PiSessionAuditOpenOptions = {
  workspaceDir: string;
  conversationId: string;
  expertId: string;
  sessionId: string;
  systemPrompt: string;
  cwd?: string;
  taskId?: string;
  rolePackId?: string;
  kind?: PiSessionAuditKind;
  modelProvider?: string;
  modelId?: string;
  thinkingLevel?: string;
};

export type PiSessionAuditHandle = {
  path: string;
  sessionId: string;
  appendMessage: (message: unknown) => Promise<void>;
  appendCustom: (customType: string, data: unknown) => Promise<void>;
  drain: () => Promise<void>;
  close: () => Promise<void>;
};

type SessionHeader = {
  type: "session";
  version: 3;
  id: string;
  timestamp: string;
  cwd: string;
  schema: typeof PI_SESSION_AUDIT_SCHEMA;
  conversationId?: string;
  expertId?: string;
  taskId?: string;
  rolePackId?: string;
  kind?: PiSessionAuditKind;
};

type SessionEntry = {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
  [key: string]: unknown;
};

export function isPiSessionAuditDisabled(): boolean {
  const raw = String(process.env.NODE4_PI_SESSION_AUDIT || "").trim().toLowerCase();
  return raw === "0" || raw === "false" || raw === "off";
}

export function resolvePiSessionAuditPath(
  workspaceDir: string,
  conversationId: string,
  expertId: string,
  sessionId: string,
): string {
  return join(
    resolvePiInstanceDir(workspaceDir, conversationId, expertId, sessionId),
    "session.jsonl",
  );
}

export function inferPiSessionAuditKind(runtime: Pick<ToolRuntime, "lifecycle">): PiSessionAuditKind {
  const depth = Number(runtime.lifecycle?.subagentDepth ?? 0);
  if (depth > 0) return "worker";
  if (runtime.lifecycle?.hardGraphRun?.stageId) return "stage";
  return "captain";
}

function newEntryId(used: Set<string>): string {
  for (let i = 0; i < 32; i++) {
    const id = randomBytes(4).toString("hex");
    if (!used.has(id)) {
      used.add(id);
      return id;
    }
  }
  const id = randomBytes(8).toString("hex");
  used.add(id);
  return id;
}

function parseJsonlEntries(text: string): { header: SessionHeader | null; entries: SessionEntry[] } {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return { header: null, entries: [] };
  let header: SessionHeader | null = null;
  const entries: SessionEntry[] = [];
  for (let i = 0; i < lines.length; i++) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines[i] as string);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const rec = parsed as Record<string, unknown>;
    if (i === 0 && rec.type === "session") {
      header = rec as SessionHeader;
      continue;
    }
    if (typeof rec.type === "string" && typeof rec.id === "string") {
      entries.push(rec as SessionEntry);
    }
  }
  return { header, entries };
}

export async function openPiSessionAudit(
  options: PiSessionAuditOpenOptions,
): Promise<PiSessionAuditHandle> {
  const conversationId = String(options.conversationId || "").trim();
  const expertId = String(options.expertId || "").trim();
  const sessionId = String(options.sessionId || "").trim();
  if (!conversationId || !expertId || !sessionId) {
    throw new Error("openPiSessionAudit requires conversationId, expertId, sessionId");
  }
  const filePath = resolvePiSessionAuditPath(
    options.workspaceDir,
    conversationId,
    expertId,
    sessionId,
  );
  await mkdir(join(filePath, ".."), { recursive: true });

  const usedIds = new Set<string>();
  let leafId: string | null = null;
  let existed = false;
  try {
    const prior = await readFile(filePath, "utf8");
    const parsed = parseJsonlEntries(prior);
    if (parsed.header?.type === "session" && parsed.header.id) {
      existed = true;
      for (const e of parsed.entries) {
        usedIds.add(e.id);
        leafId = e.id;
      }
    }
  } catch {
    existed = false;
  }

  if (!existed) {
    const header: SessionHeader = {
      type: "session",
      version: 3,
      id: sessionId,
      timestamp: new Date().toISOString(),
      cwd: options.cwd || options.workspaceDir,
      schema: PI_SESSION_AUDIT_SCHEMA,
      conversationId,
      expertId,
      taskId: options.taskId,
      rolePackId: options.rolePackId,
      kind: options.kind,
    };
    await writeFile(filePath, `${JSON.stringify(header)}\n`, "utf8");
  }

  let writeChain: Promise<void> = Promise.resolve();
  const enqueue = (op: () => Promise<void>): Promise<void> => {
    const next = writeChain.then(op, op);
    writeChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const appendEntry = (entry: SessionEntry): Promise<void> =>
    enqueue(async () => {
      await appendFile(filePath, `${JSON.stringify(entry)}\n`, "utf8");
    });

  const push = async (partial: Omit<SessionEntry, "id" | "parentId" | "timestamp"> & {
    type: string;
  }): Promise<void> => {
    const id = newEntryId(usedIds);
    const entry: SessionEntry = {
      ...partial,
      id,
      parentId: leafId,
      timestamp: new Date().toISOString(),
    };
    leafId = id;
    await appendEntry(entry);
  };

  const handle: PiSessionAuditHandle = {
    path: filePath,
    sessionId,
    appendMessage: (message) => push({ type: "message", message }),
    appendCustom: (customType, data) => push({ type: "custom", customType, data }),
    drain: () => writeChain,
    close: () => writeChain,
  };

  if (!existed) {
    if (options.modelProvider || options.modelId) {
      await push({
        type: "model_change",
        provider: options.modelProvider || "",
        modelId: options.modelId || "",
      });
    }
    if (options.thinkingLevel) {
      await push({ type: "thinking_level_change", thinkingLevel: options.thinkingLevel });
    }
    await handle.appendCustom(SYSTEM_PROMPT_CUSTOM_TYPE, {
      text: options.systemPrompt || "",
    });
  } else if (options.systemPrompt) {
    // Resumed file (same Agent.sessionId): record a new snapshot only when asked
    // at open. Callers open once per Agent construct, so this is Reset-reuse
    // or process-local reopen — keep the original snapshot, do not duplicate.
  }

  return handle;
}

export function attachPiSessionAudit(
  session: Node4AgentSession,
  handle: PiSessionAuditHandle,
): () => void {
  const unsub = session.subscribe(async (event: AgentEvent) => {
    if (event.type !== "message_end") return;
    const message = (event as { message?: unknown }).message;
    if (!message || typeof message !== "object") return;
    const role = (message as { role?: unknown }).role;
    if (role !== "user" && role !== "assistant" && role !== "toolResult") return;
    void handle.appendMessage(message);
  });

  const prevDispose = session.dispose.bind(session);
  session.dispose = () => {
    unsub();
    const done = handle.close();
    let out: void | Promise<void>;
    try {
      out = prevDispose();
    } catch {
      return done;
    }
    return Promise.resolve(out).then(() => done, () => done);
  };

  return () => {
    unsub();
    void handle.close();
  };
}

export async function attachBoundSessionAudit(
  session: Node4AgentSession,
  options: {
    workspaceDir: string;
    runtime: ToolRuntime;
    systemPrompt: string;
    thinkingLevel?: string;
    modelProvider?: string;
    modelId?: string;
  },
): Promise<PiSessionAuditHandle | null> {
  if (isPiSessionAuditDisabled()) return null;
  const task = options.runtime.task;
  const conversationId = String(task?.conversationId || "").trim();
  const expertId = String(task?.expertId || options.runtime.rolePackId || "").trim();
  const sessionId = String(session.sessionId || "").trim();
  if (!conversationId || !expertId || !sessionId) return null;
  const handle = await openPiSessionAudit({
    workspaceDir: options.workspaceDir,
    conversationId,
    expertId,
    sessionId,
    systemPrompt: options.systemPrompt,
    cwd: options.runtime.taskDir || options.workspaceDir,
    taskId: task?.taskId,
    rolePackId: options.runtime.rolePackId,
    kind: inferPiSessionAuditKind(options.runtime),
    modelProvider: options.modelProvider,
    modelId: options.modelId,
    thinkingLevel: options.thinkingLevel,
  });
  attachPiSessionAudit(session, handle);
  return handle;
}
