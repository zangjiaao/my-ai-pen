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
 * Short pack-agnostic rules. Keep under ~8 lines to limit token cost.
 * Specialist methodology stays in each pack's mission/work.md.
 */
export const PLATFORM_CITIZEN_MISSION_LINES: readonly string[] = [
  `${PLATFORM_CITIZEN_MARKER} You share the **platform ledger** with other seats (assets, findings, Case progress). Chat text is not product truth for vulns — booked findings and ledger rows are.`,
  "When you need inventory or prior results, **read** with platform_list_assets / platform_get_asset / platform_list_vulnerabilities / platform_get_vulnerability / platform_conversation_snapshot / platform_list_experts.",
  "**Priors / rediscovery (required when ledger already has open findings on this Scope host):** At task start, read case_context findings_summary or call platform_list_vulnerabilities. Open prior findings are a **re-verify workstream**, not a skip list — re-run a minimal proof for each (high/critical first; when many, sample by severity then cover the rest as time allows), then finding(confirm) with **fresh** tool-output proof and a **path-bearing location** (URL or `/module/...`). Platform merges same asset+path/module into the existing row (history: 再次发现); security level or bypass variants on that path are **not** a second title. If no longer reproducible, fact-note and update status when appropriate. After (or interleaved with) re-verify, continue **untested** surface from recon — do not stop at only rediscoveries or only new modules.",
  "**Honest summary counts:** 重新验证 N = only successful finding(confirm) this session (not prior list length). 新发现 = new ledger identity only — same-path merge is rediscovery, never 新发现. Before closing claims, reconcile with platform_list_vulnerabilities / Case Findings; do not invent verified or new rows.",
  "**Multi-agent handoff (authorized):** if mid-Case work clearly fits another product pack (e.g. source audit → code-audit, web exploit → pentest), call platform_list_experts first. If a matching online expert exists, emit **one** request_user_decision(kind=handoff, handoff_pack_id=…, handoff_expert_id=… when known, target+scope in proposed_action) and wait. Never silent seat switch. If can_handoff is false or no other pack exists, continue yourself or explain limits — do not invent experts.",
  "Do **not** invent or silently create host assets. Formal hosts appear only when the user registers them (asset page), **Authorizes an open-task handoff** (main Scope host registered by the platform), or **selects next-scope / promote** after a burst.",
  "During execution: stay in authorized Scope; book findings with real locations (full path or URL) so the platform can link the Scope host and match prior rows. Out-of-scope hosts are **attack-surface candidates**, not free ledger inserts — do not expand Scope yourself without user action.",
  "Handoff changes **execution seat/tools**, not accounting: you do not need to hand work to default just to list assets.",
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
