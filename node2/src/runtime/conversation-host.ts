/**
 * Conversation-scoped living host: one Pi session per platform conversation.
 *
 * Platform chat is a group; the pentest agent is a persistent participant.
 * Completing or failing a *work burst* must not wipe that participant's memory.
 *
 * Lifecycle:
 *   task_assign (first) → create host, run initial work, stay idle with session alive
 *   user_steer / task_assign (follow-up) → prompt same Pi session with new user text
 *   dispose → only on explicit interrupt cancel of the conversation or host eviction
 */
import type { Node2Config } from "../config.js";
import type { PlatformMessage, PlatformSink, TaskEnvelope } from "../types.js";
import {
  continueLivingPentestSession,
  createLivingPentestSession,
  type LivingPentestSession,
} from "./session-runner.js";

export type ConversationHostStatus = "idle" | "running" | "disposed";

export class ConversationHost {
  private status: ConversationHostStatus = "idle";
  private living: LivingPentestSession | undefined;
  private runChain: Promise<void> = Promise.resolve();

  constructor(
    readonly conversationId: string,
    private readonly config: Node2Config,
    private readonly platform: PlatformSink,
  ) {}

  getStatus(): ConversationHostStatus {
    return this.status;
  }

  isBusy(): boolean {
    return this.status === "running";
  }

  /**
   * First task_assign for this conversation, or a full re-assign after dispose.
   */
  async startTask(task: TaskEnvelope, signal?: AbortSignal): Promise<void> {
    return this.enqueue(async () => {
      if (this.status === "disposed") {
        throw new Error("Conversation host is disposed");
      }
      if (this.living && this.living.conversationId === task.conversationId) {
        // Same conversation: treat as follow-up work on the existing mind, not a wipe.
        await this.living.followUp(
          [
            "The platform re-assigned work for this conversation. Continue in the same session memory.",
            "User / system instruction:",
            task.instruction || "(empty)",
          ].join("\n"),
          signal,
        );
        return;
      }
      if (this.living) {
        await this.living.dispose();
        this.living = undefined;
      }
      this.status = "running";
      try {
        this.living = await createLivingPentestSession(this.config, this.platform, task, signal);
      } finally {
        this.status = this.living ? "idle" : "disposed";
      }
    });
  }

  /**
   * User follow-up in the group chat directed at this agent (继续 / steers / Q&A).
   */
  async steer(text: string, signal?: AbortSignal): Promise<void> {
    const message = String(text || "").trim();
    if (!message) return;
    return this.enqueue(async () => {
      if (this.status === "disposed") {
        throw new Error("Conversation host is disposed");
      }
      if (!this.living) {
        await this.platform.send({
          type: "text",
          conversation_id: this.conversationId,
          content: {
            text:
              "This pentest agent has no live session for this conversation yet. " +
              "Start with a task that includes a target URL/IP (or re-assign the task once).",
          },
        } as PlatformMessage);
        return;
      }
      this.status = "running";
      try {
        await this.living.followUp(message, signal);
      } finally {
        this.status = this.living ? "idle" : "disposed";
      }
    });
  }

  async dispose(): Promise<void> {
    return this.enqueue(async () => {
      if (this.living) {
        await this.living.dispose();
        this.living = undefined;
      }
      this.status = "disposed";
    });
  }

  private enqueue(job: () => Promise<void>): Promise<void> {
    const next = this.runChain.then(job, job);
    this.runChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

/** Process-wide hosts keyed by platform conversation id. */
const hosts = new Map<string, ConversationHost>();

export function getConversationHost(conversationId: string): ConversationHost | undefined {
  return hosts.get(conversationId);
}

export function getOrCreateConversationHost(
  conversationId: string,
  config: Node2Config,
  platform: PlatformSink,
): ConversationHost {
  let host = hosts.get(conversationId);
  if (!host || host.getStatus() === "disposed") {
    host = new ConversationHost(conversationId, config, platform);
    hosts.set(conversationId, host);
  }
  return host;
}

export async function disposeConversationHost(conversationId: string): Promise<void> {
  const host = hosts.get(conversationId);
  if (!host) return;
  await host.dispose();
  hosts.delete(conversationId);
}

// re-export for tests
export type { LivingPentestSession };
export { continueLivingPentestSession };
