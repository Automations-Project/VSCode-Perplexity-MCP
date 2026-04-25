export type DotVariant = "ok" | "warn" | "off" | "err" | "info";

export function StatusDot({ variant }: { variant: DotVariant }) {
  return <span className={`status-dot status-dot-${variant}`} />;
}
