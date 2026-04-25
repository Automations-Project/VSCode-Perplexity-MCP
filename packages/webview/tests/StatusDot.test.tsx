// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { StatusDot } from "../src/components/StatusDot.tsx";

afterEach(() => {
  cleanup();
});

describe("StatusDot", () => {
  it("renders aria-hidden='true' when decorative", () => {
    const { container } = render(<StatusDot variant="ok" decorative />);
    const span = container.firstChild as HTMLElement;
    expect(span.getAttribute("aria-hidden")).toBe("true");
    expect(span.getAttribute("role")).toBeNull();
    expect(span.getAttribute("aria-label")).toBeNull();
  });

  it("renders role='img' with aria-label when label provided", () => {
    const { container } = render(<StatusDot variant="warn" label="Daemon starting" />);
    const span = container.firstChild as HTMLElement;
    expect(span.getAttribute("role")).toBe("img");
    expect(span.getAttribute("aria-label")).toBe("Daemon starting");
    expect(span.getAttribute("aria-hidden")).toBeNull();
  });

  it("applies the variant class", () => {
    const { container } = render(<StatusDot variant="err" decorative />);
    const span = container.firstChild as HTMLElement;
    expect(span.className).toContain("status-dot-err");
    expect(span.className).toContain("status-dot");
  });

  it("logs a warning in dev when neither label nor decorative is set", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const originalEnv = process.env.NODE_ENV;
    // jsdom sets NODE_ENV to "test", which is not "production", so the warning should fire
    try {
      render(<StatusDot variant="off" />);
      expect(warnSpy).toHaveBeenCalledWith(
        "StatusDot needs either label or decorative for accessibility",
      );
    } finally {
      process.env.NODE_ENV = originalEnv;
      warnSpy.mockRestore();
    }
  });

  it("does not apply role or aria-label when neither label nor decorative is set", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { container } = render(<StatusDot variant="info" />);
    const span = container.firstChild as HTMLElement;
    expect(span.getAttribute("role")).toBeNull();
    expect(span.getAttribute("aria-label")).toBeNull();
    vi.restoreAllMocks();
  });
});
