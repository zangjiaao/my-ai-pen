import { mkdir, writeFile, readdir, access } from "node:fs/promises";
import { join } from "node:path";

/**
 * After the agent disposes, write inspectable artifacts so operators can query
 * the session offline (OMP-like post-run inspectability).
 */
export async function writePostRunInspectArtifacts(options: {
  taskDir: string;
  taskId: string;
  terminalStatus: string;
  summary: string;
  messages: unknown[];
  continueCount: number;
  stopReason: string;
  bookedFindingCount: number;
}): Promise<{ manifestPath: string; transcriptPath: string }> {
  const { taskDir } = options;
  await mkdir(taskDir, { recursive: true });

  const transcriptPath = join(taskDir, "transcript.jsonl");
  const lines = (options.messages || []).map((m) => JSON.stringify(m));
  await writeFile(transcriptPath, lines.length ? `${lines.join("\n")}\n` : "", "utf8");

  const present: string[] = [];
  for (const name of [
    "events.jsonl",
    "transcript.jsonl",
    "findings",
    "evidence",
    "scripts",
    "pi-sessions",
    "status.json",
    "finish-scan.json",
    "agent-summary.json",
  ]) {
    try {
      await access(join(taskDir, name));
      present.push(name);
    } catch {
      // missing
    }
  }

  let findingFiles = 0;
  let evidenceFiles = 0;
  try {
    findingFiles = (await readdir(join(taskDir, "findings"))).filter((n) => n.endsWith(".json")).length;
  } catch {
    /* */
  }
  try {
    evidenceFiles = (await readdir(join(taskDir, "evidence"))).filter((n) => n.endsWith(".json")).length;
  } catch {
    /* */
  }

  const manifest = {
    schema: "node4.session-manifest.v1",
    taskId: options.taskId,
    terminalStatus: options.terminalStatus,
    summary: options.summary,
    stopReason: options.stopReason,
    continueCount: options.continueCount,
    bookedFindingCount: options.bookedFindingCount,
    findingFiles,
    evidenceFiles,
    transcriptMessages: options.messages?.length ?? 0,
    artifacts: present,
    writtenAt: new Date().toISOString(),
    inspect: "Read transcript.jsonl, events.jsonl, findings/, evidence/, pi-sessions/ offline after dispose.",
  };
  const manifestPath = join(taskDir, "session-manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  return { manifestPath, transcriptPath };
}

/** Pure check used by smokes: required inspect files exist after a run. */
export function inspectArtifactChecklist(entries: string[]): { ok: boolean; missing: string[] } {
  const need = ["events.jsonl", "transcript.jsonl", "session-manifest.json"];
  const set = new Set(entries);
  const missing = need.filter((n) => !set.has(n));
  return { ok: missing.length === 0, missing };
}
