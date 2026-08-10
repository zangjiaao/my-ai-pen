/**
 * Case conversation URL helpers.
 *
 * Canonical open-session path is `/:caseId` (UUID). Home `/` is blank composer.
 * Feature paths (/dashboard, /assets, …) are registered separately and never use these.
 */

/** Blank chat / new session. */
export const HOME_CHAT_PATH = "/";

/** Platform conversation ids are UUIDs. */
const CASE_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isCaseId(value: string | null | undefined): boolean {
  const id = String(value || "").trim();
  return Boolean(id) && CASE_ID_RE.test(id);
}

/** Canonical Case URL for an open conversation. */
export function casePath(caseId: string): string {
  return `/${String(caseId || "").trim()}`;
}

/**
 * True when the location is the conversation surface: blank home or `/:uuid`.
 * Used by Sidebar selection chrome (not for routing auth).
 */
export function isConversationSurfacePath(pathname: string): boolean {
  if (pathname === "/" || pathname === "") return true;
  const rest = pathname.startsWith("/") ? pathname.slice(1) : pathname;
  if (!rest || rest.includes("/")) return false;
  return isCaseId(rest);
}

/** Parse a Case id from a pathname, or null if not a Case URL. */
export function caseIdFromPathname(pathname: string): string | null {
  if (pathname === "/" || pathname === "") return null;
  const rest = pathname.startsWith("/") ? pathname.slice(1) : pathname;
  if (!rest || rest.includes("/")) return null;
  return isCaseId(rest) ? rest : null;
}
