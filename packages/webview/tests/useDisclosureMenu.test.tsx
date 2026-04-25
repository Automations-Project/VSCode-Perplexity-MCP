// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen, fireEvent, act } from "@testing-library/react";
import { useRef, useState } from "react";
import { useDisclosureMenu } from "../src/lib/useDisclosureMenu";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Host component — a minimal disclosure menu to exercise the hook.
// ---------------------------------------------------------------------------

function TestMenu({ onClose: externalOnClose }: { onClose?: () => void } = {}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const close = () => {
    setOpen(false);
    externalOnClose?.();
  };

  useDisclosureMenu({ triggerRef, menuRef, isOpen: open, onClose: close });

  return (
    <div ref={menuRef}>
      <button ref={triggerRef} data-testid="trigger" onClick={() => setOpen((o) => !o)}>
        Toggle
      </button>
      {open && (
        <div role="menu" data-testid="menu">
          <button role="menuitem" data-testid="item-a">Item A</button>
          <button role="menuitem" data-testid="item-b">Item B</button>
          <button role="menuitem" data-testid="item-c" disabled>Item C (disabled)</button>
          <button role="menuitem" data-testid="item-d">Item D</button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function openMenu() {
  fireEvent.click(screen.getByTestId("trigger"));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useDisclosureMenu", () => {
  it("does not render menu initially", () => {
    render(<TestMenu />);
    expect(screen.queryByTestId("menu")).toBeNull();
  });

  it("renders menu after trigger click", () => {
    render(<TestMenu />);
    openMenu();
    expect(screen.getByTestId("menu")).toBeDefined();
  });

  it("focuses first non-disabled item when opened", async () => {
    // rAF is used inside the hook — fake timers let us flush it synchronously.
    vi.useFakeTimers();
    render(<TestMenu />);
    openMenu();
    await act(async () => {
      vi.runAllTimers();
    });
    expect(document.activeElement).toBe(screen.getByTestId("item-a"));
    vi.useRealTimers();
  });

  it("Esc closes the menu", () => {
    render(<TestMenu />);
    openMenu();
    expect(screen.getByTestId("menu")).toBeDefined();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("menu")).toBeNull();
  });

  it("Esc restores focus to the trigger", () => {
    render(<TestMenu />);
    const trigger = screen.getByTestId("trigger");
    openMenu();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(document.activeElement).toBe(trigger);
  });

  it("ArrowDown moves focus to the next item (wraps at end)", async () => {
    vi.useFakeTimers();
    render(<TestMenu />);
    openMenu();
    await act(async () => { vi.runAllTimers(); });

    // Focus is on item-a. ArrowDown → item-b.
    fireEvent.keyDown(document, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByTestId("item-b"));

    // item-b → item-d (item-c is disabled, but our selector skips :disabled).
    fireEvent.keyDown(document, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByTestId("item-d"));

    // item-d is last → wraps to item-a.
    fireEvent.keyDown(document, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByTestId("item-a"));

    vi.useRealTimers();
  });

  it("ArrowUp moves focus to the previous item (wraps at start)", async () => {
    vi.useFakeTimers();
    render(<TestMenu />);
    openMenu();
    await act(async () => { vi.runAllTimers(); });

    // Focus is on item-a. ArrowUp wraps to last (item-d).
    fireEvent.keyDown(document, { key: "ArrowUp" });
    expect(document.activeElement).toBe(screen.getByTestId("item-d"));

    vi.useRealTimers();
  });

  it("Enter triggers click on the focused item", async () => {
    vi.useFakeTimers();
    const itemClickHandler = vi.fn();
    render(
      <div>
        <TestMenu />
      </div>
    );
    openMenu();
    await act(async () => { vi.runAllTimers(); });

    // Attach handler after opening so the element exists.
    screen.getByTestId("item-a").addEventListener("click", itemClickHandler);

    // Focus item-b manually then press Enter.
    screen.getByTestId("item-b").focus();
    const itemB = screen.getByTestId("item-b");
    const clickSpy = vi.spyOn(itemB, "click");
    fireEvent.keyDown(document, { key: "Enter" });
    expect(clickSpy).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  it("outside click closes the menu", () => {
    render(
      <div>
        <TestMenu />
        <button data-testid="outside">Outside</button>
      </div>
    );
    openMenu();
    expect(screen.getByTestId("menu")).toBeDefined();

    fireEvent.click(screen.getByTestId("outside"));
    expect(screen.queryByTestId("menu")).toBeNull();
  });

  it("outside click does NOT restore focus to trigger", () => {
    render(
      <div>
        <TestMenu />
        <button data-testid="outside">Outside</button>
      </div>
    );
    openMenu();
    const outside = screen.getByTestId("outside");
    outside.focus();

    fireEvent.click(outside);
    // Focus should remain on the outside button, not the trigger.
    expect(document.activeElement).toBe(outside);
  });

  it("click on the menu container itself does not close the menu", () => {
    render(<TestMenu />);
    openMenu();

    // Clicking the menu div (inside the container) should NOT close via the hook.
    fireEvent.click(screen.getByTestId("menu"));
    expect(screen.getByTestId("menu")).toBeDefined();
  });

  it("custom itemSelector is respected", async () => {
    vi.useFakeTimers();
    function CustomMenu() {
      const [open, setOpen] = useState(false);
      const triggerRef = useRef<HTMLButtonElement>(null);
      const menuRef = useRef<HTMLDivElement>(null);
      useDisclosureMenu({
        triggerRef,
        menuRef,
        isOpen: open,
        onClose: () => setOpen(false),
        itemSelector: "[data-custom-item]",
      });
      return (
        <div ref={menuRef}>
          <button ref={triggerRef} data-testid="ctrig" onClick={() => setOpen(true)}>T</button>
          {open && (
            <div>
              {/* role=menuitem but no data-custom-item — hook should skip */}
              <button role="menuitem" data-testid="ignored">Ignored</button>
              <button data-custom-item data-testid="custom-a">A</button>
              <button data-custom-item data-testid="custom-b">B</button>
            </div>
          )}
        </div>
      );
    }

    render(<CustomMenu />);
    fireEvent.click(screen.getByTestId("ctrig"));
    await act(async () => { vi.runAllTimers(); });

    // First item per custom selector should be focused (not the role=menuitem one).
    expect(document.activeElement).toBe(screen.getByTestId("custom-a"));
    vi.useRealTimers();
  });

  it("does nothing when menu is closed (no event listeners attached)", () => {
    const onClose = vi.fn();
    render(<TestMenu onClose={onClose} />);
    // Menu is closed — Esc should not call onClose.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });
});
