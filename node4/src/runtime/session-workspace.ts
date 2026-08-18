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
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
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

/** Standalone / no conversationId — not a Task package id. */
export const LOCAL_CASE_ID = "local";

export function workspaceCaseId(conversationId?: string): string {
  return String(conversationId || "").trim() || LOCAL_CASE_ID;
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
  piDir?: string;
  task?: { conversationId?: string; expertId?: string };
  rolePackId?: string;
}): string {
  if (runtime.sessionDir) return runtime.sessionDir;
  const conv = String(runtime.task?.conversationId || "").trim();
  const exp = String(runtime.task?.expertId || runtime.rolePackId || "").trim();
  const root = String(runtime.workspaceDir || "").trim();
  if (conv && exp && root) return resolveExpertDir(root, conv, exp);
  return String(runtime.piDir || "");
}

export function resolveRuntimeCaseDir(runtime: {
  caseDir?: string;
  workspaceDir?: string;
  piDir?: string;
  task?: { conversationId?: string };
}): string {
  if (runtime.caseDir) return runtime.caseDir;
  const conv = String(runtime.task?.conversationId || "").trim();
  const root = String(runtime.workspaceDir || "").trim();
  if (conv && root) return resolveCaseDir(root, conv);
  return String(runtime.piDir || "");
}

function resolvedInsideRoot(absPath: string, rootAbs: string): { root: string; target: string } {
  const root = resolve(String(rootAbs || "").trim() || ".");
  const target = resolve(absPath);
  const rel = relative(root, target);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`host I/O outside workspace root: ${target}`);
  }
  return { root, target };
}

function pathStaysInside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function assertNotSymlinkDir(path: string): Promise<void> {
  const st = await lstat(path);
  if (st.isSymbolicLink()) throw new Error(`host I/O blocked: symlink ancestor ${path}`);
  if (!st.isDirectory()) throw new Error(`host I/O blocked: not a directory ${path}`);
}

/** Create `path` if missing. Existing symlink/file is a hard error. Concurrent create is ok. */
async function mkdirNoFollow(path: string): Promise<void> {
  try {
    await assertNotSymlinkDir(path);
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw err;
  }
  try {
    await mkdir(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") throw err;
  }
  await assertNotSymlinkDir(path);
}

/** Refuse symlink ancestors (leaf may be missing or a symlink we will not follow). */
export async function prepareHostWritePath(absPath: string, rootAbs: string): Promise<string> {
  const { root, target } = resolvedInsideRoot(absPath, rootAbs);
  let cur = dirname(target);
  while (true) {
    try {
      const st = await lstat(cur);
      if (st.isSymbolicLink()) {
        throw new Error(`host I/O blocked: symlink ancestor ${cur}`);
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

export async function ensureDirInsideRoot(dirAbs: string, rootAbs: string): Promise<void> {
  const { root, target } = resolvedInsideRoot(dirAbs, rootAbs);
  try {
    await assertNotSymlinkDir(root);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw err;
    await mkdir(root, { recursive: true });
    await assertNotSymlinkDir(root);
  }
  const rel = relative(root, target);
  if (!rel || rel === ".") return;
  let cur = root;
  for (const part of rel.split(/[/\\]/).filter(Boolean)) {
    cur = join(cur, part);
    await mkdirNoFollow(cur);
  }
}

async function openNoFollow(target: string, flags: number): Promise<Awaited<ReturnType<typeof open>>> {
  try {
    return await open(target, flags | fsConstants.O_NOFOLLOW);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ELOOP") {
      await unlink(target).catch(() => {});
      return open(target, flags | fsConstants.O_NOFOLLOW);
    }
    throw err;
  }
}

async function openLeafInsideRoot(
  absPath: string,
  rootAbs: string,
  flags: number,
): Promise<{ fh: Awaited<ReturnType<typeof open>>; target: string }> {
  const target = await prepareHostWritePath(absPath, rootAbs);
  await ensureDirInsideRoot(dirname(target), rootAbs);
  const fh = await openNoFollow(target, flags);
  try {
    const real = await realpath(target);
    if (!pathStaysInside(rootAbs, real)) {
      throw new Error(`host I/O escaped workspace root: ${real}`);
    }
  } catch (err) {
    await fh.close().catch(() => {});
    throw err;
  }
  return { fh, target };
}

export async function writeFileInsideRoot(
  absPath: string,
  rootAbs: string,
  data: string | Uint8Array,
): Promise<void> {
  const { fh } = await openLeafInsideRoot(
    absPath,
    rootAbs,
    fsConstants.O_RDWR | fsConstants.O_CREAT,
  );
  try {
    await fh.truncate(0);
    await fh.writeFile(data);
  } finally {
    await fh.close();
  }
}

export async function appendFileInsideRoot(
  absPath: string,
  rootAbs: string,
  data: string | Uint8Array,
): Promise<void> {
  const { fh } = await openLeafInsideRoot(
    absPath,
    rootAbs,
    fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_APPEND,
  );
  try {
    await fh.writeFile(data);
  } finally {
    await fh.close();
  }
}

/** Read a regular file only. Symlink leaf / ancestor → null (do not follow). */
export async function readFileInsideRoot(absPath: string, rootAbs: string): Promise<string | null> {
  try {
    const target = await prepareHostWritePath(absPath, rootAbs);
    const fh = await open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      return await fh.readFile("utf8");
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}
