import { useSyncExternalStore } from "react";
import {
  getRenderAuditFlags,
  subscribeRenderAudit,
} from "../lib/renderAudit";

function formatDelta(delta: Record<string, number>): string {
  return Object.entries(delta)
    .map(([name, n]) => `${name}×${n}`)
    .join(" ");
}

/** DEV-only: appears after a composer keystroke leaks into the Case stream / panels. */
export default function RenderAuditBadge() {
  if (!import.meta.env.DEV) return null;
  return <RenderAuditBadgeLive />;
}

function RenderAuditBadgeLive() {
  const flags = useSyncExternalStore(
    subscribeRenderAudit,
    getRenderAuditFlags,
    () => [],
  );
  if (!flags.length) return null;
  const last = flags[flags.length - 1];
  return (
    <div
      data-testid="render-audit-flag"
      data-render-audit-count={flags.length}
      className="pointer-events-none fixed bottom-3 left-3 z-[80] max-w-sm rounded-md border border-severity-critical/40 bg-canvas px-2.5 py-1.5 text-[11px] leading-snug text-severity-critical shadow-[0_1px_2px_rgba(0,0,0,0.06)]"
      title="Typed input re-rendered components other than the field owner. See window.__RENDER_AUDIT__.report()"
    >
      render leak ×{flags.length}: {formatDelta(last.delta)}
    </div>
  );
}
