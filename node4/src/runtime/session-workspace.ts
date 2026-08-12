/**
 * Spec #428: Session-scoped host workspace for sticky pen-sandbox mount (/workspace).
 * Layout: {workspaceRoot}/{conversationId}/{expertId}/
 */
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

/** Canonical host path for a Participant Session seat workspace. */
export function resolveSessionWorkspaceDir(
  workspaceRoot: string,
  conversationId: string,
  expertId: string,
): string {
  const root = resolve(String(workspaceRoot || "").trim() || "./workspace");
  const conv = String(conversationId || "").trim();
  const exp = String(expertId || "").trim();
  if (!conv || !exp) {
    throw new Error("resolveSessionWorkspaceDir requires conversationId and expertId");
  }
  // Sanitize path segments (UUIDs / catalog ids are usually safe; strip path separators).
  const safe = (s: string) => s.replace(/[/\\]/g, "_").slice(0, 128);
  return join(root, "sessions", safe(conv), safe(exp));
}

/** Ensure durable subdirs exist under the Session workspace. */
export async function ensureSessionWorkspace(sessionDir: string): Promise<string> {
  const abs = resolve(sessionDir);
  for (const sub of ["", "scripts", "evidence", "findings", "credentials", "exports", "notes"]) {
    await mkdir(sub ? join(abs, sub) : abs, { recursive: true });
  }
  return abs;
}
