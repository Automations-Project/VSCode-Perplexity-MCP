import { useEffect, useState } from "react";

/**
 * Live relative-time label — re-renders every 30s so values like
 * "2m ago" stay accurate without external triggers. Used by
 * `DaemonStatus` (token-rotated chip, audit-tail rows) instead of the
 * static `formatRelative` helper which only re-ran when some unrelated
 * parent re-render happened (e.g. the bearer-reveal TTL tick at
 * `DaemonStatus.tsx:91-100`).
 *
 * One `setInterval` per mounted instance. For the handful of callsites
 * the card has, a shared Context would be overkill.
 */
export function RelativeTime({ iso }: { iso: string }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 30_000);
    return () => window.clearInterval(id);
  }, []);
  return <>{formatRelative(iso)}</>;
}

function formatRelative(iso: string): string {
  const timestamp = new Date(iso).getTime();
  if (Number.isNaN(timestamp)) {
    return "unknown";
  }
  const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
