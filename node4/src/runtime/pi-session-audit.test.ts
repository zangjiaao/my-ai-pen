/**
 * Incremental pi-format session audit JSONL.
 * Run: npx tsx src/runtime/pi-session-audit.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { Node4AgentSession } from "./run-node4-agent.js";
import {
  PI_SESSION_AUDIT_SCHEMA,
  SYSTEM_PROMPT_CUSTOM_TYPE,
  attachPiSessionAudit,
  inferPiSessionAuditKind,
  openPiSessionAudit,
  resolvePiSessionAuditPath,
} from "./pi-session-audit.js";

function fakeSession(): Node4AgentSession & {
  emit: (event: AgentEvent) => Promise<void>;
} {
  const listeners = new Set<(e: AgentEvent) => void | Promise<void>>();
  return {
    prompt: async () => {},
    abort: () => {},
    dispose: () => {},
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    steer: () => {},
    followUp: () => {},
    get messages() {
      return [];
    },
    get sessionId() {
      return "sid-test";
    },
    async emit(event) {
      for (const l of listeners) await l(event);
    },
  };
}

function linesOf(path: string): Record<string, unknown>[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

const root = mkdtempSync(join(tmpdir(), "pi-audit-"));
try {
  const conversationId = "case-aaa";
  const expertId = "exp-1";
  const sessionId = "agent-sid-1";

  {
    const p = resolvePiSessionAuditPath(root, conversationId, expertId, sessionId);
    assert.ok(
      p.endsWith(join("case-case-aaa", "expert-exp-1", "pi-agent-sid-1", "session.jsonl")),
      p,
    );
  }

  {
    const handle = await openPiSessionAudit({
      workspaceDir: root,
      conversationId,
      expertId,
      sessionId,
      systemPrompt: "## Standing node policies\n## Profession\nbe careful\n## Task\n- Target: x",
      cwd: "/tmp/task",
      taskId: "task-1",
      rolePackId: "pentest",
      kind: "captain",
      modelProvider: "deepseek",
      modelId: "deepseek-v4-flash",
      thinkingLevel: "medium",
    });
    const rows = linesOf(handle.path);
    assert.equal(rows[0]?.type, "session");
    assert.equal(rows[0]?.version, 3);
    assert.equal(rows[0]?.id, sessionId);
    assert.equal(rows[0]?.schema, PI_SESSION_AUDIT_SCHEMA);
    assert.equal(rows[0]?.conversationId, conversationId);
    assert.equal(rows[0]?.kind, "captain");
    assert.ok(rows.some((r) => r.type === "model_change" && r.modelId === "deepseek-v4-flash"));
    assert.ok(rows.some((r) => r.type === "thinking_level_change" && r.thinkingLevel === "medium"));
    const sys = rows.find((r) => r.type === "custom" && r.customType === SYSTEM_PROMPT_CUSTOM_TYPE);
    assert.ok(sys, "system prompt custom entry");
    const data = sys?.data as { text?: string };
    assert.ok(data.text?.includes("## Profession"), "assembled system text stored");
    assert.ok(data.text?.includes("- Target: x"));

    await handle.appendMessage({
      role: "user",
      content: [{ type: "text", text: "对目标做渗透测试" }],
      timestamp: Date.now(),
    });
    await handle.appendMessage({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "先登录" },
        { type: "text", text: "开始探测" },
        { type: "toolCall", id: "c1", name: "session", arguments: { op: "login" } },
      ],
      stopReason: "toolUse",
      timestamp: Date.now(),
    });
    await handle.appendMessage({
      role: "toolResult",
      toolCallId: "c1",
      toolName: "session",
      content: [{ type: "text", text: "ok" }],
      isError: false,
      timestamp: Date.now(),
    });
    await handle.drain();
    const after = linesOf(handle.path);
    const roles = after
      .filter((r) => r.type === "message")
      .map((r) => (r.message as { role?: string }).role);
    assert.deepEqual(roles, ["user", "assistant", "toolResult"]);
    const parentIds = after.filter((r) => r.type !== "session").map((r) => r.parentId);
    assert.equal(parentIds[0], null, "first entry parent null");
    for (let i = 1; i < parentIds.length; i++) {
      assert.equal(parentIds[i], after.filter((r) => r.type !== "session")[i - 1]?.id);
    }
    await handle.close();
  }

  // Reopen same sessionId: do not wipe header / system snapshot; append continues.
  {
    const handle = await openPiSessionAudit({
      workspaceDir: root,
      conversationId,
      expertId,
      sessionId,
      systemPrompt: "SHOULD-NOT-REPLACE",
    });
    const before = linesOf(handle.path).length;
    await handle.appendMessage({
      role: "user",
      content: "继续",
      timestamp: Date.now(),
    });
    await handle.drain();
    const rows = linesOf(handle.path);
    assert.ok(rows.length === before + 1, "append only");
    const sysTexts = rows
      .filter((r) => r.type === "custom" && r.customType === SYSTEM_PROMPT_CUSTOM_TYPE)
      .map((r) => (r.data as { text?: string }).text || "");
    assert.equal(sysTexts.length, 1, "no duplicate system snapshot on reopen");
    assert.ok(sysTexts[0]?.includes("## Profession"));
    assert.ok(!sysTexts[0]?.includes("SHOULD-NOT-REPLACE"));
    await handle.close();
  }

  {
    const session = fakeSession();
    const handle = await openPiSessionAudit({
      workspaceDir: root,
      conversationId,
      expertId,
      sessionId: "sid-attach",
      systemPrompt: "sys-attach",
    });
    attachPiSessionAudit(session, handle);
    await session.emit({
      type: "message_end",
      message: { role: "user", content: "hello", timestamp: 1 },
    } as AgentEvent);
    await session.emit({
      type: "message_update",
      message: { role: "assistant", content: [{ type: "text", text: "partial" }] },
    } as AgentEvent);
    await session.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        timestamp: 2,
      },
    } as AgentEvent);
    await handle.drain();
    const roles = linesOf(handle.path)
      .filter((r) => r.type === "message")
      .map((r) => (r.message as { role?: string }).role);
    assert.deepEqual(roles, ["user", "assistant"], "only message_end persisted");
    await session.dispose();
  }

  {
    assert.equal(
      inferPiSessionAuditKind({ lifecycle: { subagentDepth: 1 } } as never),
      "worker",
    );
    assert.equal(
      inferPiSessionAuditKind({
        lifecycle: { hardGraphRun: { stageId: "recon" } },
      } as never),
      "stage",
    );
    assert.equal(inferPiSessionAuditKind({ lifecycle: {} } as never), "captain");
  }

  console.log("ok pi-session-audit");
} finally {
  rmSync(root, { recursive: true, force: true });
}
