/**
 * Platform citizen base layer (model B).
 *
 * All expert packs inherit read ledger tools + Scope/asset rules at load time.
 * Host asset *create* stays on user-authorized platform boundaries only
 * (handoff Authorize, next-scope, asset page) — never silent agent invent.
 *
 * default seat keeps a fuller ledger tool set in default.ts; this module is
 * the shared minimum for every pack loaded via experts/load-pack.
 */

/** Stable marker so mission inject is idempotent. */
export const PLATFORM_CITIZEN_MARKER = "[platform-citizen]";

/** Read-first ledger tools shared by every pack. */
export const PLATFORM_CITIZEN_TOOL_NAMES = [
  "platform_list_assets",
  "platform_get_asset",
  "platform_list_vulnerabilities",
  "platform_get_vulnerability",
  "platform_conversation_snapshot",
  "platform_list_experts",
  "request_user_decision",
] as const;

/**
 * Short pack-agnostic ledger rules. Keep ≤~1.2k chars / ~10 lines (OMP context).
 * Specialist methodology stays in each pack's mission/work.md.
 */
export const PLATFORM_CITIZEN_MISSION_LINES: readonly string[] = [
  `${PLATFORM_CITIZEN_MARKER} Platform ledger is product truth (assets, findings, Case). Chat/todo is not.`,
  "Read inventory/priors: platform_list_assets / platform_get_asset / platform_list_vulnerabilities / platform_get_vulnerability / platform_conversation_snapshot / platform_list_experts.",
  "Open priors on this Scope host = **re-verify workstream** (not a skip list): high/critical first; finding(confirm) with **fresh** tool proof + **path-bearing location**. Same path/module merges (再次发现); level/bypass on same path ≠ new title. Interleave untested recon surface.",
  "Honest counts: 重新验证 N = successful confirm this session only; 新发现 = new ledger identity only. Reconcile with platform_list_vulnerabilities before closing claims — never invent rows.",
  "Cross-pack handoff: platform_list_experts → one request_user_decision(kind=handoff, …) and wait. Never silent seat switch; never invent experts.",
  "Do **not** invent host assets. Hosts appear only via user register, handoff Authorize, or next-scope/promote.",
  "Stay in authorized Scope; book with full path/URL. Out-of-scope hosts are attack-surface candidates, not free ledger inserts.",
];

/** Prepend citizen tools; de-dupe while preserving first-seen order. */
export function mergePlatformCitizenTools(toolNames: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of [...PLATFORM_CITIZEN_TOOL_NAMES, ...toolNames]) {
    const key = String(name || "").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/** Prepend citizen mission once (skip if marker already present). */
export function mergePlatformCitizenMission(missionLines: readonly string[]): string[] {
  const existing = missionLines.map(String);
  if (existing.some((l) => l.includes(PLATFORM_CITIZEN_MARKER))) {
    return existing;
  }
  return [...PLATFORM_CITIZEN_MISSION_LINES, ...existing];
}
