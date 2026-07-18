/**
 * Large tool-output governance (CyberStrike C3 adapted).
 * Model-facing text is bounded; full/partial archive lives under taskDir for re-read.
 * Pure helpers + async archive — unit-testable without live LLM.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";

/** Soft cap for model-facing combined stdout+stderr (chars). */
export const MODEL_TOOL_OUTPUT_CHARS = 48_000;
/** Soft cap per stream when splitting. */
export const MODEL_STREAM_CHARS = 36_000;

export type GovernedStreams = {
  stdout: string;
  stderr: string;
  truncated: boolean;
  archived_path?: string;
  original_stdout_chars: number;
  original_stderr_chars: number;
  original_total_chars: number;
};

function headTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.65);
  const tail = maxChars - head - 80;
  if (tail < 40) return `${text.slice(0, maxChars)}\n…[truncated]`;
  return (
    `${text.slice(0, head)}\n\n…[${text.length - head - tail} chars omitted; full archive on disk]…\n\n` +
    text.slice(-tail)
  );
}

/**
 * Truncate streams for the model. Does not write disk — use archiveAndGovern for I/O.
 */
export function truncateStreamsForModel(
  stdout: string,
  stderr: string,
  limits: { total?: number; perStream?: number } = {},
): { stdout: string; stderr: string; truncated: boolean } {
  const totalLimit = limits.total ?? MODEL_TOOL_OUTPUT_CHARS;
  const per = limits.perStream ?? MODEL_STREAM_CHARS;
  let out = String(stdout ?? "");
  let err = String(stderr ?? "");
  let truncated = false;

  if (out.length > per) {
    out = headTail(out, per);
    truncated = true;
  }
  if (err.length > per) {
    err = headTail(err, per);
    truncated = true;
  }
  if (out.length + err.length > totalLimit) {
    const budgetOut = Math.floor(totalLimit * 0.75);
    const budgetErr = totalLimit - budgetOut;
    if (out.length > budgetOut) {
      out = headTail(out, budgetOut);
      truncated = true;
    }
    if (err.length > budgetErr) {
      err = headTail(err, budgetErr);
      truncated = true;
    }
  }
  return { stdout: out, stderr: err, truncated };
}

/**
 * When truncated (or forceArchive), write full stdout/stderr under
 * taskDir/tool-output/<stamp>-<tool>.txt for agent re-read via `read`.
 */
export async function archiveAndGovernToolOutput(options: {
  taskDir: string;
  tool: string;
  stdout: string;
  stderr: string;
  command?: string;
  /** Archive even if under cap (tests / explicit). Default: only when truncated. */
  forceArchive?: boolean;
  limits?: { total?: number; perStream?: number };
}): Promise<GovernedStreams> {
  const stdout = String(options.stdout ?? "");
  const stderr = String(options.stderr ?? "");
  const original_stdout_chars = stdout.length;
  const original_stderr_chars = stderr.length;
  const original_total_chars = original_stdout_chars + original_stderr_chars;
  const cut = truncateStreamsForModel(stdout, stderr, options.limits);
  const shouldArchive = options.forceArchive || cut.truncated;

  if (!shouldArchive) {
    return {
      stdout: cut.stdout,
      stderr: cut.stderr,
      truncated: false,
      original_stdout_chars,
      original_stderr_chars,
      original_total_chars,
    };
  }

  const dir = join(options.taskDir, "tool-output");
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const tool = String(options.tool || "tool").replace(/[^\w.-]+/g, "_").slice(0, 40);
  const hash = createHash("sha256")
    .update(stdout)
    .update("\0")
    .update(stderr)
    .digest("hex")
    .slice(0, 10);
  const rel = `tool-output/${stamp}-${tool}-${hash}.txt`;
  const abs = join(options.taskDir, rel);
  const header = [
    `# tool-output archive`,
    `tool: ${options.tool}`,
    `command: ${String(options.command || "").slice(0, 2000)}`,
    `stdout_chars: ${original_stdout_chars}`,
    `stderr_chars: ${original_stderr_chars}`,
    `truncated_for_model: ${cut.truncated}`,
    `--- stdout ---`,
    "",
  ].join("\n");
  const body = `${header}${stdout}\n\n--- stderr ---\n${stderr}\n`;
  await writeFile(abs, body, "utf8");

  const note =
    `\n\n[output truncated for model context; full archive: ${rel} — use read path="${rel}"]`;
  return {
    stdout: cut.stdout + (cut.truncated ? note : ""),
    stderr: cut.stderr,
    truncated: cut.truncated,
    archived_path: rel,
    original_stdout_chars,
    original_stderr_chars,
    original_total_chars,
  };
}
