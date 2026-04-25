// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen, fireEvent, act } from "@testing-library/react";
import { OtpModal } from "../src/components/OtpModal.tsx";
import { useDashboardStore } from "../src/store";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  // Reset store to a closed state after each test.
  useDashboardStore.setState({ otpPrompt: null });
});

const OPEN_PROMPT = {
  open: true as const,
  profile: "test-profile",
  attempt: 1,
  email: "user@example.com",
};

function setup() {
  const send = vi.fn();
  // Set store state BEFORE render so the component mounts with open=true.
  act(() => {
    useDashboardStore.setState({ otpPrompt: OPEN_PROMPT });
  });
  const result = render(<OtpModal send={send} />);
  return { ...result, send };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OtpModal a11y", () => {
  it("renders nothing when prompt is null", () => {
    const send = vi.fn();
    // Keep store at null (default after afterEach).
    const { container } = render(<OtpModal send={send} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the modal when prompt is open", () => {
    setup();
    expect(screen.getByRole("dialog")).toBeDefined();
  });

  it("has aria-modal on the dialog", () => {
    setup();
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
  });

  it("has aria-labelledby pointing to the heading", () => {
    setup();
    const dialog = screen.getByRole("dialog");
    const labelId = dialog.getAttribute("aria-labelledby");
    expect(labelId).toBeTruthy();
    const heading = document.getElementById(labelId!);
    expect(heading).toBeTruthy();
    expect(heading!.tagName).toBe("H3");
  });

  it("focuses first OTP input when opened", () => {
    setup();
    const firstInput = document.querySelector<HTMLInputElement>(".otp-input");
    expect(firstInput).toBeTruthy();
    expect(document.activeElement).toBe(firstInput);
  });

  it("Esc closes the modal", () => {
    setup();
    expect(screen.getByRole("dialog")).toBeDefined();

    act(() => {
      fireEvent.keyDown(document, { key: "Escape" });
    });

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Esc restores focus to the previously focused element", () => {
    // Create a button outside the modal that holds focus before modal opens.
    const container = document.createElement("div");
    document.body.appendChild(container);
    const previousBtn = document.createElement("button");
    previousBtn.setAttribute("data-testid", "prev-focus");
    previousBtn.textContent = "Previous";
    container.appendChild(previousBtn);
    previousBtn.focus();
    expect(document.activeElement).toBe(previousBtn);

    // Mount the modal while previousBtn has focus — trap captures it.
    const send = vi.fn();
    act(() => {
      useDashboardStore.setState({ otpPrompt: OPEN_PROMPT });
    });
    render(<OtpModal send={send} />);

    // Focus moves into the modal when it opens.
    const firstInput = document.querySelector<HTMLInputElement>(".otp-input");
    expect(document.activeElement).toBe(firstInput);

    // Close via Esc.
    act(() => {
      fireEvent.keyDown(document, { key: "Escape" });
    });

    // Focus should return to the button that had it before the modal opened.
    expect(document.activeElement).toBe(previousBtn);

    // Cleanup.
    document.body.removeChild(container);
  });

  it("Tab from last focusable element wraps to first", () => {
    setup();

    // The last focusable element in the modal is the Cancel button.
    const cancelBtn = screen.getByRole("button", { name: "Cancel" });
    cancelBtn.focus();
    expect(document.activeElement).toBe(cancelBtn);

    // Tab from last → should wrap to first (the first OTP input).
    fireEvent.keyDown(document, { key: "Tab", shiftKey: false });

    const firstInput = document.querySelector<HTMLInputElement>(".otp-input");
    expect(document.activeElement).toBe(firstInput);
  });

  it("Shift+Tab from first focusable element wraps to last", () => {
    setup();

    // Focus the first OTP input explicitly.
    const firstInput = document.querySelector<HTMLInputElement>(".otp-input")!;
    firstInput.focus();
    expect(document.activeElement).toBe(firstInput);

    // Shift+Tab from first → should wrap to last (Cancel button).
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });

    const cancelBtn = screen.getByRole("button", { name: "Cancel" });
    expect(document.activeElement).toBe(cancelBtn);
  });

  it("Cancel button closes the modal", () => {
    setup();

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    });

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("displays email address from prompt", () => {
    setup();
    expect(screen.getByText("user@example.com")).toBeDefined();
  });

  it("displays the heading text", () => {
    setup();
    expect(screen.getByRole("heading", { name: "Enter the code from your email" })).toBeDefined();
  });
});
