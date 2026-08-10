/**
 * Attack surface tree UI.
 * Spec #408 L5 density + #409 operator projection: NEW + TESTED; no SEEN/BOOK/PRIOR chips.
 */
import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Search } from "lucide-react";
import type { SecurityVulnerability } from "../lib/securityTypes";
import type { SurfaceEntry } from "../lib/surfaceModel";
import {
  normalizeSurfaceStatus,
  preferSurfaceStatus,
  surfaceMethodChips,
  surfaceShowsStatusChip,
  surfaceStatusBadgeClass,
  surfaceStatusLabel,
} from "../lib/surfaceModel";
import {
  dedupeFindingTags,
  findingTagClass,
  openFindingFromTag,
  type SurfaceFindingTag,
} from "../lib/findingKinds";

export type SurfaceTreeNode = {
  id: string;
  label: string;
  path: string;
  /** origin (scheme://host:port) | path | service — ports are not intermediate nodes */
  nodeKind?: "host" | "port" | "path" | "service" | "origin";
  service?: string;
  /** Extra hostnames/IPs for the same asset (shown muted on the root). */
  aliases?: string[];
  isTarget?: boolean;
  isDiscovered?: boolean;
  children: SurfaceTreeNode[];
  /** Leaf payload (web route or non-web service). */
  entries: SurfaceEntry[];
  /** Methods stay in the data model (search / tools); not rendered as tree chips (#408 L5). */
  methods: string[];
  /** Spec #384: highest v2 internal status among own entries (seen | touched | booked | …). */
  status?: string;
  /** Spec #409: true when any own entry is inventory-new (false-safe). */
  isNew?: boolean;
  leafCount: number;
  /** Entries under this node still in seen/touched (not terminal booked/deadend/skipped_roe). */
  unfinishedCount: number;
  findingTags: SurfaceFindingTag[];
  subtreeFindingTags: SurfaceFindingTag[];
};

/** Spec #408 L5 + #409: pure row chrome — methods off; operator NEW/TESTED; collapsed parents use counts. */
export type SurfaceTreeRowChrome = {
  showMethods: boolean;
  findingMode: "tags" | "count";
  tags: SurfaceFindingTag[];
  extraTagCount: number;
  findingCount: number;
  /** Operator status chip (TESTED / terminals only — never SEEN/BOOK/PRIOR). */
  showStatusChip: boolean;
  /** Inventory novelty badge (only when flagged). */
  showNewBadge: boolean;
  unfinishedCount: number;
};

/** True when status still represents unfinished exercise (not booked / terminal). */
function isUnfinishedSurfaceStatus(status?: string | null): boolean {
  const n = normalizeSurfaceStatus(status);
  if (!n) return true;
  return n === "seen" || n === "touched";
}

/**
 * Decide what a Surface tree row should show.
 * Methods never chip on the tree by default; collapsed parents roll up to counts.
 * Operator status: TESTED for touched family; no SEEN/BOOK; NEW only when flagged (#409).
 */
export function surfaceTreeRowChrome(
  node: SurfaceTreeNode,
  opts: { open: boolean },
): SurfaceTreeRowChrome {
  const hasChildren = node.children.length > 0;
  const collapsedParent = hasChildren && !opts.open;
  const allPreview = dedupeFindingTags([...node.findingTags, ...node.subtreeFindingTags]);
  const unfinishedCount = node.unfinishedCount ?? 0;

  if (collapsedParent) {
    return {
      showMethods: false,
      findingMode: "count",
      tags: [],
      extraTagCount: 0,
      findingCount: allPreview.length,
      // Max-status alone hides unfinished children — prefer unfinished count instead.
      showStatusChip: false,
      showNewBadge: false,
      unfinishedCount,
    };
  }

  // Leaf, or expanded parent: own finding tags only (not full subtree stack).
  const tagsSource = hasChildren ? node.findingTags : allPreview;
  const tags = tagsSource.slice(0, 3);
  const extraTagCount = Math.max(0, tagsSource.length - tags.length);
  // Operator projection: empty label for seen/booked ⇒ no chip.
  const showStatusChip = surfaceShowsStatusChip(node.status);
  // Leaf novelty only (own entries / node flag); not subtree flood on expanded parents without own NEW.
  const showNewBadge = Boolean(node.isNew);

  return {
    showMethods: false,
    findingMode: "tags",
    tags,
    extraTagCount,
    findingCount: tagsSource.length,
    showStatusChip,
    showNewBadge,
    unfinishedCount,
  };
}

