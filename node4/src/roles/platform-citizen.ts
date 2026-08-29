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
  "platform_create_asset",
  "platform_enrich_asset",
  "platform_batch_enrich_assets",
  "platform_list_groups",
  "platform_create_group",
  "platform_assemble_group",
  "platform_list_vulnerabilities",
  "platform_get_vulnerability",
  "fact",
  "platform_conversation_snapshot",
  "platform_set_conversation_title",
  "platform_list_experts",
  "request_user_decision",
] as const;

/**
 * Owner-ledger inventory reads. Pack Hard Graph `tools.allow` should list these
 * (listing Hosts is not live recon). Runtime filter does not invent them.
 */
export const GRAPH_STAGE_CITIZEN_INVENTORY_TOOLS = [
  "platform_list_assets",
  "platform_get_asset",
  "platform_list_groups",
] as const;

/**
 * Short pack-agnostic ledger rules. Keep ≤~1.2k chars / ~10 lines (OMP context).
 * Specialist methodology stays in each pack's mission/work.md.
 */
export const PLATFORM_CITIZEN_MISSION_LINES: readonly string[] = [
  `${PLATFORM_CITIZEN_MARKER} Platform owner ledger is shared product truth (user 资产管理 + Agent tools). Chat/todo is not.`,
  "Inventory questions (能看到哪些主机 / 有没有某台机 / tags·ports·notes): **platform_list_assets first** (optional q=), then answer from tool data — never claim inventory is invisible.",
  "Ledger Q&A only (user asked about the books): platform_list_assets / platform_get_asset / platform_list_vulnerabilities / platform_get_vulnerability / platform_conversation_snapshot / platform_list_experts. Pentest kickoff does not list the host vuln ledger.",
  "Notebook is **fact** (not a second tool): write-as-you-go. Auth/creds/lessons the next Session needs → fact(upsert) on an existing Host (asset_id or the single Scope Host). That is 情报 — **not** Finding, **not** Evidence (proof stays on the booked vuln). Living intel_summary is current working memory (this-Case writes + login kinds first, then frequently opened clues; windowed). Recorded valid creds are the login path (try them first; do not recover via defaults / hash dump / booked RCE). Summary is enough to act; fact(get) for the body. **Correct a living clue with upsert on that id**. fact(forget, reason) hard-drops. This-task keys stay under facts/. Do not invent a Host. Before wrap/next_steps: persist only clues worth keeping (skip if none). Compact persist is a separate pass.",
  "Open priors on this Scope host = an **index** (titles/summaries in case_context.scope_intel), not a start-of-turn work queue. Do not host-wide dump platform_list_vulnerabilities at kickoff. When you approach a path/module, look up that row (asset_id + port/q or platform_get_vulnerability). finding(confirm) needs **fresh** tool proof + **path-bearing location**. Same path/module merges (再次发现). Primary work remains untested surface + NEW ledger identities.",
  "Honest counts: 重新验证 N = successful confirm this session only; 新发现 = new ledger identity only. Reconcile with platform_list_vulnerabilities before closing claims — never invent rows.",
  "Cross-pack handoff: platform_list_experts → one request_user_decision(kind=handoff, …) and wait. Never silent seat switch; never invent experts.",
  "Hosts: identity=asset **id** (same IP OK across units as different Hosts). platform_list_assets(q=IP/domain) matches primary∪aliases (not note): unique → that id; **ambiguous** → request_user_decision with those Host ids (never first-match); none → do not invent a Host. Group: list_groups → if the member set is unclear, request_user_decision with Host ids (asset_ids / options.asset_id); user-allowed ids become Case Scope (harness projects intel). Then **continue the user's task** — do not invent a scan workflow. create_asset(group_name=): merge only if address already **in that Group**, else new Host. Ports: batch_enrich add **or** remove_ports. User says 新资产/改回端口 → short path: create + enrich(remove_ports); do not re-debate tool lists. assemble=装入组 only (does not expand Scope). Recon must not invent Hosts by itself — park on Workset; if the user asked this Case's discoveries into a Group, workset(op=set_intake, mode=enroll_group) and let harness enroll eligible rows. Exceptions (OOS / low confidence / needs_authorization / identity collision) stay proposed. Intel hangs on Host via fact; do not upsert Case-private copies.",
  "Stay in authorized Scope; book with full path/URL. Out-of-scope hosts are attack-surface candidates — do not auto-dump scan hits into the ledger without user request.",
  // Spec #312/#313 / #398: short hard rules only — schema detail lives on the tool/ChoiceCard.
  "next_steps: at pause with purposeful work, **one** request_user_decision(kind=next_steps, options[2–5] id+title+body); default **single-select**; may omit. Disclose open Free Tasks (honest progress) — no full-completion claim while map dirty. Never free-text A/B menus or only 等待指示.",
  "No silent Free todo replace: append/done only; full replace only after user ChoiceCard `replace_todo_map` / platform `todo_replace_allowed` (agent allow_replace alone ≠ grant).",
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
