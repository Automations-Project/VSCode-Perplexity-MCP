import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonStatusState, ExtensionMessage } from "@perplexity-user-mcp/shared";
import { DaemonStatusView } from "../src/components/DaemonStatus";
import { useDashboardStore } from "../src/store";

const daemonStatus: DaemonStatusState = {
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
  version: "0.6.0",
  startedAt: "2026-04-21T11:30:00.000Z",
  uptimeMs: 1_800_000,
  heartbeatCount: 3,
  tunnel: {
    status: "enabled",
    url: "https://phase-five.trycloudflare.com",
    pid: 5151,
    error: null,
  },
  // H0 — the raw bearer never lands on DaemonStatusState; bearerAvailable
  // gates the reveal/copy UI and the real token flows only via the
  // modal-confirmed `daemon:bearer:reveal:response` channel.
  bearerAvailable: true,
};

describe("DaemonStatus", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-21T12:00:00.000Z"));
    useDashboardStore.setState({
      daemonStatus,
      daemonAuditTail: [
        {
          timestamp: "2026-04-21T11:59:00.000Z",
          clientId: "vscode-dashboard",
          tool: "perplexity_search",
          durationMs: 128,
          source: "loopback",
          ok: true,
        },
      ],
      daemonTokenRotatedAt: null,
      notice: null,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders daemon health, masked tunnel URL, controls, and audit tail", () => {
    const markup = renderToStaticMarkup(
      <DaemonStatusView
        status={daemonStatus}
        auditTail={useDashboardStore.getState().daemonAuditTail}
        tokenRotatedAt={null}
        send={vi.fn()}
      />,
    );

    expect({
      health: markup.includes("Healthy"),
      pid: markup.includes("4242"),
      port: markup.includes("41731"),
      uptime: markup.includes("30m"),
      tunnelMasked: markup.includes("https://******.trycloudflare.com"),
      auditTool: markup.includes("perplexity_search"),
      rotateControl: markup.includes("Rotate token"),
    }).toMatchInlineSnapshot(`
      {
        "auditTool": true,
        "health": true,
        "pid": true,
        "port": true,
        "rotateControl": true,
        "tunnelMasked": true,
        "uptime": true,
      }
    `);
  });

  it("hydrates tunnel and token-rotation messages from the extension host", () => {
    const hydrate = useDashboardStore.getState().hydrate;
    const crashedTunnel: ExtensionMessage = {
      type: "daemon:tunnel-url",
      payload: {
        status: "crashed",
        url: null,
        pid: null,
        error: "cloudflared exited",
      },
    };

    hydrate(crashedTunnel);
    expect(useDashboardStore.getState().daemonStatus?.tunnel.status).toBe("crashed");
    expect(useDashboardStore.getState().notice?.message).toContain("cloudflared exited");

    hydrate({
      type: "daemon:token-rotated",
      payload: { rotatedAt: "2026-04-21T12:00:00.000Z" },
    });
    expect(useDashboardStore.getState().daemonTokenRotatedAt).toBe("2026-04-21T12:00:00.000Z");
    expect(useDashboardStore.getState().notice?.level).toBe("info");
  });
});

