/**
 * Attack surface tree UI.
 * Spec #408 L5 density + #409/#413 operator projection: NEW + TESTED; no SEEN/BOOK/PRIOR chips.
 * Toolbar aligned with Traffic: search + single view filter (All / NEW / Untested / Findings).
 */
import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Plus } from "lucide-react";
import { authFetch } from "../lib/api";
import type { SecurityVulnerability } from "../lib/securityTypes";
import type { SurfaceEntry } from "../lib/surfaceModel";
import ConfirmDialog from "./ConfirmDialog";
import {
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
  /**
   * Spec #413: true when any own entry has case_tested (purpose=test traffic this Case).
   * When false explicitly on leaves with the flag dual-written, suppress multi-hit TESTED.
   */
  caseTested?: boolean;
  leafCount: number;
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
};

/**
 * Decide what a Surface tree row should show.
 * Methods never chip on the tree by default; collapsed parents roll up to finding counts.
 * Operator status: TESTED from case_tested (#413); no SEEN/BOOK; NEW only when flagged (#409).
 * NEW/TESTED only on nodes that own surface entries (identity) — not origin/path parents
 * that merely aggregate children (even when expanded).
 */
export function surfaceTreeRowChrome(
  node: SurfaceTreeNode,
  opts: { open: boolean },
): SurfaceTreeRowChrome {
  const hasChildren = node.children.length > 0;
  const collapsedParent = hasChildren && !opts.open;
  const allPreview = dedupeFindingTags([...node.findingTags, ...node.subtreeFindingTags]);
  // Identity chips: own ledger entries only, never on structural origin/host/port roots
  // (even when TARGET seed attaches path=/ to the origin row — that lives on a "/" child).
  const isStructuralRoot =
    node.nodeKind === "origin" || node.nodeKind === "host" || node.nodeKind === "port";
  const isIdentity = !isStructuralRoot && (node.entries?.length || 0) > 0;

  if (collapsedParent) {
    return {
      showMethods: false,
      findingMode: "count",
      tags: [],
      extraTagCount: 0,
      findingCount: allPreview.length,
      // Collapsed: leafCount + findings count only (no max-status / unfinished).
      showStatusChip: false,
      showNewBadge: false,
    };
  }

  // Leaf, or expanded parent: own finding tags only (not full subtree stack).
  const tagsSource = hasChildren ? node.findingTags : allPreview;
  const tags = tagsSource.slice(0, 3);
  const extraTagCount = Math.max(0, tagsSource.length - tags.length);
  // Spec #413: TESTED from case_tested when known; legacy falls back to status=touched.
  const labelOpts =
    node.caseTested === true
      ? { caseTested: true as const }
      : node.caseTested === false
        ? { caseTested: false as const }
        : undefined;
  const showStatusChip = isIdentity && surfaceShowsStatusChip(node.status, labelOpts);
  // Own-entry novelty only — never on origin aggregator.
  const showNewBadge = isIdentity && Boolean(node.isNew);

  return {
    showMethods: false,
    findingMode: "tags",
    tags,
    extraTagCount,
    findingCount: tagsSource.length,
    showStatusChip,
    showNewBadge,
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
  // Spec #413: sticky case_tested for operator TESTED chip.
  if (entry.caseTested === true) node.caseTested = true;
  else if (entry.caseTested === false && node.caseTested !== true) {
    // Preserve explicit false only when no sibling has tested yet.
    if (node.caseTested === undefined) node.caseTested = false;
  }
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
      // Do not absorb entry status here — only when the entry is attached to this
      // node (root path / non-web). Child paths must not stamp NEW/TESTED on origin.
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
      findingTags: [],
      subtreeFindingTags: [],
    };
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
    // Web root path "/" is an explicit path child — origin row stays structural only
    // (no NEW/TESTED chips on the host:port root from TARGET seed / browse of /).
    let cursor = originNode;
    if (segs.length === 0) {
      const rootId = `${originNode.id}|/`;
      let rootPath = cursor.children.find((c) => c.id === rootId);
      if (!rootPath) {
        rootPath = {
          id: rootId,
          label: "",
          path: "/",
          nodeKind: "path",
          service: "web",
          children: [],
          entries: [],
          methods: [],
          status: undefined,
          leafCount: 0,
          findingTags: [],
          subtreeFindingTags: [],
        };
        cursor.children.push(rootPath);
      }
      cursor = rootPath;
    } else {
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
            findingTags: [],
            subtreeFindingTags: [],
          };
          cursor.children.push(child);
        }
        cursor = child;
      }
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
    for (const child of node.children) {
      leaves += finalize(child);
      for (const m of child.methods) methods.add(m);
      subtreeTags = subtreeTags.concat(child.subtreeFindingTags);
      // Bubble status from children (data only; collapsed UI uses leafCount — #408)
      const bubbled = preferSurfaceStatus(node.status, child.status);
      if (bubbled) node.status = bubbled;
    }
    // Origin root with only root-path entries still counts
    if (node.nodeKind === "origin" && node.entries.length && !node.children.length) {
      leaves = Math.max(leaves, 1);
    }
    node.leafCount = leaves;
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

