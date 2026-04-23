import { RefreshCcw } from "lucide-react";
import type { ReactNode } from "react";
import { useIsActionPending } from "../store";

/**
 * Pending-aware daemon button. IDs are generated in App.tsx as
 * `${type}-${seq}-${base36}`, so prefix matching in useIsActionPending
 * gives the exact clicked action a spinner + disabled state.
 */
export function DaemonActionButton({
  type,
  label,
  pendingLabel,
  icon,
  className = "ghost-button btn-sm",
  disabled = false,
  title,
  onClick,
  "data-testid": testId,
}: {
  type: string;
  label: string;
  pendingLabel?: string;
  icon?: ReactNode;
  className?: string;
  disabled?: boolean;
  title?: string;
  onClick: () => void;
  "data-testid"?: string;
}) {
  const pending = useIsActionPending(type);
  // Attribute order is load-bearing for existing SSR tests that assert
  // data-testid appears before disabled on cf-named buttons.
  return (
    <button
      className={className}
      data-testid={testId}
      disabled={disabled || pending}
      onClick={onClick}
      title={title}
      aria-busy={pending || undefined}
    >
      {pending ? (
        <RefreshCcw size={11} className="refresh-spin" />
      ) : (
        icon ?? null
      )}
      {pending && pendingLabel ? pendingLabel : label}
    </button>
  );
}