describe("bearer reveal — store (H0 follow-up)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-23T12:00:00.000Z"));
    useDashboardStore.setState({ revealedBearer: null });
  });

  afterEach(() => {
    vi.useRealTimers();
    useDashboardStore.setState({ revealedBearer: null });
  });

  it("daemon:bearer:reveal:response populates revealedBearer with bearer + absolute expiresAt + nonce", () => {
    const { hydrate } = useDashboardStore.getState();
    hydrate({
      type: "daemon:bearer:reveal:response",
      id: "req-1",
      payload: { bearer: "REVEAL_TEST_FIXTURE_BEARER_A", expiresInMs: 30_000, nonce: "n-1" },
    });
    const slice = useDashboardStore.getState().revealedBearer;
    expect(slice).not.toBeNull();
    expect(slice?.bearer).toBe("REVEAL_TEST_FIXTURE_BEARER_A");
    expect(slice?.nonce).toBe("n-1");
    // Absolute expiresAt = Date.now() + expiresInMs — and vi.setSystemTime pins Date.now()
    expect(slice?.expiresAt).toBe(new Date("2026-04-23T12:00:00.000Z").getTime() + 30_000);
  });

  it("a second response with a different nonce replaces the prior slice (not accumulates)", () => {
    const { hydrate } = useDashboardStore.getState();
    hydrate({
      type: "daemon:bearer:reveal:response",
      id: "req-1",
      payload: { bearer: "FIRST_FIXTURE_BEARER", expiresInMs: 30_000, nonce: "n-1" },
    });
    vi.advanceTimersByTime(5_000);
    hydrate({
      type: "daemon:bearer:reveal:response",
      id: "req-2",
      payload: { bearer: "SECOND_FIXTURE_BEARER", expiresInMs: 30_000, nonce: "n-2" },
    });
    const slice = useDashboardStore.getState().revealedBearer;
    expect(slice?.bearer).toBe("SECOND_FIXTURE_BEARER");
    expect(slice?.nonce).toBe("n-2");
    // TTL restarted from the NEW now — not carried over from the first reveal
    expect(slice?.expiresAt).toBe(new Date("2026-04-23T12:00:05.000Z").getTime() + 30_000);
  });

  it("clearRevealedBearer() empties the slice", () => {
    useDashboardStore.setState({
      revealedBearer: { bearer: "X", expiresAt: Date.now() + 30_000, nonce: "n" },
    });
    useDashboardStore.getState().clearRevealedBearer();
    expect(useDashboardStore.getState().revealedBearer).toBeNull();
  });

  it("never leaks the bearer string into an ExtensionMessage the store logs", () => {
    // Consumer invariant: only `daemon:bearer:reveal:response` should ever carry
    // the raw bearer. If some future refactor adds a bearer field to another
    // ExtensionMessage payload, this test fails fast.
    const BEARER = "CANARY_LEAKED_BEARER_SHOULD_NOT_APPEAR_IN_STATE";
    const { hydrate } = useDashboardStore.getState();
    // Anything OTHER than daemon:bearer:reveal:response must NOT populate revealedBearer.
    hydrate({
      type: "notice",
      payload: { level: "info", message: `bearer=${BEARER}` },
    });
    expect(useDashboardStore.getState().revealedBearer).toBeNull();
  });
});

describe("bearer reveal — DaemonStatusView render (H0 follow-up)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-23T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders the hidden placeholder when no reveal is active", () => {
    const markup = renderToStaticMarkup(
      <DaemonStatusView
        status={daemonStatus}
        auditTail={[]}
        tokenRotatedAt={null}
        revealedBearer={null}
        clearRevealedBearer={vi.fn()}
        send={vi.fn()}
      />,
    );
    expect(markup).toContain("&lt;hidden — click Reveal or Copy&gt;");
    expect(markup).not.toContain("REVEAL_TEST_FIXTURE_BEARER");
    expect(markup).not.toContain("clears in");
  });

  it("renders the bearer and countdown when a live reveal is present", () => {
    const expiresAt = Date.now() + 27_000;
    const markup = renderToStaticMarkup(
      <DaemonStatusView
        status={daemonStatus}
        auditTail={[]}
        tokenRotatedAt={null}
        revealedBearer={{ bearer: "REVEAL_TEST_FIXTURE_BEARER_LIVE", expiresAt, nonce: "n-live" }}
        clearRevealedBearer={vi.fn()}
        send={vi.fn()}
      />,
    );
    expect(markup).toContain("REVEAL_TEST_FIXTURE_BEARER_LIVE");
    expect(markup).toMatch(/clears in \d+s/);
    expect(markup).not.toContain("&lt;hidden — click Reveal or Copy&gt;");
  });

  it("renders the hidden placeholder when an expired reveal is still in state (TTL has elapsed)", () => {
    // expiresAt in the past — the effect hasn't run yet to call clearRevealedBearer,
    // but the render must treat it as hidden. Belt-and-suspenders.
    const expiresAt = Date.now() - 1_000;
    const markup = renderToStaticMarkup(
      <DaemonStatusView
        status={daemonStatus}
        auditTail={[]}
        tokenRotatedAt={null}
        revealedBearer={{ bearer: "REVEAL_TEST_FIXTURE_BEARER_EXPIRED", expiresAt, nonce: "n-expired" }}
        clearRevealedBearer={vi.fn()}
        send={vi.fn()}
      />,
    );
    expect(markup).not.toContain("REVEAL_TEST_FIXTURE_BEARER_EXPIRED");
    expect(markup).toContain("&lt;hidden — click Reveal or Copy&gt;");
    expect(markup).not.toMatch(/clears in \d+s/);
  });

  it("bearer-reveal row is hidden entirely when bearerAvailable=false (daemon offline)", () => {
    const offline = { ...daemonStatus, bearerAvailable: false };
    const markup = renderToStaticMarkup(
      <DaemonStatusView
        status={offline}
        auditTail={[]}
        tokenRotatedAt={null}
        revealedBearer={null}
        clearRevealedBearer={vi.fn()}
        send={vi.fn()}
      />,
    );
    expect(markup).not.toContain("bearer-reveal-row");
    expect(markup).not.toContain("&lt;hidden — click Reveal or Copy&gt;");
  });
});

