// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { BearerReveal } from "../src/components/BearerReveal.tsx";

afterEach(() => {
  cleanup();
});

// Fixed reference point so countdown math is deterministic regardless of
// real clock drift during the test run.
const NOW = 1_750_000_000_000;

function setup(overrides: Partial<Parameters<typeof BearerReveal>[0]> = {}) {
  const onReveal = vi.fn();
  const onCopy = vi.fn();
  const props = {
    available: true,
    revealed: null,
    feedback: null,
    onReveal,
    onCopy,
    now: NOW,
    ...overrides,
  } satisfies Parameters<typeof BearerReveal>[0];
  const result = render(<BearerReveal {...props} />);
  return { ...result, onReveal, onCopy, props };
}

describe("BearerReveal", () => {
  it("renders nothing when available is false", () => {
    const { container } = setup({ available: false });
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId("bearer-reveal-row")).toBeNull();
  });

  it("shows <hidden> placeholder and no countdown when revealed is null", () => {
    setup({ revealed: null });
    expect(screen.getByTestId("bearer-reveal-row")).toBeDefined();
    expect(screen.queryByTestId("bearer-reveal-countdown")).toBeNull();
    const valueCell = screen.getByTestId("bearer-reveal-value");
    expect(valueCell.textContent).toContain("hidden");
    // No <code> child means the raw bearer isn't rendered.
    expect(valueCell.querySelector("code")).toBeNull();
  });

  it("shows the bearer and a 30s countdown when reveal is live at issuance", () => {
    setup({
      revealed: { bearer: "SECRET-BEARER-VALUE", expiresAt: NOW + 30_000 },
    });
    const countdown = screen.getByTestId("bearer-reveal-countdown");
    expect(countdown.textContent).toMatch(/clears in 30s/);
    const valueCell = screen.getByTestId("bearer-reveal-value");
    expect(valueCell.textContent).toContain("SECRET-BEARER-VALUE");
    expect(valueCell.querySelector("code")?.textContent).toBe("SECRET-BEARER-VALUE");
  });

  it("counts down as now advances (15s remaining)", () => {
    setup({
      revealed: { bearer: "SECRET", expiresAt: NOW + 30_000 },
      now: NOW + 15_000,
    });
    expect(screen.getByTestId("bearer-reveal-countdown").textContent).toMatch(/clears in 15s/);
    expect(screen.getByTestId("bearer-reveal-value").textContent).toContain("SECRET");
  });

  it("treats exact-expiry (remaining = 0) as not live", () => {
    setup({
      revealed: { bearer: "SECRET", expiresAt: NOW + 30_000 },
      now: NOW + 30_000,
    });
    expect(screen.queryByTestId("bearer-reveal-countdown")).toBeNull();
    const valueCell = screen.getByTestId("bearer-reveal-value");
    expect(valueCell.textContent).toContain("hidden");
    expect(valueCell.querySelector("code")).toBeNull();
  });

  it("treats an already-expired reveal as not live", () => {
    setup({
      revealed: { bearer: "SECRET", expiresAt: NOW - 1000 },
    });
    expect(screen.queryByTestId("bearer-reveal-countdown")).toBeNull();
    const valueCell = screen.getByTestId("bearer-reveal-value");
    expect(valueCell.textContent).toContain("hidden");
    expect(valueCell.querySelector("code")).toBeNull();
  });

  it("clicking Reveal token calls onReveal exactly once", () => {
    const { onReveal, onCopy } = setup();
    const btn = screen.getByRole("button", { name: /reveal token/i });
    fireEvent.click(btn);
    expect(onReveal).toHaveBeenCalledTimes(1);
    expect(onCopy).not.toHaveBeenCalled();
  });

  it("clicking Copy calls onCopy exactly once", () => {
    const { onReveal, onCopy } = setup();
    const btn = screen.getByRole("button", { name: /^copy$/i });
    fireEvent.click(btn);
    expect(onCopy).toHaveBeenCalledTimes(1);
    expect(onReveal).not.toHaveBeenCalled();
  });

  it("renders the feedback flash text next to the buttons when provided", () => {
    setup({ feedback: "Copy requested" });
    expect(screen.getByText("Copy requested")).toBeDefined();
  });

  it("renders no feedback element when feedback is null", () => {
    const { container } = setup({ feedback: null });
    // The feedback span has inline font-size 0.66rem and no testid; easiest
    // structural check: ensure no element carries the "Copy requested" text.
    expect(screen.queryByText("Copy requested")).toBeNull();
    // Sanity: the row is present (so we're not accidentally checking an empty tree).
    expect(container.querySelector("[data-testid='bearer-reveal-row']")).not.toBeNull();
  });

  it("available + no reveal + no feedback renders hidden placeholder and both buttons", () => {
    setup({ available: true, revealed: null, feedback: null });
    expect(screen.queryByTestId("bearer-reveal-countdown")).toBeNull();
    expect(screen.getByTestId("bearer-reveal-value").textContent).toContain("hidden");
    expect(screen.getByRole("button", { name: /reveal token/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /^copy$/i })).toBeDefined();
  });
});
