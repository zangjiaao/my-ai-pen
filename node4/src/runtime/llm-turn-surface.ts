/**
 * Spec #353 — single surface path for LLM-turn terminal failures (S2).
 * Free + Graph runners call this instead of copy-pasted emit/throw blocks.
 */

import type { PlatformSink } from "../types.js";
import type { LlmStreamHealth, StreamDiagnosis } from "./llm-stream-health.js";
import { streamIdleTimeoutMessage } from "./llm-stream-health.js";
import {
  isIncompleteStreamError,
  isLlmTurnError,
  llmTurnErrorWithDiagnosis,
  type LlmTurnError,
} from "./llm-turn-error.js";

/** Serialize diagnosis for status/task_error (no secrets / full tool args). */
export function streamDiagnosisPayload(
  diagnosis: StreamDiagnosis | undefined | null,
): StreamDiagnosis | undefined {
  if (!diagnosis) return undefined;
  return {
    stream_terminal_class: diagnosis.stream_terminal_class,
    provider_message: String(diagnosis.provider_message || "").slice(0, 500),
    last_activity_at: diagnosis.last_activity_at,
    idle_ms: diagnosis.idle_ms,
    chunk_count: diagnosis.chunk_count,
    kind_counts: { ...diagnosis.kind_counts },
    tool_name_seen: diagnosis.tool_name_seen === true,
    tool_name: diagnosis.tool_name ? String(diagnosis.tool_name).slice(0, 64) : undefined,
    finish_reason_present: diagnosis.finish_reason_present === true,
  };
}

export type SurfaceLlmTurnFailureInput = {
  platform: PlatformSink;
  conversationId: string;
  taskId: string;
  /** Progressive chat bubble sink; optional for throw-only re-surfaces. */
  textStream?: { emitFinalText: (text: string) => Promise<void> };
  health?: LlmStreamHealth | null;
  /** Already-built error (preferred when diagnosis is present). */
  error?: LlmTurnError;
  /** Raw provider / extract message when error is not yet built. */
  providerMessage?: string;
  /** Optional llm_usage snapshot for task_error (callers attach on settle). */
  llmUsage?: Record<string, unknown>;
  /**
   * When false, only build the error (no chat). Used after tick already
   * aborted the session and a prior surface already published — rare; default true.
   */
  publish?: boolean;
};

/**
 * Build LlmTurnError + (by default) emit user-visible failure once.
 * Callers: `throw await surfaceLlmTurnFailure(...)`.
 */
export async function surfaceLlmTurnFailure(
  input: SurfaceLlmTurnFailureInput,
): Promise<LlmTurnError> {
  const err = resolveLlmTurnError(input);
  if (input.publish === false) return err;

  try {
    await input.textStream?.emitFinalText(err.userMessage);
  } catch {
    /* best-effort chat bubble */
  }

  return err;
}

function resolveLlmTurnError(input: SurfaceLlmTurnFailureInput): LlmTurnError {
  if (input.error && isLlmTurnError(input.error)) {
    if (input.error.diagnosis) return input.error;
    return llmTurnErrorWithDiagnosis(input.error.userMessage, input.health, {
      finishReasonPresent: false,
    });
  }
  const raw = String(input.providerMessage || "Model request failed").trim();
  return llmTurnErrorWithDiagnosis(raw, input.health, { finishReasonPresent: false });
}

/**
 * Map a prompt throw (or idle-abort flag) to LlmTurnError when it is a known
 * stream/LLM class. Returns null for unknown throws — callers rethrow original.
 * No free-text keyword tables for arbitrary "looks like LLM" wrapping.
 */
export function mapPromptFailureToLlmTurnError(
  err: unknown,
  health?: LlmStreamHealth | null,
): LlmTurnError | null {
  if (health?.isIdleAbortRequested) {
    return llmTurnErrorWithDiagnosis(streamIdleTimeoutMessage(), health);
  }
  if (isLlmTurnError(err)) {
    if (err.diagnosis) return err;
    return llmTurnErrorWithDiagnosis(err.userMessage, health, { finishReasonPresent: false });
  }
  if (isIncompleteStreamError(err)) {
    const raw = err instanceof Error ? err.message : String(err);
    return llmTurnErrorWithDiagnosis(raw, health, { finishReasonPresent: false });
  }
  return null;
}

/** Idle-timeout path after stream health already terminalized. */
export function idleTimeoutLlmTurnError(health?: LlmStreamHealth | null): LlmTurnError {
  return llmTurnErrorWithDiagnosis(streamIdleTimeoutMessage(), health);
}
