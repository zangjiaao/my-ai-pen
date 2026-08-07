/**
 * Spec #311 — Case Workset client helpers (inventory SoT; not choice chrome).
 * Separate from Tasks (plan_tree worker todos).
 * Spec #312 L10: mechanical Next list retired — keep order/parse/baton helpers only.
 */

export type WorksetFamily = "t_surface" | "t_host";
export type WorksetStatus = "proposed" | "adopted" | "done" | "rejected";

export type WorksetItem = {
  id: string;
  family: WorksetFamily | string;
  title?: string;
  summary?: string;
  payload?: Record<string, unknown>;
  status: WorksetStatus | string;
  source?: string;
  suggested_expert?: string;
  auto_eligible?: boolean;
  in_progress?: boolean;
  expert_id?: string;
  expert_name?: string;
  graph_id?: string;
  work_mode?: string;
  sort_order?: number;
  created_at?: string;
  updated_at?: string;
};

export type WorksetProjection = {
  version?: number;
  items: WorksetItem[];
  open_count?: number;
  all_items?: WorksetItem[];
  closed_items?: WorksetItem[];
  goal?: {
    status?: string;
    terminal?: string;
    residual?: { class?: string; pending_host_count?: number };
    outer_rounds?: number;
    outer_budget?: number;
  } | null;
};

/** Default order: in-progress → adopted → auto-eligible t_surface proposed → other proposed. */
export function orderWorksetItems(items: WorksetItem[]): WorksetItem[] {
  const open = items.filter((i) => {
    const st = String(i.status || "");
    return st === "proposed" || st === "adopted";
  });

  const band = (item: WorksetItem): number => {
    if (item.in_progress) return 0;
    if (String(item.status) === "adopted") return 1;
    if (
      String(item.status) === "proposed" &&
      item.auto_eligible &&
      String(item.family) === "t_surface"
    ) {
      return 2;
    }
    return 3;
  };

  return [...open].sort((a, b) => {
    const bd = band(a) - band(b);
    if (bd !== 0) return bd;
    const oa = Number(a.sort_order || 0);
    const ob = Number(b.sort_order || 0);
    if (oa !== ob) return oa - ob;
    return String(a.created_at || "").localeCompare(String(b.created_at || ""));
  });
}

/** In-progress annotation: expert+Graph or expert if Free. */
export function worksetInProgressLabel(item: WorksetItem): string {
  const expert =
    String(item.expert_name || item.expert_id || item.suggested_expert || "").trim() ||
    "Expert";
  const mode = String(item.work_mode || "").toLowerCase();
  const gid = String(item.graph_id || "").trim();
  if (gid || mode === "graph" || mode.startsWith("hard_graph")) {
    return `${expert} · ${gid || "Graph"}`;
  }
  return expert;
}

export function worksetFamilyLabel(family: string): string {
  if (family === "t_host") return "主机";
  if (family === "t_surface") return "面";
  return family || "项";
}

export function worksetStatusLabel(status: string): string {
  switch (status) {
    case "proposed":
      return "待确认";
    case "adopted":
      return "已采纳";
    case "done":
      return "完成";
    case "rejected":
      return "已拒绝";
    default:
      return status || "";
  }
}

export function parseWorksetProjection(raw: unknown): WorksetProjection {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { items: [], open_count: 0 };
  }
  const o = raw as Record<string, unknown>;
  const items = Array.isArray(o.items)
    ? (o.items.filter((i) => i && typeof i === "object") as WorksetItem[])
    : [];
  const closed = Array.isArray(o.closed_items)
    ? (o.closed_items.filter((i) => i && typeof i === "object") as WorksetItem[])
    : [];
  return {
    version: typeof o.version === "number" ? o.version : 1,
    items: orderWorksetItems(items),
    open_count: typeof o.open_count === "number" ? o.open_count : items.length,
    all_items: Array.isArray(o.all_items) ? (o.all_items as WorksetItem[]) : undefined,
    closed_items: closed,
    goal: o.goal && typeof o.goal === "object" ? (o.goal as WorksetProjection["goal"]) : null,
  };
}

/** True when projection has anything useful to show (open or goal residual). */
export function worksetHasVisibleContent(ws: WorksetProjection): boolean {
  if ((ws.items || []).length > 0) return true;
  if ((ws.closed_items || []).length > 0 && ws.goal?.terminal) return true;
  if (ws.goal?.residual) return true;
  return false;
}

/**
 * Spec #311 US3: id of the single in-progress Workset baton, if any.
 * Used when sending user_message so platform task_assign can refresh annotation
 * (system/Goal baton — not user Next chrome).
 */
export function currentInProgressWorksetItemId(
  ws: WorksetProjection | Record<string, unknown> | null | undefined,
): string | null {
  if (!ws || typeof ws !== "object") return null;
  const raw = ws as WorksetProjection | Record<string, unknown>;
  const list = Array.isArray((raw as WorksetProjection).items)
    ? (raw as WorksetProjection).items
    : Array.isArray((raw as { all_items?: WorksetItem[] }).all_items)
      ? ((raw as { all_items?: WorksetItem[] }).all_items as WorksetItem[])
      : [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    if (item.in_progress && String(item.id || "").trim()) {
      return String(item.id).trim();
    }
  }
  return null;
}
