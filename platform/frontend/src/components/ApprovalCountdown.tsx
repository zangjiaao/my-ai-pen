import { useEffect, useMemo, useState } from "react";

function secondsUntil(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const expiresAt = Date.parse(value);
  if (Number.isNaN(expiresAt)) return null;
  return Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
}

function formatSeconds(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes <= 0) return `${rest}s`;
  return `${minutes}m ${rest.toString().padStart(2, "0")}s`;
}

export default function ApprovalCountdown({ expiresAt, compact = false }: { expiresAt?: unknown; compact?: boolean }) {
  const [remaining, setRemaining] = useState<number | null>(() => secondsUntil(expiresAt));
  const hasExpiry = useMemo(() => secondsUntil(expiresAt) !== null, [expiresAt]);

  useEffect(() => {
    setRemaining(secondsUntil(expiresAt));
    if (!hasExpiry) return;
    const timer = window.setInterval(() => setRemaining(secondsUntil(expiresAt)), 1000);
    return () => window.clearInterval(timer);
  }, [expiresAt, hasExpiry]);

  if (!hasExpiry || remaining === null) {
    return <span data-testid="approval-countdown" className="text-xs text-ink-muted">Manual approval</span>;
  }

  const expired = remaining <= 0;
  return (
    <span
      data-testid="approval-countdown"
      className={expired ? "text-xs font-medium text-severity-critical" : "text-xs font-medium text-status-running"}
    >
      {expired ? "Expired" : `${compact ? "" : "Expires in "}${formatSeconds(remaining)}`}
    </span>
  );
}
