// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { AuthorizedClients } from "../src/components/AuthorizedClients.tsx";

afterEach(() => {
  cleanup();
});

const sampleClients = [
  {
    clientId: "pplx-abc123",
    clientName: "Claude Desktop",
    registeredAt: 1_700_000_000,
    lastUsedAt: "2026-04-22T10:00:00.000Z",
    consentLastApprovedAt: "2026-04-22T09:00:00.000Z",
    activeTokens: 2,
  },
  {
    clientId: "pplx-def456",
    clientName: "Cursor",
    registeredAt: 1_700_001_000,
    lastUsedAt: undefined,
    consentLastApprovedAt: "2026-04-22T08:00:00.000Z",
    activeTokens: 0,
  },
];

describe("AuthorizedClients panel", () => {
  it("renders empty state when clients is null or empty", () => {
    const onRevoke = vi.fn();
    const onRevokeAll = vi.fn();
    render(<AuthorizedClients clients={[]} onRevoke={onRevoke} onRevokeAll={onRevokeAll} />);
    expect(screen.getByText(/no external mcp clients/i)).toBeDefined();
  });

  it("renders a row per client with id, last used, active tokens", () => {
    const onRevoke = vi.fn();
    const onRevokeAll = vi.fn();
    render(<AuthorizedClients clients={sampleClients} onRevoke={onRevoke} onRevokeAll={onRevokeAll} />);
    expect(screen.getByText("Claude Desktop")).toBeDefined();
    expect(screen.getByText("Cursor")).toBeDefined();
    expect(screen.getByText(/pplx-abc123/)).toBeDefined();
    expect(screen.getByText(/2 tokens/)).toBeDefined();
  });

  it("clicking Revoke on a row calls onRevoke with that clientId", () => {
    const onRevoke = vi.fn();
    const onRevokeAll = vi.fn();
    render(<AuthorizedClients clients={sampleClients} onRevoke={onRevoke} onRevokeAll={onRevokeAll} />);
    const buttons = screen.getAllByRole("button", { name: /^revoke$/i });
    fireEvent.click(buttons[0]);
    expect(onRevoke).toHaveBeenCalledWith("pplx-abc123");
  });

  it("clicking Revoke all calls onRevokeAll", () => {
    const onRevoke = vi.fn();
    const onRevokeAll = vi.fn();
    render(<AuthorizedClients clients={sampleClients} onRevoke={onRevoke} onRevokeAll={onRevokeAll} />);
    const btn = screen.getByRole("button", { name: /revoke all/i });
    fireEvent.click(btn);
    expect(onRevokeAll).toHaveBeenCalled();
  });
});
