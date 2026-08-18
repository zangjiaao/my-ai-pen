/**
 * Host workspace layout — matches product identity (Spec #354 / #428):
 *
 *   {workspace}/case-{caseId}/                         Case-shared inspect
 *     expert-{expertId}/                               Participant Session sandbox (/workspace)
 *       pi-{piSessionId}/                              one pi-agent-core instance
 *
 * Task package id is not a directory. Park continue stays on the same pi-* dir;
 * Session Reset mints a new piSessionId → new pi-* dir under the same expert.
 */
import { appendFile, lstat, mkdir, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export function safeWorkspaceSegment(raw: string): string {
  const s = String(raw || "").trim().replace(/[/\\]/g, "_").slice(0, 128);
  if (!s) throw new Error("workspace path segment is empty");
  return s;
}

export function mintPiSessionId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `n4-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function resolveCaseDir(workspaceRoot: string, caseId: string): string {
  const root = resolve(String(workspaceRoot || "").trim() || "./workspace");
  return join(root, `case-${safeWorkspaceSegment(caseId)}`);
}

export function resolveExpertDir(
  workspaceRoot: string,
  caseId: string,
  expertId: string,
): string {
  return join(resolveCaseDir(workspaceRoot, caseId), `expert-${safeWorkspaceSegment(expertId)}`);
}

export function resolvePiInstanceDir(
  workspaceRoot: string,
  caseId: string,
  expertId: string,
  piSessionId: string,
): string {
  return join(
    resolveExpertDir(workspaceRoot, caseId, expertId),
    `pi-${safeWorkspaceSegment(piSessionId)}`,
  );
}

/**
 * Participant Session sandbox (pen-sandbox `/workspace` mount).
 * Same as {@link resolveExpertDir}.
 */
export function resolveSessionWorkspaceDir(
  workspaceRoot: string,
  conversationId: string,
  expertId: string,
): string {
  const conv = String(conversationId || "").trim();
  const exp = String(expertId || "").trim();
  if (!conv || !exp) {
    throw new Error("resolveSessionWorkspaceDir requires conversationId and expertId");
  }
  return resolveExpertDir(workspaceRoot, conv, exp);
}

/** Case-shared local inspect: findings + evidence + surface ledger. */
export async function ensureCaseWorkspace(caseDir: string): Promise<string> {
  const abs = resolve(caseDir);
  for (const sub of ["", "findings", "evidence", "surfaces"]) {
    await mkdir(sub ? join(abs, sub) : abs, { recursive: true });
  }
  return abs;
}

/** Expert sandbox: agent-writable home + cookie jars. */
export async function ensureExpertWorkspace(expertDir: string): Promise<string> {
  const abs = resolve(expertDir);
  for (const sub of ["", "scripts", "notes", "credentials", "exports", "session"]) {
    await mkdir(sub ? join(abs, sub) : abs, { recursive: true });
  }
  return abs;
}

/** One pi-agent-core instance: facts, tool-output, audit JSONL parent. */
export async function ensurePiInstanceWorkspace(piDir: string): Promise<string> {
  const abs = resolve(piDir);
  for (const sub of ["", "facts", "tool-output"]) {
    await mkdir(sub ? join(abs, sub) : abs, { recursive: true });
  }
  return abs;
}

/** @deprecated name — sandbox ensure; now expert-level (no unused findings/pi). */
export async function ensureSessionWorkspace(sessionDir: string): Promise<string> {
  return ensureExpertWorkspace(sessionDir);
}

export type WorkspaceLayout = {
  caseId: string;
  expertId: string;
  piSessionId: string;
  caseDir: string;
  expertDir: string;
  piDir: string;
};

export function resolveWorkspaceLayout(
  workspaceRoot: string,
  caseId: string,
  expertId: string,
  piSessionId: string,
): WorkspaceLayout {
  const caseDir = resolveCaseDir(workspaceRoot, caseId);
  const expertDir = resolveExpertDir(workspaceRoot, caseId, expertId);
  const piDir = resolvePiInstanceDir(workspaceRoot, caseId, expertId, piSessionId);
  return {
    caseId: String(caseId || "").trim(),
    expertId: String(expertId || "").trim(),
    piSessionId: String(piSessionId || "").trim(),
    caseDir,
    expertDir,
    piDir,
  };
}

export async function ensureWorkspaceLayout(layout: WorkspaceLayout): Promise<WorkspaceLayout> {
  await ensureCaseWorkspace(layout.caseDir);
  await ensureExpertWorkspace(layout.expertDir);
  await ensurePiInstanceWorkspace(layout.piDir);
  return layout;
}

/** Cookie / session-jar root: Expert sandbox (`session/cookies.json`). */
export function resolveRuntimeSessionDir(runtime: {
  sessionDir?: string;
  workspaceDir?: string;
  taskDir?: string;
  task?: { conversationId?: string; expertId?: string };
  rolePackId?: string;
}): string {
  if (runtime.sessionDir) return runtime.sessionDir;
  const conv = String(runtime.task?.conversationId || "").trim();
  const exp = String(runtime.task?.expertId || runtime.rolePackId || "").trim();
  const root = String(runtime.workspaceDir || "").trim();
  if (conv && exp && root) return resolveExpertDir(root, conv, exp);
  return String(runtime.taskDir || "");
}

export function resolveRuntimeCaseDir(runtime: {
  caseDir?: string;
  workspaceDir?: string;
  taskDir?: string;
  task?: { conversationId?: string };
}): string {
  if (runtime.caseDir) return runtime.caseDir;
  const conv = String(runtime.task?.conversationId || "").trim();
  const root = String(runtime.workspaceDir || "").trim();
  if (conv && root) return resolveCaseDir(root, conv);
  return String(runtime.taskDir || "");
}

/**
 * Host I/O under the sandbox mount must not follow agent-planted symlinks.
 * Unlink a symlink leaf (so the next write creates a regular file); refuse
 * symlink ancestors that would redirect the write outside `rootAbs`.
 */
export async function prepareHostWritePath(absPath: string, rootAbs: string): Promise<string> {
  const root = resolve(String(rootAbs || "").trim() || ".");
  const target = resolve(absPath);
  const rel = relative(root, target);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`host write outside workspace root: ${target}`);
  }
  let cur = target;
  while (true) {
    try {
      const st = await lstat(cur);
      if (st.isSymbolicLink()) {
        if (cur === target) await unlink(cur);
        else throw new Error(`host write blocked: symlink ancestor ${cur}`);
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw err;
    }
    if (cur === root) break;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return target;
}

export async function appendFileInsideRoot(
  absPath: string,
  rootAbs: string,
  data: string,
): Promise<void> {
  const target = await prepareHostWritePath(absPath, rootAbs);
  await appendFile(target, data, "utf8");
}