/** Spec D2: tree root = scheme://host:port (different ports = different roots). */
export function entryOriginRootKey(entry: SurfaceEntry): string {
  const explicit = String(entry.originKey || entry.assetKey || "").trim().toLowerCase();
  if (explicit.includes("://")) return explicit;
  const host = String(entry.host || "").trim().toLowerCase();
  const port = String(entry.port || "").trim();
  let scheme = String(entry.scheme || "").trim().toLowerCase();
  if (!scheme) {
    if (entry.service && entry.service !== "web") scheme = entry.service.toLowerCase();
    else if (port === "443") scheme = "https";
    else scheme = "http";
  }
  if (host && port) return `${scheme}://${host}:${port}`;
  if (host) return `${scheme}://${host}`;
  const origin = String(entry.origin || "").trim().toLowerCase();
  if (origin.includes("://")) return origin;
  if (origin) return `${scheme}://${origin}`;
  return "unknown";
}

function absorbEntryStatus(node: SurfaceTreeNode, entry: SurfaceEntry): void {
  const next = preferSurfaceStatus(node.status, entry.status);
  if (next) node.status = next;
  if (entry.isNew) node.isNew = true;
}

function pathSegments(path: string): string[] {
  const raw = String(path || "").trim();
  if (!raw || raw === "/") return [];
  return raw.split("/").map((s) => s.trim()).filter(Boolean);
}

export function buildSurfaceTree(
  items: SurfaceEntry[],
  findingsByPath: Map<string, SurfaceFindingTag[]> = new Map(),
): SurfaceTreeNode[] {
  // One root per scheme://host:port (Spec D2) — not bare hostname.
  const origins = new Map<string, SurfaceTreeNode>();

  const ensureOrigin = (entry: SurfaceEntry): SurfaceTreeNode => {
    const originKey = entryOriginRootKey(entry);
    let node = origins.get(originKey);
    if (node) {
      if (entry.isTarget) {
        node.isTarget = true;
        node.isDiscovered = false;
      } else if (entry.isDiscovered && !node.isTarget) {
        node.isDiscovered = true;
      }
      absorbEntryStatus(node, entry);
      return node;
    }
    const label =
      entry.originKey ||
      entry.assetLabel ||
      (entry.scheme && entry.host && entry.port
        ? `${entry.scheme}://${entry.host}:${entry.port}`
        : entry.origin.includes("://")
          ? entry.origin
          : originKey);
    node = {
      id: `origin:${originKey}`,
      label,
      path: label,
      nodeKind: "origin",
      service: entry.service,
      aliases: [],
      isTarget: Boolean(entry.isTarget),
      isDiscovered: Boolean(entry.isDiscovered) && !entry.isTarget,
      children: [],
      entries: [],
      methods: [],
      status: undefined,
      leafCount: 0,
      unfinishedCount: 0,
      findingTags: [],
      subtreeFindingTags: [],
    };
    absorbEntryStatus(node, entry);
    origins.set(originKey, node);
    return node;
  };

  for (const entry of items) {
    const originNode = ensureOrigin(entry);

    if (entry.service !== "web") {
      // Non-HTTP service: leaf on the origin root (no path children).
      originNode.entries.push(entry);
      absorbEntryStatus(originNode, entry);
      const tags = findingsByPath.get(entry.key.toLowerCase()) || [];
      originNode.findingTags = dedupeFindingTags([...originNode.findingTags, ...tags]);
      continue;
    }

    const segs = pathSegments(entry.path);
    if (segs.length === 0) {
      // Web root of this origin
      originNode.entries.push(entry);
      absorbEntryStatus(originNode, entry);
      for (const m of surfaceMethodChips(entry.method)) {
        if (!originNode.methods.includes(m)) originNode.methods.push(m);
      }
      const tags = findingsByPath.get(entry.key.toLowerCase()) || [];
      originNode.findingTags = dedupeFindingTags([...originNode.findingTags, ...tags]);
      continue;
    }

    let cursor = originNode;
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i]!;
      const childId = `${originNode.id}|/${segs.slice(0, i + 1).join("/")}`;
      let child = cursor.children.find((c) => c.id === childId);
      if (!child) {
        child = {
          id: childId,
          label: seg,
          path: `/${segs.slice(0, i + 1).join("/")}`,
          nodeKind: "path",
          service: "web",
          children: [],
          entries: [],
          methods: [],
          status: undefined,
          leafCount: 0,
          unfinishedCount: 0,
          findingTags: [],
          subtreeFindingTags: [],
        };
        cursor.children.push(child);
      }
      cursor = child;
    }
    cursor.entries.push(entry);
    absorbEntryStatus(cursor, entry);
    for (const m of surfaceMethodChips(entry.method)) {
      if (!cursor.methods.includes(m)) cursor.methods.push(m);
    }
    const tags = findingsByPath.get(entry.key.toLowerCase()) || [];
    cursor.findingTags = dedupeFindingTags([...cursor.findingTags, ...tags]);
  }

  const finalize = (node: SurfaceTreeNode): number => {
    let leaves = node.entries.length > 0 ? Math.max(1, node.entries.length) : 0;
    if (node.nodeKind === "path" && node.entries.length) leaves = 1;
    if (node.nodeKind === "service" && node.entries.length) leaves = 1;
    let subtreeTags = [...node.findingTags];
    const methods = new Set(node.methods);
    let unfinished = 0;
    for (const e of node.entries) {
      if (isUnfinishedSurfaceStatus(e.status)) unfinished += 1;
    }
    for (const child of node.children) {
      leaves += finalize(child);
      for (const m of child.methods) methods.add(m);
      subtreeTags = subtreeTags.concat(child.subtreeFindingTags);
      unfinished += child.unfinishedCount || 0;
      // Bubble status from children (data only; collapsed UI prefers counts — #408)
      const bubbled = preferSurfaceStatus(node.status, child.status);
      if (bubbled) node.status = bubbled;
    }
    // Origin root with only root-path entries still counts
    if (node.nodeKind === "origin" && node.entries.length && !node.children.length) {
      leaves = Math.max(leaves, 1);
    }
    node.leafCount = leaves;
    node.unfinishedCount = unfinished;
    node.subtreeFindingTags = dedupeFindingTags(subtreeTags);
    // Methods remain available for search / tool payloads; not rendered as tree chips.
    node.methods = Array.from(methods);
    node.children.sort((a, b) => {
      const af = a.subtreeFindingTags.length;
      const bf = b.subtreeFindingTags.length;
      if (bf !== af) return bf - af;
      return a.label.localeCompare(b.label);
    });
    return leaves;
  };

  const roots = Array.from(origins.values());
  for (const h of roots) finalize(h);
  roots.sort((a, b) => {
    if (a.isTarget !== b.isTarget) return a.isTarget ? -1 : 1;
    if (a.isDiscovered !== b.isDiscovered) return a.isDiscovered ? 1 : -1;
    return a.label.localeCompare(b.label);
  });
  return roots;
}