/**
 * Operator coverage view filter (Surface toolbar).
 * Replaces legacy Findings-kind chips (Vuln/Key/Flag) — those live on Findings tab.
 */
export type SurfaceViewFilter = "all" | "new" | "untested" | "findings";
/** @deprecated Use SurfaceViewFilter — kept for import compatibility. */
export type SurfaceKindFilter = SurfaceViewFilter;

export type SurfaceKnownAsset = {
  address: string;
  aliases?: string[];
  ports?: string[];
};

/** Parse origin/host row into ledger Host + port. Origin is scheme://host:port. */
export function parseOriginEnrollTarget(node: SurfaceTreeNode): { host: string; port: string } | null {
  if (node.nodeKind !== "origin" && node.nodeKind !== "host") return null;
  const raw = node.id.startsWith("origin:") ? node.id.slice("origin:".length) : node.label || node.path;
  if (!raw) return null;
  try {
    const href = raw.includes("://") ? raw : `http://${raw}`;
    const url = new URL(href);
    const host = String(url.hostname || "").trim();
    if (!host) return null;
    const port =
      String(url.port || "").trim() || (url.protocol === "https:" ? "443" : url.protocol === "http:" ? "80" : "");
    if (!port) return null;
    return { host, port };
  } catch {
    return null;
  }
}

function normalizeHostKey(value: string): string {
  return value.trim().toLowerCase();
}

export function knownAssetIndex(assets: SurfaceKnownAsset[]): { hosts: Set<string>; hostPorts: Set<string> } {
  const hosts = new Set<string>();
  const hostPorts = new Set<string>();
  for (const asset of assets) {
    const names = [asset.address, ...(asset.aliases || [])]
      .map((n) => normalizeHostKey(String(n || "")))
      .filter(Boolean);
    const ports = (asset.ports || []).map((p) => String(p).trim()).filter(Boolean);
    for (const name of names) {
      hosts.add(name);
      for (const port of ports) hostPorts.add(`${name}:${port}`);
    }
  }
  return { hosts, hostPorts };
}

function hostPortEnrolled(
  host: string,
  port: string,
  index: { hosts: Set<string>; hostPorts: Set<string> },
  extra: Set<string>,
): boolean {
  const key = `${normalizeHostKey(host)}:${port}`;
  return extra.has(key) || index.hostPorts.has(key);
}

