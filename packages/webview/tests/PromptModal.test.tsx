// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { PromptModal } from "../src/components/PromptModal.tsx";

afterEach(() => {
  cleanup();
});

function setup(overrides: Partial<Parameters<typeof PromptModal>[0]> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  const props = {
    open: true,
    title: "Enter a value",
    onConfirm,
    onCancel,
    ...overrides,
  } satisfies Parameters<typeof PromptModal>[0];
  const result = render(<PromptModal {...props} />);
  return { ...result, onConfirm, onCancel };
}

describe("PromptModal", () => {
  it("renders nothing when open is false", () => {
    const { container } = setup({ open: false });
    expect(container.firstChild).toBeNull();
  });

  it("renders the title when open", () => {
    setup({ title: "Switch account" });
    expect(screen.getByRole("heading", { name: "Switch account" })).toBeDefined();
  });

  it("renders the optional description when provided", () => {
    setup({ description: "Enter a profile name." });
    expect(screen.getByText("Enter a profile name.")).toBeDefined();
  });

  it("does not render a description element when description is omitted", () => {
    setup({ description: undefined });
    expect(screen.queryByText("Enter a profile name.")).toBeNull();
  });

  it("pre-populates the input with defaultValue", () => {
    setup({ defaultValue: "my-profile" });
    const input = screen.getByRole("textbox") as HTMLInputElement;
    expect(input.value).toBe("my-profile");
  });

  it("input starts empty when defaultValue is not provided", () => {
    setup({});
    const input = screen.getByRole("textbox") as HTMLInputElement;
    expect(input.value).toBe("");
  });

  it("renders custom confirmLabel and cancelLabel", () => {
    setup({ confirmLabel: "Switch", cancelLabel: "Abort" });
    expect(screen.getByRole("button", { name: "Switch" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Abort" })).toBeDefined();
  });

  it("defaults to OK / Cancel labels", () => {
    setup({});
    expect(screen.getByRole("button", { name: "OK" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDefined();
  });

  it("calls onConfirm with the typed value when confirm is clicked", () => {
    const { onConfirm, onCancel } = setup({ defaultValue: "" });
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "new-profile" } });
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith("new-profile");
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("calls onConfirm with the defaultValue unchanged when no typing occurs", () => {
    const { onConfirm } = setup({ defaultValue: "existing" });
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(onConfirm).toHaveBeenCalledWith("existing");
  });

  it("calls onCancel and not onConfirm when cancel is clicked", () => {
    const { onConfirm, onCancel } = setup({});
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("calls onConfirm when Enter is pressed in the input", () => {
    const { onConfirm } = setup({ defaultValue: "typed" });
    const input = screen.getByRole("textbox");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onConfirm).toHaveBeenCalledWith("typed");
  });

  it("calls onCancel when Escape is pressed in the input", () => {
    const { onCancel } = setup({});
    const input = screen.getByRole("textbox");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
