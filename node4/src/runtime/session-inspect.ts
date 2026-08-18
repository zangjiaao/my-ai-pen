import { mkdir, writeFile, readdir, access } from "node:fs/promises";
import { join } from "node:path";
import { prepareHostWritePath } from "./session-workspace.js";

/**
 * After the agent disposes, write inspectable artifacts so operators can query
 * the session offline (OMP-like post-run inspectability).
 */
export async function writePostRunInspectArtifacts(options: {
  taskDir: string;
  /** Case-shared findings/evidence/surfaces. Defaults to taskDir (standalone). */
  caseDir?: string;
  /** Expert sandbox (scripts / cookies). Defaults to taskDir (standalone). */
  sessionDir?: string;
  taskId: string;
  terminalStatus: string;
  summary: string;
  messages: unknown[];
  continueCount: number;
  stopReason: string;
  bookedFindingCount: number;
}): Promise<{ manifestPath: string; transcriptPath: string }> {
  const { taskDir } = options;
  const caseDir = options.caseDir || taskDir;
  const sessionDir = options.sessionDir || taskDir;
  await mkdir(taskDir, { recursive: true });

  const transcriptPath = await prepareHostWritePath(join(taskDir, "transcript.jsonl"), taskDir);
  const lines = (options.messages || []).map((m) => JSON.stringify(m));
  await writeFile(transcriptPath, lines.length ? `${lines.join("\n")}\n` : "", "utf8");

  const present: string[] = [];
  const checks: Array<{ name: string; dir: string }> = [
    { name: "events.jsonl", dir: taskDir },
    { name: "transcript.jsonl", dir: taskDir },
    { name: "agent-summary.json", dir: taskDir },
    { name: "findings", dir: caseDir },
    { name: "evidence", dir: caseDir },
    { name: "surfaces", dir: caseDir },
    { name: "scripts", dir: sessionDir },
  ];
  for (const { name, dir } of checks) {
    try {
      await access(join(dir, name));
      present.push(name);
    } catch {
      // missing
    }
  }

  let findingFiles = 0;
  let evidenceFiles = 0;
  try {
    findingFiles = (await readdir(join(caseDir, "findings"))).filter((n) => n.endsWith(".json")).length;
  } catch {
    /* */
  }
  try {
    evidenceFiles = (await readdir(join(caseDir, "evidence"))).filter((n) => n.endsWith(".json")).length;
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
    inspect:
      "Read workspace/case-{caseId}/expert-{expertId}/pi-{sessionId}/events.jsonl and workspace/case-{caseId}/ (findings/, evidence/, surfaces/) after dispose.",
  };
  const manifestPath = await prepareHostWritePath(join(taskDir, "session-manifest.json"), taskDir);
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
