/**
 * Lightweight chart primitives in the spirit of shadcn/ui chart (recharts).
 * Styled for this product's ink/canvas design tokens — not a full shadcn install.
 */
import * as React from "react";
import * as RechartsPrimitive from "recharts";
import { cn } from "../../lib/utils";

export type ChartConfig = Record<
  string,
  {
    label?: string;
    color?: string;
  }
>;

const ChartContext = React.createContext<{ config: ChartConfig } | null>(null);

function useChart() {
  const ctx = React.useContext(ChartContext);
  if (!ctx) throw new Error("useChart must be used within <ChartContainer />");
  return ctx;
}

export function ChartContainer({
  id,
  className,
  children,
  config,
}: {
  id?: string;
  className?: string;
  config: ChartConfig;
  children: React.ComponentProps<typeof RechartsPrimitive.ResponsiveContainer>["children"];
}) {
  const uniqueId = React.useId();
  const chartId = `chart-${id || uniqueId.replace(/:/g, "")}`;

  return (
    <ChartContext.Provider value={{ config }}>
      <div
        data-chart={chartId}
        className={cn(
          "flex aspect-video justify-center text-xs text-ink-secondary [&_.recharts-cartesian-axis-tick_text]:fill-ink-muted [&_.recharts-cartesian-grid_line[stroke='#ccc']]:stroke-hairline [&_.recharts-curve.recharts-tooltip-cursor]:stroke-hairline [&_.recharts-rectangle.recharts-tooltip-cursor]:fill-canvas-inset [&_.recharts-layer]:outline-none [&_.recharts-sector]:outline-none [&_.recharts-surface]:outline-none",
          className,
        )}
        style={
          {
            ...Object.fromEntries(
              Object.entries(config).map(([key, item]) =>
                item.color ? [`--color-${key}`, item.color] : [],
              ),
            ),
          } as React.CSSProperties
        }
      >
        <RechartsPrimitive.ResponsiveContainer width="100%" height="100%">
          {children}
        </RechartsPrimitive.ResponsiveContainer>
      </div>
    </ChartContext.Provider>
  );
}

export const ChartTooltip = RechartsPrimitive.Tooltip;

export function ChartTooltipContent({
  active,
  payload,
  label,
  className,
  hideLabel,
  hideZero,
  nameKey,
}: {
  active?: boolean;
  payload?: Array<{ name?: string; value?: number; dataKey?: string; color?: string; payload?: Record<string, unknown> }>;
  label?: string;
  className?: string;
  hideLabel?: boolean;
  /** Skip series with value 0 (useful for stacked charts). */
  hideZero?: boolean;
  nameKey?: string;
}) {
  const { config } = useChart();
  if (!active || !payload?.length) return null;
  const rows = hideZero
    ? payload.filter((item) => item.value !== 0 && item.value !== undefined && item.value !== null)
    : payload;
  if (!rows.length) return null;

  return (
    <div
      className={cn(
        "grid min-w-[8rem] items-start gap-1.5 rounded-md border border-hairline bg-canvas px-2.5 py-1.5 text-xs shadow-sm",
        className,
      )}
    >
      {!hideLabel && label ? <div className="font-medium text-ink">{label}</div> : null}
      <div className="grid gap-1">
        {rows.map((item, i) => {
          const key = String(nameKey || item.dataKey || item.name || "value");
          const itemConfig = config[key];
          const name = itemConfig?.label || item.name || key;
          const color = item.color || itemConfig?.color || "var(--color-ink)";
          return (
            <div key={i} className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-1.5">
                <span className="h-2 w-2 shrink-0 rounded-[2px]" style={{ background: color }} />
                <span className="text-ink-secondary">{name}</span>
              </div>
              <span className="font-mono font-medium tabular-nums text-ink">
                {typeof item.value === "number" ? item.value.toLocaleString() : item.value}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function ChartLegendContent({
  payload,
  className,
}: {
  payload?: Array<{
    value?: string;
    dataKey?: string;
    color?: string;
    payload?: { key?: string; name?: string };
  }>;
  className?: string;
  nameKey?: string;
}) {
  const { config } = useChart();
  if (!payload?.length) return null;
  return (
    <div className={cn("flex flex-wrap items-center justify-center gap-3 pt-2", className)}>
      {payload.map((item, i) => {
        const fromPayload = item.payload?.key;
        const key = String(fromPayload || item.dataKey || item.value || i);
        const itemConfig = config[key];
        return (
          <div key={i} className="flex items-center gap-1.5 text-[11px] text-ink-secondary">
            <span
              className="h-2 w-2 shrink-0 rounded-[2px]"
              style={{ background: item.color || itemConfig?.color || "var(--color-ink)" }}
            />
            {itemConfig?.label || item.payload?.name || item.value || key}
          </div>
        );
      })}
    </div>
  );
}

export { RechartsPrimitive };
