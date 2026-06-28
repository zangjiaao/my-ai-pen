import { useState } from "react";

export default function ThinkingCard({ content }: { content: Record<string, unknown> }) {
  const [collapsed, setCollapsed] = useState(true);
  return (
    <div className="my-2 cursor-pointer" onClick={() => setCollapsed(!collapsed)}>
      <div className="flex items-center gap-2 text-xs text-ink-muted">
        <span>{collapsed ? "▶" : "▼"}</span>
        <span>💭 思考过程</span>
      </div>
      {!collapsed && (
        <div className="mt-1 border-l-2 border-ink-muted bg-surface-default px-3 py-2 italic text-ink-secondary text-sm">
          {content.reasoning as string}
        </div>
      )}
    </div>
  );
}
