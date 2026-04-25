import { useEffect, useLayoutEffect, useRef } from "react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

export interface FocusTrapOptions {
  /** When true, the trap is active. Focus is captured and restored on deactivation. */
  active: boolean;
  /**
   * Ref to the container element that defines the trap boundary.
   * All focusable elements inside this container are reachable; Tab/Shift+Tab
   * wrap at the boundary.
   */
  containerRef: React.RefObject<HTMLElement | null>;
  /**
   * Element to restore focus to when the trap deactivates.
   * Defaults to `document.activeElement` at the time the trap activates.
   */
  restoreFocusRef?: React.RefObject<HTMLElement | null>;
  /**
   * Called when the user presses Escape inside the trap.
   * The caller is responsible for setting `active` to false in response.
   */
  onEscape?: () => void;
}

/**
 * Implements a WCAG-compliant focus trap for modal dialogs.
 *
 * - On activation (`active` transitions to true): captures the currently
 *   focused element as the restore target (unless `restoreFocusRef` is
 *   provided), then focuses the first focusable child.
 * - Tab from the last focusable element wraps to the first.
 * - Shift+Tab from the first wraps to the last.
 * - Esc calls `onEscape` (if provided).
 * - On deactivation (`active` transitions to false) **or unmount while active**:
 *   restores focus to the captured element (or `restoreFocusRef.current`).
 *
 * Focus capture uses `useLayoutEffect` (fires synchronously before `useEffect`)
 * so it always captures the truly-pre-modal focused element regardless of any
 * sibling `useEffect` hooks that also call `.focus()`.
 *
 * Designed for reuse across OtpModal, PromptModal, and any future modal.
 */
export function useFocusTrap(opts: FocusTrapOptions): void {
  const { active, containerRef, restoreFocusRef, onEscape } = opts;

  // Capture the element that was focused before the trap activated.
  const capturedRef = useRef<Element | null>(null);

  // Keep stable ref so the keydown handler always sees the latest onEscape.
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;

  // Capture restore target in useLayoutEffect — this runs synchronously after
  // the DOM commit and BEFORE any useEffect, so it captures the element that
  // had focus before any sibling useEffect calls .focus().
  // Cleanup restores focus on deactivation or unmount.
  useLayoutEffect(() => {
    if (!active) return;

    capturedRef.current = restoreFocusRef?.current ?? document.activeElement;

    return () => {
      const target = restoreFocusRef?.current ?? capturedRef.current;
      if (target && typeof (target as HTMLElement).focus === "function") {
        (target as HTMLElement).focus();
      }
      capturedRef.current = null;
    };
  // Intentionally omit containerRef/restoreFocusRef from deps — we only want
  // to (re-)capture when active changes, not when the refs' .current changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // Focus the first focusable child once the trap is active.
  useEffect(() => {
    if (!active) return;
    const items = getFocusable(containerRef.current);
    items[0]?.focus();
  }, [active, containerRef]);

  // Tab cycling + Esc handler — active only while the trap is on.
  useEffect(() => {
    if (!active) return;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onEscapeRef.current?.();
        return;
      }

      if (e.key !== "Tab") return;

      const items = getFocusable(containerRef.current);
      if (items.length === 0) {
        e.preventDefault();
        return;
      }

      const first = items[0];
      const last = items[items.length - 1];
      const focused = document.activeElement;

      if (e.shiftKey) {
        // Shift+Tab from first → wrap to last.
        if (focused === first || !containerRef.current?.contains(focused)) {
          e.preventDefault();
          last.focus();
        }
      } else {
        // Tab from last → wrap to first.
        if (focused === last || !containerRef.current?.contains(focused)) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [active, containerRef]);
}

function getFocusable(container: HTMLElement | null): HTMLElement[] {
  if (!container) return [];
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => !el.closest("[disabled]") && getComputedStyle(el).display !== "none"
  );
}
