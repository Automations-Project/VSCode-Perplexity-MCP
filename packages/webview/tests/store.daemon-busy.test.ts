import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DaemonBusyState, ExtensionMessage } from "@perplexity-user-mcp/shared";
import { useDashboardStore } from "../src/store";

// The `daemonBusy` slice carries the shared daemon's live page busy/queue
// state. One daemon serves every VS Code window and every configured IDE, so
// this is global truth pushed by the host over SSE — not per-window click
// state (that is `pendingActions`, which is strictly local).
//
// `null` = not hydrated (render nothing) vs `{busy:false}` = a real, stateable
// idle. The distinction matters: the strip must not claim "Ready" before the
// daemon has ever spoken.

const busyPayload = (over: Partial<DaemonBusyState> = {}): DaemonBusyState => ({
  busy: true,
  active: { tool: "perplexity_research", clientId: "cursor-1", startedAt: "2026-07-16T00:00:00.000Z" },
  queued: 2,
  updatedAt: "2026-07-16T00:00:01.000Z",
  ...over,
});

describe("store — daemon:busy", () => {
  beforeEach(() => {
    useDashboardStore.setState({ daemonBusy: null });
  });

  afterEach(() => {
    useDashboardStore.setState({ daemonBusy: null });
  });

  it("initial daemonBusy slice is null (pre-hydrate, daemon has not spoken)", () => {
    expect(useDashboardStore.getState().daemonBusy).toBeNull();
  });

  it("hydrates the busy payload", () => {
    const message: ExtensionMessage = { type: "daemon:busy", payload: busyPayload() };
    useDashboardStore.getState().hydrate(message);

    const state = useDashboardStore.getState().daemonBusy;
    expect(state?.busy).toBe(true);
    expect(state?.active?.tool).toBe("perplexity_research");
    expect(state?.active?.clientId).toBe("cursor-1");
    expect(state?.queued).toBe(2);
  });

  it("an idle payload is retained as real idle, not collapsed back to null", () => {
    useDashboardStore.getState().hydrate({ type: "daemon:busy", payload: busyPayload() });
    useDashboardStore.getState().hydrate({
      type: "daemon:busy",
      payload: busyPayload({ busy: false, active: null, queued: 0 }),
    });

    const state = useDashboardStore.getState().daemonBusy;
    expect(state).not.toBeNull();
    expect(state?.busy).toBe(false);
    expect(state?.active).toBeNull();
    expect(state?.queued).toBe(0);
  });

  it("host is authoritative — each message overwrites the previous state", () => {
    useDashboardStore.getState().hydrate({ type: "daemon:busy", payload: busyPayload({ queued: 5 }) });
    useDashboardStore.getState().hydrate({
      type: "daemon:busy",
      payload: busyPayload({ queued: 1, active: { tool: "perplexity_search", startedAt: "x" } }),
    });

    const state = useDashboardStore.getState().daemonBusy;
    expect(state?.queued).toBe(1);
    expect(state?.active?.tool).toBe("perplexity_search");
  });

  it("does not disturb the daemonStatus slice (separate sources, separate cadence)", () => {
    useDashboardStore.setState({ daemonStatus: null });
    useDashboardStore.getState().hydrate({ type: "daemon:busy", payload: busyPayload() });
    expect(useDashboardStore.getState().daemonStatus).toBeNull();
  });
});
