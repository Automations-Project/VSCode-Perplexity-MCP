export type DotVariant = "ok" | "warn" | "off" | "err" | "info";

const DOTS: Record<DotVariant, { bg: string; glow?: string }> = {
  ok:   { bg: "var(--fg-ok)",   glow: "0 0 6px rgba(34,197,94,0.55)" },
  err:  { bg: "var(--fg-err)",  glow: "0 0 6px rgba(248,113,113,0.55)" },
  info: { bg: "var(--fg-info)", glow: "0 0 6px rgba(56,189,248,0.45)" },
  warn: { bg: "var(--fg-warn)" },
  off:  { bg: "var(--text-muted)" },
};

export function StatusDot({ variant }: { variant: DotVariant }) {
  const d = DOTS[variant];
  return (
    <span style={{
      display: "inline-block", width: 7, height: 7, borderRadius: "50%",
      backgroundColor: d.bg, boxShadow: d.glow, flexShrink: 0,
    }} />
  );
}
