// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import type { DaemonStatusState, WebviewMessage } from "@perplexity-user-mcp/shared";
import { DaemonStatusView } from "../src/components/DaemonStatus";
import { useDashboardStore } from "../src/store";
import { ACTION_TYPES } from "../src/action-types";

const baseStatus: DaemonStatusState = {
  running: true,
  healthy: true,
  stale: false,
  configDir: "C:/Users/admin/.perplexity-mcp",
  lockPath: "C:/Users/admin/.perplexity-mcp/daemon.lock",
  tokenPath: "C:/Users/admin/.perplexity-mcp/daemon.token",
  pid: 4242,
  uuid: "daemon-uuid",
  port: 41731,
  url: "http://127.0.0.1:41731",
  version: "0.8.1",
  startedAt: "2026-04-24T11:30:00.000Z",
  uptimeMs: 1_800_000,
  heartbeatCount: 3,
  tunnel: { status: "disabled", url: null, pid: null, error: null },
  bearerAvailable: true,
};

afterEach(() => {
  cleanup();
  useDashboardStore.setState({ pendingActions: new Set() });
});

describe("DaemonStatus — Capture diagnostics button", () => {
  it("renders a 'Capture diagnostics' button", () => {
    render(
      <DaemonStatusView
        status={baseStatus}
        auditTail={[]}
        tokenRotatedAt={null}
        send={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /capture diagnostics/i })).toBeDefined();
  });

  it("clicking the button calls send() with the diagnostics:capture message type", () => {
    const sent: WebviewMessage[] = [];
    const send = (msg: WebviewMessage) => {
      sent.push(msg);
    };
    render(
      <DaemonStatusView
        status={baseStatus}
        auditTail={[]}
        tokenRotatedAt={null}
        send={send as (m: WebviewMessage) => void}
      />,
    );
    // TunnelManager emits a `daemon:list-tunnel-providers` on mount; we only
    // care that clicking the button enqueued our specific type.
    const before = sent.filter((m) => m.type === "diagnostics:capture").length;
    const btn = screen.getByRole("button", { name: /capture diagnostics/i });
    fireEvent.click(btn);
    const captureMsgs = sent.filter((m) => m.type === "diagnostics:capture");
    expect(captureMsgs.length).toBe(before + 1);
  });

  it("action type is registered in ACTION_TYPES so App.tsx auto-generates a correlation id", () => {
    expect(ACTION_TYPES.has("diagnostics:capture")).toBe(true);
  });
});