export type SurfaceKindFilter = "all" | "vuln" | "key" | "flag" | "findings";

export function SurfaceTreeView({
  roots,
  total,
  linkedCount = 0,
  findingsTotal = 0,
  kindCounts = { vuln: 0, flag: 0, key: 0 },
  unlinked = [],
  onOpenVulnerability,
}: {
  roots: SurfaceTreeNode[];
  total: number;
  /** Unique findings successfully hung on a route. */
  linkedCount?: number;
  /** Same as Findings tab unique count (findings.length). */
  findingsTotal?: number;
  /** Chip counts by kind — exclusive, matches Findings Vuln / Key / Flags. */
  kindCounts?: { vuln: number; flag: number; key: number };
  unlinked?: SurfaceFindingTag[];
  onOpenVulnerability?: (finding: Partial<SecurityVulnerability>) => void;
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<SurfaceKindFilter>("all");

  const filterActive = Boolean(query.trim()) || kindFilter !== "all";

  const filteredRoots = useMemo(
    () => filterSurfaceTree(roots, query, kindFilter),
    [roots, query, kindFilter],
  );

  const filteredUnlinked = useMemo(() => {
    const q = query.trim().toLowerCase();
    return unlinked.filter((tag) => {
      if (kindFilter === "vuln" && tag.kind !== "vuln") return false;
      if (kindFilter === "key" && tag.kind !== "key") return false;
      if (kindFilter === "flag" && tag.kind !== "flag") return false;
      // "findings" and "all" keep unlinked (they are findings without a path)
      if (!q) return true;
      return `${tag.label} ${tag.title} ${tag.kind}`.toLowerCase().includes(q);
    });
  }, [unlinked, query, kindFilter]);

  const isOpen = (node: SurfaceTreeNode, depth: number) => {
    if (collapsed[node.id] !== undefined) return !collapsed[node.id];
    // Expand matches while searching / filtering so hits are visible.
    if (filterActive) return true;
    if (node.subtreeFindingTags.length > 0 && depth < 4) return true;
    return depth < 2;
  };

  const toggle = (id: string, depth: number, node: SurfaceTreeNode) => {
    setCollapsed((prev) => {
      const currentlyOpen = prev[id] !== undefined ? !prev[id] : isOpen(node, depth);
      return { ...prev, [id]: currentlyOpen };
    });
  };

  const unlinkedCount = filteredUnlinked.length;
  const visibleLeafHint = filterActive
    ? countSurfaceLeaves(filteredRoots)
    : total;

  const filterChips: Array<{ id: SurfaceKindFilter; label: string; count: number; title?: string }> = [
    { id: "all", label: "All", count: total, title: `${total} surfaces · ${findingsTotal} findings · ${linkedCount} linked` },
    { id: "findings", label: "Findings", count: findingsTotal, title: "Only routes with linked findings" },
    { id: "vuln", label: "Vuln", count: kindCounts.vuln },
    { id: "key", label: "Key", count: kindCounts.key },
    { id: "flag", label: "Flag", count: kindCounts.flag },
  ];

  return (
    <div className="space-y-2.5">
      <div className="space-y-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-muted" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search host, path, finding…"
            className="w-full rounded-md border border-hairline-soft bg-canvas-inset py-1.5 pl-7 pr-2 text-xs text-ink placeholder:text-ink-muted focus:border-hairline focus:outline-none"
            aria-label="Search attack surface"
          />
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {filterChips.map((chip) => {
            const active = kindFilter === chip.id;
            const empty = chip.id !== "all" && chip.count === 0;
            return (
              <button
                key={chip.id}
                type="button"
                disabled={empty}
                title={chip.title}
                onClick={() => setKindFilter(chip.id)}
                className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                  active
                    ? chip.id === "flag"
                      ? "bg-status-success/15 text-status-success"
                      : chip.id === "key"
                        ? "bg-status-running/12 text-status-running"
                        : chip.id === "vuln"
                          ? "bg-severity-high-subtle text-severity-high"
                          : "bg-ink text-on-ink"
                    : "bg-canvas-inset text-ink-muted hover:bg-surface-default hover:text-ink"
                }`}
              >
                <span>{chip.label}</span>
                <span className={active && chip.id === "all" ? "opacity-80" : "opacity-70"}>{chip.count}</span>
              </button>
            );
          })}
          {filterActive && (
            <span className="ml-auto font-mono text-[10px] text-ink-muted">
              {visibleLeafHint} match{visibleLeafHint === 1 ? "" : "es"}
            </span>
          )}
        </div>
      </div>

      {filteredRoots.length === 0 && unlinkedCount === 0 ? (
        <p className="py-4 text-center text-xs text-ink-muted">No surfaces match this search / filter</p>
      ) : (
        <div className="space-y-0.5">
          {filteredRoots.map((node) => (
            <SurfaceTreeNodeRow
              key={node.id}
              node={node}
              depth={0}
              isOpen={isOpen}
              onToggle={toggle}
              onOpenVulnerability={onOpenVulnerability}
            />
          ))}
        </div>
      )}

      {unlinkedCount > 0 && (
        <section className="space-y-1.5 border-t border-hairline-soft pt-3">
          <p className="text-xs font-medium text-ink-muted">
            Unlinked findings ({unlinkedCount})
          </p>
          <p className="text-[11px] text-ink-muted">
            Included in Findings count but no route path to attach.
          </p>
          <div className="space-y-1">
            {filteredUnlinked.map((tag) => (
              <button
                key={tag.id}
                type="button"
                title={tag.title}
                onClick={() => onOpenVulnerability?.(openFindingFromTag(tag))}
                className="flex w-full min-w-0 items-center gap-1.5 rounded-md px-1 py-1 text-left hover:bg-surface-default"
              >
                <span className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase ${findingTagClass(tag)}`}>
                  {tag.label}
                </span>
                <span className="min-w-0 truncate text-[12px] text-ink">{tag.title}</span>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function surfaceTagMatchesKind(tag: SurfaceFindingTag, kind: SurfaceKindFilter): boolean {
  if (kind === "all" || kind === "findings") return true;
  return tag.kind === kind;
}

function surfaceNodeSearchBlob(node: SurfaceTreeNode): string {
  const parts = [
    node.label,
    node.path,
    node.service || "",
    ...(node.aliases || []),
    ...node.methods,
    ...node.findingTags.flatMap((t) => [t.label, t.title, t.kind]),
    ...(node.entries || []).flatMap((e) => [e.key, e.title || "", e.path, e.origin, e.host]),
  ];
  return parts.join(" ").toLowerCase();
}

function filterSurfaceTree(
  roots: SurfaceTreeNode[],
  query: string,
  kind: SurfaceKindFilter,
): SurfaceTreeNode[] {
  const q = query.trim().toLowerCase();
  if (!q && kind === "all") return roots;

  const filterNode = (node: SurfaceTreeNode): SurfaceTreeNode | null => {
    const children = node.children
      .map((child) => filterNode(child))
      .filter((child): child is SurfaceTreeNode => child != null);

    const ownTags = node.findingTags.filter((t) => surfaceTagMatchesKind(t, kind));
    const searchSelf = !q || surfaceNodeSearchBlob(node).includes(q);

    // Keep ancestors of matching descendants.
    if (children.length > 0) {
      const subtreeTags = dedupeFindingTags([
        ...ownTags,
        ...children.flatMap((c) => c.subtreeFindingTags),
      ]);
      return {
        ...node,
        children,
        findingTags: kind === "all" ? node.findingTags : ownTags,
        subtreeFindingTags: kind === "all"
          ? dedupeFindingTags([...node.findingTags, ...children.flatMap((c) => c.subtreeFindingTags)])
          : subtreeTags,
        leafCount: children.reduce((n, c) => n + (c.leafCount || 0), 0) || node.leafCount,
      };
    }

    // Leaf (no surviving children)
    if (q && !searchSelf) return null;
    if (kind === "findings" && ownTags.length === 0) return null;
    if (kind !== "all" && kind !== "findings" && ownTags.length === 0) return null;

    return {
      ...node,
      children: [],
      findingTags: kind === "all" ? node.findingTags : ownTags,
      subtreeFindingTags: kind === "all" ? node.subtreeFindingTags : ownTags,
    };
  };

  return roots.map(filterNode).filter((n): n is SurfaceTreeNode => n != null);
}

function countSurfaceLeaves(roots: SurfaceTreeNode[]): number {
  let n = 0;
  const walk = (node: SurfaceTreeNode) => {
    if (!node.children.length) {
      n += 1;
      return;
    }
    for (const c of node.children) walk(c);
  };
  for (const r of roots) walk(r);
  return n;
}

function SurfaceTreeNodeRow({
  node,
  depth,
  isOpen,
  onToggle,
  onOpenVulnerability,
}: {
  node: SurfaceTreeNode;
  depth: number;
  isOpen: (node: SurfaceTreeNode, depth: number) => boolean;
  onToggle: (id: string, depth: number, node: SurfaceTreeNode) => void;
  onOpenVulnerability?: (finding: Partial<SecurityVulnerability>) => void;
}) {
  const hasChildren = node.children.length > 0;
  const hasEntries = (node.entries?.length || 0) > 0;
  if (!hasChildren && !hasEntries && !(node.findingTags?.length || 0)) return null;

  const open = isOpen(node, depth);
  const canExpand = hasChildren;
  const paddingLeft = 8 + depth * 12;
  const chrome = surfaceTreeRowChrome(node, { open });
  const allPreviewTitles = dedupeFindingTags([...node.findingTags, ...node.subtreeFindingTags])
    .map((t) => t.title)
    .join("\n");

  const displayLabel =
    node.nodeKind === "path" ? `/${node.label}` : node.label;
  const serviceBadge =
    node.service && node.service !== "web" && (node.nodeKind === "port" || node.nodeKind === "service")
      ? node.service.toUpperCase()
      : node.nodeKind === "port" && node.service === "web"
        ? "WEB"
        : "";

  return (
    <div>
      <div
        className="flex min-w-0 items-center gap-1 rounded-md px-1 py-1 hover:bg-surface-default"
        style={{ paddingLeft }}
      >
        {canExpand ? (
          <button
            type="button"
            aria-label={open ? "Collapse" : "Expand"}
            onClick={() => onToggle(node.id, depth, node)}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-ink-muted hover:bg-canvas-inset hover:text-ink"
          >
            {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          </button>
        ) : (
          <span className="inline-block h-5 w-5 shrink-0" />
        )}
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <button
            type="button"
            onClick={() => canExpand && onToggle(node.id, depth, node)}
            className="flex min-w-0 items-center gap-1.5 text-left"
          >
            <span className="truncate font-mono text-[13px] font-medium text-ink">{displayLabel}</span>
            {(node.nodeKind === "host" || node.nodeKind === "origin") && node.isTarget && (
              <span className="shrink-0 rounded bg-status-running/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide text-status-running">
                Target
              </span>
            )}
            {(node.nodeKind === "host" || node.nodeKind === "origin") && node.isDiscovered && !node.isTarget && (
              <span className="shrink-0 rounded bg-canvas-inset px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase text-ink-muted">
                Discovered
              </span>
            )}
            {serviceBadge && (
              <span className="shrink-0 rounded bg-status-running/10 px-1 py-0.5 font-mono text-[10px] font-medium uppercase text-status-running">
                {serviceBadge}
              </span>
            )}
            {(node.nodeKind === "host" || node.nodeKind === "origin") && node.aliases && node.aliases.length > 0 && (
              <span
                className="min-w-0 truncate font-mono text-[10px] text-ink-muted"
                title={node.aliases.join(", ")}
              >
                ≈ {node.aliases.slice(0, 2).join(", ")}
                {node.aliases.length > 2 ? ` +${node.aliases.length - 2}` : ""}
              </span>
            )}
            {hasChildren && node.leafCount > 0 && (
              <span className="shrink-0 font-mono text-[10px] text-ink-muted">{node.leafCount}</span>
            )}
            {/* Spec #408 L5: HTTP method chips are not rendered on the Surface tree. */}
            {chrome.findingMode === "count" && chrome.unfinishedCount > 0 && (
              <span
                className="shrink-0 font-mono text-[10px] text-ink-muted"
                data-testid="surface-unfinished-count"
                title="Surfaces not yet TESTED (or only first-touch) under this branch"
              >
                {chrome.unfinishedCount} unfinished
              </span>
            )}
            {chrome.findingMode === "count" && chrome.findingCount > 0 && (
              <span
                className="shrink-0 rounded bg-severity-high-subtle px-1 py-0.5 font-mono text-[10px] font-medium text-severity-high"
                data-testid="surface-finding-count"
                title={allPreviewTitles}
              >
                {chrome.findingCount} finding{chrome.findingCount === 1 ? "" : "s"}
              </span>
            )}
            {/* Spec #409: NEW only when inventory novelty flag true (false-safe until #410). */}
            {chrome.showNewBadge && (
              <span
                className="shrink-0 rounded bg-status-success/15 px-1 py-0.5 font-mono text-[10px] font-medium uppercase text-status-success"
                data-testid="surface-new"
              >
                NEW
              </span>
            )}
            {/* Spec #409: TESTED for touched family; never SEEN/BOOK/PRIOR; terminals muted. */}
            {chrome.showStatusChip && surfaceStatusLabel(node.status) && (
              <span
                className={`shrink-0 rounded px-1 py-0.5 font-mono text-[10px] font-medium uppercase ${surfaceStatusBadgeClass(node.status)}`}
                data-testid="surface-status"
                data-status={surfaceStatusLabel(node.status)}
              >
                {surfaceStatusLabel(node.status)}
              </span>
            )}
          </button>
          {chrome.findingMode === "tags" && chrome.tags.length > 0 && (
            <span className="flex min-w-0 flex-wrap items-center gap-0.5">
              {chrome.tags.map((tag) => (
                <button
                  key={tag.id}
                  type="button"
                  title={tag.title}
                  onClick={() => onOpenVulnerability?.(openFindingFromTag(tag))}
                  className={`inline-block shrink-0 rounded px-1 py-0.5 font-mono text-[10px] font-medium uppercase ${findingTagClass(tag)} hover:opacity-90`}
                >
                  {tag.label}
                </button>
              ))}
              {chrome.extraTagCount > 0 && (
                <span className="font-mono text-[10px] text-ink-muted" title={allPreviewTitles}>
                  +{chrome.extraTagCount}
                </span>
              )}
            </span>
          )}
        </div>
      </div>

      {open && hasChildren && (
        <div>
          {node.children.map((child) => (
            <SurfaceTreeNodeRow
              key={child.id}
              node={child}
              depth={depth + 1}
              isOpen={isOpen}
              onToggle={onToggle}
              onOpenVulnerability={onOpenVulnerability}
            />
          ))}
        </div>
      )}
    </div>
  );
}