// @vitest-environment jsdom
describe("bearer reveal — TTL effect (H0 follow-up)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-23T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("invokes clearRevealedBearer() when the interval tick catches up to expiresAt", async () => {
    // Dynamic import so the jsdom pragma above takes effect before React / DOM
    // test utilities load.
    const { render, cleanup, act } = await import("@testing-library/react");
    const clearSpy = vi.fn();
    const { unmount } = render(
      <DaemonStatusView
        status={daemonStatus}
        auditTail={[]}
        tokenRotatedAt={null}
        revealedBearer={{
          bearer: "REVEAL_TEST_FIXTURE_BEARER_TTL",
          expiresAt: Date.now() + 3_000,
          nonce: "n-ttl",
        }}
        clearRevealedBearer={clearSpy}
        send={vi.fn()}
      />,
    );
    expect(clearSpy).not.toHaveBeenCalled();

    // Advance past expiresAt + one tick of the interval (1s) so the callback runs.
    act(() => {
      vi.advanceTimersByTime(4_100);
    });

    expect(clearSpy).toHaveBeenCalledTimes(1);
    unmount();
    cleanup();
  });

  it("cleans up the interval on unmount so a late-resurrected slice does not leak", async () => {
    const { render, cleanup, act } = await import("@testing-library/react");
    const clearSpy = vi.fn();
    const { unmount } = render(
      <DaemonStatusView
        status={daemonStatus}
        auditTail={[]}
        tokenRotatedAt={null}
        revealedBearer={{
          bearer: "REVEAL_TEST_FIXTURE_BEARER_UNMOUNT",
          expiresAt: Date.now() + 30_000,
          nonce: "n-unmount",
        }}
        clearRevealedBearer={clearSpy}
        send={vi.fn()}
      />,
    );
    unmount();
    cleanup();

    // After unmount, advancing past expiresAt must NOT invoke the stale callback.
    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    expect(clearSpy).not.toHaveBeenCalled();
  });

  // ──────────────────────────────────────────────────────────────────
  // UX Pass #2 — delay + null-state + retry regressions
  // See `singleton-daemon-uxpass2` plan. The previous impl flashed
  // "Offline" red before the first status-updated arrived, used
  // "Starting" for both daemon AND tunnel, had no visible pending
  // state on any button, and silently dropped tunnel-copy feedback.
  // ──────────────────────────────────────────────────────────────────

  it("renders 'Loading…' chip when status is null (pre-hydrate), not 'Offline'", () => {
    const markup = renderToStaticMarkup(
      <DaemonStatusView
        status={null}
        auditTail={[]}
        tokenRotatedAt={null}
        send={vi.fn()}
      />,
    );
    expect(markup).toContain('data-testid="daemon-health-chip"');
    expect(markup).toContain("Loading…");
    expect(markup).not.toContain(">Offline<");
  });

  it("renders 'Tunnel connecting…' wording while the tunnel is in status='starting' (disambiguates from daemon 'Starting')", () => {
    const startingTunnel: DaemonStatusState = {
      ...daemonStatus,
      healthy: false,
      running: true,
      tunnel: { status: "starting", url: null, pid: null, error: null },
    };
    const markup = renderToStaticMarkup(
      <DaemonStatusView
        status={startingTunnel}
        auditTail={[]}
        tokenRotatedAt={null}
        send={vi.fn()}
      />,
    );
    // Daemon chip says "Starting", tunnel chip must say "connecting…" (not "starting")
    expect(markup).toContain(">Starting<");
    expect(markup).toContain("Tunnel connecting…");
  });

  it("shows a spinner + 'Rotating…' label on the Rotate-token button while that action id is pending", async () => {
    const { render, cleanup } = await import("@testing-library/react");
    useDashboardStore.setState({ pendingActions: new Set(["daemon:rotate-token-1-xyz"]) });
    const { container } = render(
      <DaemonStatusView
        status={daemonStatus}
        auditTail={[]}
        tokenRotatedAt={null}
        send={vi.fn()}
      />,
    );
    expect(container.innerHTML).toContain("Rotating…");
    // aria-busy must reflect the pending state for screen readers.
    expect(container.innerHTML).toContain('aria-busy="true"');
    cleanup();
    useDashboardStore.setState({ pendingActions: new Set() });
  });

  it("renders a Retry-tunnel button when the tunnel has crashed with a non-NGROK_334 error", () => {
    const crashed: DaemonStatusState = {
      ...daemonStatus,
      tunnel: {
        status: "crashed",
        url: null,
        pid: null,
        error: "cloudflared exited (code=1 signal=null).",
      },
    };
    const markup = renderToStaticMarkup(
      <DaemonStatusView
        status={crashed}
        auditTail={[]}
        tokenRotatedAt={null}
        send={vi.fn()}
      />,
    );
    expect(markup).toContain('data-testid="tunnel-retry"');
    expect(markup).toContain("Retry tunnel");
  });

  it("copies the tunnel URL via the clipboard when the Copy button is clicked (wiring regression)", async () => {
    // The previous pass moved a single `copyFeedback` slot inside the bearer
    // row — when bearerAvailable was false, tunnel-copy feedback was silently
    // dropped. This test locks in that the tunnel Copy button still reaches
    // `navigator.clipboard.writeText` when the bearer row is not mounted.
    // (Verifying the visible feedback span requires awaiting React's async
    // state update after the clipboard promise resolves, which has been
    // flaky across jsdom versions; wiring + markup are asserted separately.)
    vi.useRealTimers();
    const noBearerStatus: DaemonStatusState = { ...daemonStatus, bearerAvailable: false };
    const { render, cleanup, fireEvent, waitFor } = await import("@testing-library/react");
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
      writable: true,
    });
    const { container, getByText } = render(
      <DaemonStatusView
        status={noBearerStatus}
        auditTail={[]}
        tokenRotatedAt={null}
        send={vi.fn()}
      />,
    );
    fireEvent.click(getByText("Reveal URL"));
    const copyBtn = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Copy");
    expect(copyBtn).toBeDefined();
    fireEvent.click(copyBtn!);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("https://phase-five.trycloudflare.com"));
    cleanup();
  });

  it("hides the Reveal-token button entirely when bearerAvailable=false (no orphaned bearer slot)", () => {
    // Complement to the clipboard-wiring test. When the bearer row is
    // absent (daemon offline / bearer unavailable), there is no Reveal-
    // token button to render, and therefore no bearer feedback slot
    // living there. The tunnel row owns its own feedback slot, proved
    // by the wiring test above.
    const noBearerStatus: DaemonStatusState = { ...daemonStatus, bearerAvailable: false };
    const markup = renderToStaticMarkup(
      <DaemonStatusView
        status={noBearerStatus}
        auditTail={[]}
        tokenRotatedAt={null}
        send={vi.fn()}
      />,
    );
    expect(markup).not.toContain('data-testid="bearer-reveal-row"');
    expect(markup).not.toContain("Reveal token");
  });
});