export function SurfaceTreeView({
  roots,
  total,
  findingsTotal = 0,
  unlinked = [],
  knownAssets = [],
  onOpenVulnerability,
  onEnrolledAsset,
}: {
  roots: SurfaceTreeNode[];
  total: number;
  /** Same as Findings tab unique count (findings.length) — for Findings option title. */
  findingsTotal?: number;
  /** @deprecated unused; kept so callers can pass linkedCount without TS noise. */
  linkedCount?: number;
  /** @deprecated unused; Findings-kind chips removed from Surface toolbar. */
  kindCounts?: { vuln: number; flag: number; key: number };
  unlinked?: SurfaceFindingTag[];
  /** Owner-ledger Hosts already in the library (address + aliases + ports). */
  knownAssets?: SurfaceKnownAsset[];
  onOpenVulnerability?: (finding: Partial<SecurityVulnerability>) => void;
  onEnrolledAsset?: (asset: Record<string, unknown>) => void;
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState("");
  const [viewFilter, setViewFilter] = useState<SurfaceViewFilter>("all");
  const [enrolledKeys, setEnrolledKeys] = useState<Set<string>>(() => new Set());
  const [enrollTarget, setEnrollTarget] = useState<{ host: string; port: string; label: string } | null>(null);
  const [enrolling, setEnrolling] = useState(false);
  const [enrollError, setEnrollError] = useState("");
  const knownIndex = useMemo(() => knownAssetIndex(knownAssets), [knownAssets]);

  const filterActive = Boolean(query.trim()) || viewFilter !== "all";
  const stats = useMemo(() => countSurfaceViewStats(roots), [roots]);

  const filteredRoots = useMemo(
    () => filterSurfaceTree(roots, query, viewFilter),
    [roots, query, viewFilter],
  );

  // Unlinked findings are not Surface identities — only show under All / Findings.
  const filteredUnlinked = useMemo(() => {
    if (viewFilter === "new" || viewFilter === "untested") return [];
    const q = query.trim().toLowerCase();
    return unlinked.filter((tag) => {
      if (!q) return true;
      return `${tag.label} ${tag.title} ${tag.kind}`.toLowerCase().includes(q);
    });
  }, [unlinked, query, viewFilter]);

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

  const enrollOrigin = async () => {
    if (!enrollTarget) return;
    setEnrolling(true);
    setEnrollError("");
    try {
      const created = await authFetch<Record<string, unknown>>("/api/assets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          address: enrollTarget.host,
          ports: [enrollTarget.port],
        }),
      });
      setEnrolledKeys((prev) => new Set(prev).add(`${normalizeHostKey(enrollTarget.host)}:${enrollTarget.port}`));
      onEnrolledAsset?.(created);
      setEnrollTarget(null);
    } catch (err) {
      setEnrollError(err instanceof Error ? err.message : "纳入资产库失败");
    } finally {
      setEnrolling(false);
    }
  };

  return (
    <div className="space-y-2" data-testid="surface-tree">
      {/* Match Traffic toolbar: search + single select filter. */}
      <div className="flex flex-wrap items-center gap-2" data-testid="surface-toolbar">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search host, path, finding…"
          data-testid="surface-search"
          className="min-w-0 flex-1 rounded-md border border-hairline bg-canvas px-2.5 py-1.5 text-[12px] text-ink placeholder:text-ink-muted outline-none focus:border-ink"
          aria-label="Search attack surface"
        />
        <select
          value={viewFilter}
          onChange={(e) => setViewFilter(e.target.value as SurfaceViewFilter)}
          data-testid="surface-view-filter"
          className="shrink-0 rounded-md border border-hairline bg-canvas px-2 py-1.5 text-[12px] text-ink outline-none focus:border-ink"
          aria-label="Filter surfaces"
          title={
            viewFilter === "new"
              ? "Inventory NEW this Case"
              : viewFilter === "untested"
                ? "Not yet TESTED this Case (no purpose=test traffic)"
                : viewFilter === "findings"
                  ? "Routes with linked findings"
                  : `${total} surfaces · ${findingsTotal} findings`
          }
        >
          <option value="all">All ({stats.all || total})</option>
          <option value="new">NEW ({stats.new})</option>
          <option value="untested">Untested ({stats.untested})</option>
          <option value="findings">Findings ({stats.findings})</option>
        </select>
      </div>

      {filteredRoots.length === 0 && unlinkedCount === 0 ? (
        <p className="text-sm text-ink-muted" data-testid="surface-filter-empty">
          No surfaces match search/filter
        </p>
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
              knownIndex={knownIndex}
              enrolledKeys={enrolledKeys}
              onAskEnroll={(target) => {
                setEnrollError("");
                setEnrollTarget(target);
              }}
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

      <ConfirmDialog
        open={Boolean(enrollTarget)}
        title="纳入资产库"
        description={`把 ${enrollTarget?.host || ""} 登记为资产，并挂上端口 ${enrollTarget?.port || ""}？不会改本轮攻击面树。`}
        confirmLabel="纳入"
        busy={enrolling}
        error={enrollError || null}
        onCancel={() => {
          if (!enrolling) {
            setEnrollTarget(null);
            setEnrollError("");
          }
        }}
        onConfirm={() => void enrollOrigin()}
      />
    </div>
  );
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

/** Whether this node (as a surface identity / leaf) matches the view filter. */
export function surfaceNodeMatchesViewFilter(
  node: SurfaceTreeNode,
  filter: SurfaceViewFilter,
): boolean {
  if (filter === "all") return true;
  if (filter === "new") return node.isNew === true;
  // Spec #413: untested = not case_tested this Case.
  if (filter === "untested") return node.caseTested !== true;
  if (filter === "findings") return (node.findingTags?.length || 0) > 0;
  return true;
}

/**
 * Collect path/service nodes that carry surface entries (operator “leaves”).
 * Intermediate path parents without own entries are skipped.
 */
export function collectSurfaceIdentityNodes(roots: SurfaceTreeNode[]): SurfaceTreeNode[] {
  const out: SurfaceTreeNode[] = [];
  const walk = (node: SurfaceTreeNode) => {
    if (node.entries.length > 0) out.push(node);
    for (const child of node.children) walk(child);
  };
  for (const r of roots) walk(r);
  return out;
}

export function countSurfaceViewStats(roots: SurfaceTreeNode[]): {
  all: number;
  new: number;
  untested: number;
  findings: number;
} {
  const leaves = collectSurfaceIdentityNodes(roots);
  let neu = 0;
  let untested = 0;
  let findings = 0;
  for (const n of leaves) {
    if (n.isNew === true) neu += 1;
    if (n.caseTested !== true) untested += 1;
    if ((n.findingTags?.length || 0) > 0) findings += 1;
  }
  return { all: leaves.length, new: neu, untested, findings };
}

export function filterSurfaceTree(
  roots: SurfaceTreeNode[],
  query: string,
  view: SurfaceViewFilter,
): SurfaceTreeNode[] {
  const q = query.trim().toLowerCase();
  if (!q && view === "all") return roots;

  const filterNode = (node: SurfaceTreeNode): SurfaceTreeNode | null => {
    const children = node.children
      .map((child) => filterNode(child))
      .filter((child): child is SurfaceTreeNode => child != null);

    const searchSelf = !q || surfaceNodeSearchBlob(node).includes(q);
    const selfHasEntries = node.entries.length > 0;
    const selfMatchesView = !selfHasEntries || surfaceNodeMatchesViewFilter(node, view);
    const selfMatches = selfHasEntries && selfMatchesView && searchSelf;

    // Keep ancestors of matching descendants (and/or own matching identity).
    if (children.length > 0) {
      const subtreeTags = dedupeFindingTags([
        ...(selfMatches ? node.findingTags : []),
        ...children.flatMap((c) => c.subtreeFindingTags),
      ]);
      // When filter excludes this node's own identity, drop own entries from the projected node
      // so chrome does not show a non-matching root path as if it were a hit.
      return {
        ...node,
        children,
        entries: selfMatches ? node.entries : [],
        findingTags: selfMatches ? node.findingTags : [],
        subtreeFindingTags: subtreeTags,
        leafCount:
          children.reduce((n, c) => n + (c.leafCount || 0), 0) +
          (selfMatches ? Math.max(1, node.entries.length) : 0),
        isNew: selfMatches ? node.isNew : undefined,
        caseTested: selfMatches ? node.caseTested : undefined,
        status: selfMatches ? node.status : preferSurfaceStatus(undefined, children[0]?.status),
      };
    }

    // Leaf (no surviving children)
    if (!selfHasEntries) {
      // Empty intermediate path with no matches — drop.
      return null;
    }
    if (!selfMatches) return null;

    return {
      ...node,
      children: [],
      subtreeFindingTags: node.findingTags,
    };
  };

  return roots.map(filterNode).filter((n): n is SurfaceTreeNode => n != null);
}

const ENROLL_CHIP =
  "ml-auto inline-flex h-6 shrink-0 items-center rounded-md px-1.5 text-[11px] leading-none";

function SurfaceEnrollChip({
  enrolled,
  host,
  port,
  label,
  onEnroll,
}: {
  enrolled: boolean;
  host: string;
  port: string;
  label: string;
  onEnroll: (target: { host: string; port: string; label: string }) => void;
}) {
  if (enrolled) {
    return (
      <span data-testid="surface-enrolled" className={`${ENROLL_CHIP} text-ink-muted`}>
        已纳入
      </span>
    );
  }
  return (
    <button
      type="button"
      title="纳入资产库"
      aria-label={`把 ${host} 纳入资产库`}
      data-testid="surface-enroll"
      onClick={(e) => {
        e.stopPropagation();
        onEnroll({ host, port, label });
      }}
      className={`${ENROLL_CHIP} gap-0.5 text-ink-secondary hover:bg-canvas hover:text-ink`}
    >
      <Plus className="h-3 w-3" />
      纳入
    </button>
  );
}

function SurfaceTreeNodeRow({
  node,
  depth,
  isOpen,
  onToggle,
  onOpenVulnerability,
  knownIndex,
  enrolledKeys,
  onAskEnroll,
}: {
  node: SurfaceTreeNode;
  depth: number;
  isOpen: (node: SurfaceTreeNode, depth: number) => boolean;
  onToggle: (id: string, depth: number, node: SurfaceTreeNode) => void;
  onOpenVulnerability?: (finding: Partial<SecurityVulnerability>) => void;
  knownIndex: { hosts: Set<string>; hostPorts: Set<string> };
  enrolledKeys: Set<string>;
  onAskEnroll: (target: { host: string; port: string; label: string }) => void;
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

  const enrollTarget = parseOriginEnrollTarget(node);
  const enrolled =
    Boolean(enrollTarget) &&
    hostPortEnrolled(enrollTarget!.host, enrollTarget!.port, knownIndex, enrolledKeys);
  const canEnroll = Boolean(enrollTarget) && !enrolled;

  const displayLabel =
    node.nodeKind === "path"
      ? node.path === "/" || !node.label
        ? "/"
        : `/${node.label}`
      : node.label;
  const serviceBadge =
    node.service && node.service !== "web" && (node.nodeKind === "port" || node.nodeKind === "service")
      ? node.service.toUpperCase()
      : node.nodeKind === "port" && node.service === "web"
        ? "WEB"
        : "";

  return (
    <div>
      <div
        className="group/origin flex min-w-0 items-center gap-1 rounded-md px-1 py-1 hover:bg-surface-default"
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
            {/* Spec #409/#413: TESTED from case_tested; never SEEN/BOOK/PRIOR; terminals muted. */}
            {chrome.showStatusChip &&
              surfaceStatusLabel(
                node.status,
                node.caseTested === true
                  ? { caseTested: true }
                  : node.caseTested === false
                    ? { caseTested: false }
                    : undefined,
              ) && (
              <span
                className={`shrink-0 rounded px-1 py-0.5 font-mono text-[10px] font-medium uppercase ${surfaceStatusBadgeClass(
                  node.status,
                  node.caseTested === true
                    ? { caseTested: true }
                    : node.caseTested === false
                      ? { caseTested: false }
                      : undefined,
                )}`}
                data-testid="surface-status"
                data-status={surfaceStatusLabel(
                  node.status,
                  node.caseTested === true
                    ? { caseTested: true }
                    : node.caseTested === false
                      ? { caseTested: false }
                      : undefined,
                )}
              >
                {surfaceStatusLabel(
                  node.status,
                  node.caseTested === true
                    ? { caseTested: true }
                    : node.caseTested === false
                      ? { caseTested: false }
                      : undefined,
                )}
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
        {enrollTarget ? (
          <SurfaceEnrollChip
            enrolled={enrolled}
            host={enrollTarget.host}
            port={enrollTarget.port}
            label={displayLabel}
            onEnroll={onAskEnroll}
          />
        ) : null}
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
              knownIndex={knownIndex}
              enrolledKeys={enrolledKeys}
              onAskEnroll={onAskEnroll}
            />
          ))}
        </div>
      )}
    </div>
  );
}


