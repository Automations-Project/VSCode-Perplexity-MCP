// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { RemoteAccessOptIn } from "../src/components/RemoteAccessOptIn.tsx";

afterEach(() => {
  cleanup();
});

describe("RemoteAccessOptIn", () => {
  it("renders the opt-in card with eyebrow, title, detail, and button", () => {
    render(<RemoteAccessOptIn send={vi.fn()} />);
    expect(screen.getByTestId("remote-access-optin")).toBeDefined();
    expect(screen.getByText("Remote access")).toBeDefined();
    expect(screen.getByText("Tunnel disabled")).toBeDefined();
    expect(
      screen.getByText(/daemon is only reachable on 127\.0\.0\.1/i),
    ).toBeDefined();
    expect(screen.getByTestId("remote-access-optin-enable")).toBeDefined();
  });

  it("clicking 'Enable tunnel options' dispatches settings:update with enableTunnels=true", () => {
    const send = vi.fn();
    render(<RemoteAccessOptIn send={send} />);
    fireEvent.click(screen.getByTestId("remote-access-optin-enable"));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      type: "settings:update",
      payload: { enableTunnels: true },
    });
  });

  it("renders the recommendation note warning users to read docs before exposing the MCP server", () => {
    render(<RemoteAccessOptIn send={vi.fn()} />);
    expect(
      screen.getByText(/Read the docs before\s+exposing the MCP server publicly\./i),
    ).toBeDefined();
  });
});
