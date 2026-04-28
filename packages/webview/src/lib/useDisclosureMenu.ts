import { useEffect, useRef } from "react";

const DEFAULT_ITEM_SELECTOR = '[role="menuitem"]';

export interface DisclosureMenuOptions {
  /** Ref to the trigger element (focus is restored here on Esc-close). */
  triggerRef: React.RefObject<HTMLElement | null>;
  /** Ref to the container that wraps both the trigger and the menu popover. */
  menuRef: React.RefObject<HTMLElement | null>;
  /**
   * Optional ref to a portaled popover element rendered outside `menuRef`.
   * When provided, item querying and click-outside detection also consider
   * this element so that React-portaled menus work correctly.
   */
  popoverRef?: React.RefObject<HTMLElement | null>;
  isOpen: boolean;
  onClose: () => void;
  /**
   * CSS selector used to find focusable menu items inside `menuRef`.
   * Defaults to `[role="menuitem"]`.
   */
  itemSelector?: string;
}

/**
 * Shared keyboard + click-outside behaviour for disclosure menus (DownloadMenu,
 * OpenWithMenu, ProfileSwitcher).
 *
 * - **Esc**: closes the menu and restores focus to `triggerRef`.
 * - **Outside click**: closes (no focus restoration — user explicitly clicked away).
 * - **ArrowDown / ArrowUp**: cycle through non-disabled `itemSelector` elements
 *   inside `menuRef`.
 * - **Enter**: triggers a click on the currently focused item.
 * - **On open**: focuses the first focusable item automatically.
 *
 * All listeners are attached only while `isOpen === true` and removed on
 * cleanup / close.
 */
export function useDisclosureMenu(opts: DisclosureMenuOptions): void {
  const { triggerRef, menuRef, popoverRef, isOpen, onClose, itemSelector = DEFAULT_ITEM_SELECTOR } = opts;

  // Keep a stable ref so callbacks inside the effect always see the latest onClose
  // without having to re-subscribe every render.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Focus the first item whenever the menu opens.
  useEffect(() => {
    if (!isOpen) return;
    // Defer one frame so the menu DOM is guaranteed to be in the tree.
    const frame = requestAnimationFrame(() => {
      const root = popoverRef?.current ?? menuRef.current;
      const items = root?.querySelectorAll<HTMLElement>(
        `${itemSelector}:not([disabled]):not(:disabled)`
      );
      items?.[0]?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [isOpen, menuRef, popoverRef, itemSelector]);

  // Keyboard and click-outside handlers.
  useEffect(() => {
    if (!isOpen) return;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCloseRef.current();
        // Restore focus to the trigger.
        triggerRef.current?.focus();
        return;
      }

      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const root = popoverRef?.current ?? menuRef.current;
        const items = Array.from(
          root?.querySelectorAll<HTMLElement>(
            `${itemSelector}:not([disabled]):not(:disabled)`
          ) ?? []
        );
        if (items.length === 0) return;
        const active = document.activeElement;
        const idx = items.indexOf(active as HTMLElement);
        const next =
          e.key === "ArrowDown"
            ? items[(idx + 1) % items.length]
            : items[(idx - 1 + items.length) % items.length];
        next?.focus();
        return;
      }

      if (e.key === "Enter") {
        const active = document.activeElement as HTMLElement | null;
        if (active && (menuRef.current?.contains(active) || popoverRef?.current?.contains(active))) {
          e.preventDefault();
          active.click();
        }
      }
    };

    const onClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!menuRef.current?.contains(target) && !popoverRef?.current?.contains(target)) {
        onCloseRef.current();
        // No focus restoration on outside-click — the user clicked somewhere
        // intentionally and that element may already hold focus.
      }
    };

    document.addEventListener("keydown", onKey);
    document.addEventListener("click", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("click", onClick);
    };
  }, [isOpen, triggerRef, menuRef, popoverRef, itemSelector]);
}
