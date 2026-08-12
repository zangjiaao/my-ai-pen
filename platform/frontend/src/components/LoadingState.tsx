import { useEffect, useState } from "react";

/* ─────────────────────────────────────────────────────────
 * LOADING STATE — pixel-grid loader for long-running work
 *
 * Variants:
 *   Drive  — square cells, chevron wavefront driving right;
 *            the 650ms cycle is shorter than the sweep, so
 *            two fronts are always in flight
 *   Dots   — same wavefront, circular cells
 *   Orbit  — a comet lapping the grid perimeter
 *
 * Paired with a shimmering label and a live elapsed timer
 * in mono tabular figures. Reduced motion freezes the grid
 * to its dim state; the timer still ticks.
 * ───────────────────────────────────────────────────────── */

const chevron = Array.from({ length: 9 }, (_, i) => {
  const r = Math.floor(i / 3);
  const c = i % 3;
  return (c + Math.abs(r - 1)) * 90;
});

const ORBIT_ORDER = [0, 1, 2, 5, 8, 7, 6, 3];
const orbit = Array.from({ length: 9 }, (_, i) => {
  const k = ORBIT_ORDER.indexOf(i);
  return k === -1 ? null : k * 110;
});

const PATTERNS: Record<string, { delays: (number | null)[]; dur: number; round: boolean }> = {
  Drive: { delays: chevron, dur: 650, round: false },
  Dots: { delays: chevron, dur: 650, round: true },
  Orbit: { delays: orbit, dur: 950, round: false },
};

export type LoadingStateVariant = "Drive" | "Dots" | "Orbit";

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => setReduced(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);
  return reduced;
}

/**
 * Pixel-grid mark only — for process chrome leading slot (align with Think/Tool).
 * Same Drive/Dots/Orbit animations as full LoadingState.
 */
export function LoadingPixelMark({
  variant = "Drive",
  testId = "working-status-light",
}: {
  variant?: LoadingStateVariant | string;
  testId?: string;
}) {
  const reducedMotion = usePrefersReducedMotion();
  const { delays, dur, round } = PATTERNS[variant] ?? PATTERNS.Drive;
  return (
    <span
      aria-hidden
      data-testid={testId}
      className="grid shrink-0 grid-cols-[repeat(3,4px)] gap-[1.5px]"
    >
      {delays.map((d, i) => (
        <span
          key={i}
          className={`size-[4px] bg-ink ${round ? "rounded-full" : "rounded-[1px]"}`}
          style={{
            opacity: d === null || reducedMotion ? 0.12 : 0.15,
            animation:
              d === null || reducedMotion
                ? "none"
                : `pixel-on ${dur}ms ease-in-out ${d}ms infinite`,
          }}
        />
      ))}
    </span>
  );
}

/**
 * Live elapsed since mount: `0.0s` … then `1m 0.0s` (tenths).
 * Wall-clock from mount — not tick counting. Under heavy Agent streaming
 * re-renders, setInterval fires late; incrementing ds would under-count
 * ("timer slows down"). Each fire remeasures Date.now() - start instead.
 */
function useElapsed(): string {
  const [totalSec, setTotalSec] = useState(0);
  useEffect(() => {
    const startedAt = Date.now();
    const tick = () => {
      setTotalSec(Math.max(0, (Date.now() - startedAt) / 1000));
    };
    tick();
    const t = window.setInterval(tick, 100);
    return () => window.clearInterval(t);
  }, []);
  if (totalSec < 60) return `${totalSec.toFixed(1)}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${s.toFixed(1)}s`;
}

export default function LoadingState({
  label = "工作中...",
  variant = "Drive",
  showElapsed = true,
  testId = "loading-state",
}: {
  label?: string;
  variant?: LoadingStateVariant | string;
  showElapsed?: boolean;
  testId?: string;
}) {
  const elapsed = useElapsed();
  const reducedMotion = usePrefersReducedMotion();

  return (
    <div data-testid={testId} className="flex w-fit max-w-full items-center gap-2.5" role="status" aria-live="polite">
      <LoadingPixelMark variant={variant} />
      <span
        data-testid="agent-pending-title"
        className={
          reducedMotion
            ? "min-w-0 truncate text-[13px] font-medium text-ink-secondary"
            : "min-w-0 truncate bg-clip-text text-[13px] font-medium text-transparent"
        }
        style={
          reducedMotion
            ? undefined
            : {
                backgroundImage:
                  "linear-gradient(90deg, var(--color-ink-muted) 35%, var(--color-ink) 50%, var(--color-ink-muted) 65%)",
                backgroundSize: "200% 100%",
                animation: "shimmer-text 1.4s linear infinite",
              }
        }
      >
        {label}
      </span>
      {showElapsed ? (
        <span
          data-testid="loading-state-elapsed"
          className="shrink-0 font-mono text-[12px] tabular-nums text-ink-muted"
        >
          {elapsed}
        </span>
      ) : null}
    </div>
  );
}
