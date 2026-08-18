import { readdir, access } from "node:fs/promises";
import { join } from "node:path";
import { ensureDirInsideRoot, writeFileInsideRoot } from "./session-workspace.js";

/**
 * After the agent disposes, write inspectable artifacts so operators can query
 * the session offline (OMP-like post-run inspectability).
 */
export async function writePostRunInspectArtifacts(options: {
  piDir: string;
  /** Case-shared findings/evidence/surfaces. Defaults to piDir (standalone). */
  caseDir?: string;
  /** Expert sandbox (scripts / cookies). Defaults to piDir (standalone). */
  sessionDir?: string;
  taskId: string;
  terminalStatus: string;
  summary: string;
  messages: unknown[];
  continueCount: number;
  stopReason: string;
  bookedFindingCount: number;
}): Promise<{ manifestPath: string; transcriptPath: string }> {
  const { piDir } = options;
  const caseDir = options.caseDir || piDir;
  const sessionDir = options.sessionDir || piDir;
  await ensureDirInsideRoot(piDir, piDir);

  const transcriptPath = join(piDir, "transcript.jsonl");
  const lines = (options.messages || []).map((m) => JSON.stringify(m));
  await writeFileInsideRoot(transcriptPath, piDir, lines.length ? `${lines.join("\n")}\n` : "");

  const present: string[] = [];
  const checks: Array<{ name: string; dir: string }> = [
    { name: "events.jsonl", dir: piDir },
    { name: "transcript.jsonl", dir: piDir },
    { name: "agent-summary.json", dir: piDir },
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
  const manifestPath = join(piDir, "session-manifest.json");
  await writeFileInsideRoot(manifestPath, piDir, JSON.stringify(manifest, null, 2));
  return { manifestPath, transcriptPath };
}

/** Pure check used by smokes: required inspect files exist after a run. */
export function inspectArtifactChecklist(entries: string[]): { ok: boolean; missing: string[] } {
  const need = ["events.jsonl", "transcript.jsonl", "session-manifest.json"];
  const set = new Set(entries);
  const missing = need.filter((n) => !set.has(n));
  return { ok: missing.length === 0, missing };
}
