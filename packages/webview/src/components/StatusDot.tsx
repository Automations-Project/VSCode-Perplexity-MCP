export type DotVariant = "ok" | "warn" | "off" | "err" | "info" | "ai";

interface StatusDotProps {
  variant: DotVariant;
  /** When set, renders role="img" with aria-label — use when the dot stands alone with no adjacent text. */
  label?: string;
  /** When true, renders aria-hidden="true" — use when adjacent text already describes the state. */
  decorative?: boolean;
}

export function StatusDot({ variant, label, decorative }: StatusDotProps) {
  if (label) {
    return <span role="img" aria-label={label} className={`status-dot status-dot-${variant}`} />;
  }
  if (decorative) {
    return <span aria-hidden="true" className={`status-dot status-dot-${variant}`} />;
  }
  if (process.env.NODE_ENV !== "production") {
    console.warn("StatusDot needs either label or decorative for accessibility");
  }
  return <span className={`status-dot status-dot-${variant}`} />;
}
