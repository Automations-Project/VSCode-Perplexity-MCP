import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { DaemonBusyState, DaemonStatusState } from "@perplexity-user-mcp/shared";
import { DaemonStatusView, humanizeTool } from "../src/components/DaemonStatus";

// The busy/queue strip surfaces the SHARED daemon's page state. One daemon
// serves every VS Code window and every configured IDE, so this strip is how a
// user understands that work started in another window (or in Cursor) is why
// their request is waiting.
//
// Null-vs-idle is load-bearing: `null` means the daemon has never reported and
// the strip must stay silent, NOT claim "Ready".

const daemonStatus: DaemonStatusState = {
  running: true,
  healthy: true,
  stale: false,
  configDir: "C:/x",
  lockPath: "C:/x/daemon.lock",
  tokenPath: "C:/x/daemon.token",
  pid: 4242,
  uuid: "u",
  port: 41731,
  url: "http://127.0.0.1:41731",
  version: "0.8.54",
  startedAt: "2026-07-16T11:30:00.000Z",
  uptimeMs: 1_800_000,
  heartbeatCount: 1,
  tunnel: { status: "disabled", url: null, pid: null, error: null },
  bearerAvailable: true,
};

function render(daemonBusy: DaemonBusyState | null | undefined) {
  return renderToStaticMarkup(
    <DaemonStatusView
      status={daemonStatus}
      daemonBusy={daemonBusy}
      auditTail={[]}
      tokenRotatedAt={null}
      send={vi.fn()}
    />,
  );
}

const active = (over: Partial<DaemonBusyState> = {}): DaemonBusyState => ({
  busy: true,
  active: {
    tool: "perplexity_research",
    clientId: "cursor-1",
    startedAt: "2026-07-16T11:59:00.000Z",
  },
  queued: 0,
  updatedAt: "2026-07-16T12:00:00.000Z",
  ...over,
});

describe("humanizeTool", () => {
  it("turns raw MCP tool names into user-facing labels", () => {
    expect(humanizeTool("perplexity_research")).toBe("Research");
    expect(humanizeTool("perplexity_search")).toBe("Search");
    expect(humanizeTool("perplexity_sync_cloud")).toBe("Sync cloud");
  });

  it("falls back to the raw name rather than rendering empty", () => {
    expect(humanizeTool("perplexity_")).toBe("perplexity_");
    expect(humanizeTool("custom")).toBe("Custom");
  });
});

describe("DaemonStatusView — shared-backend busy strip", () => {
  it("pre-hydrate (null) renders the strip container but claims nothing", () => {
    const markup = render(null);
    // Container is always present so its reserved height cannot shift the
    // layout when chips appear.
    expect(markup).toContain('data-testid="daemon-busy-strip"');
    expect(markup).not.toContain("daemon-busy-idle");
    expect(markup).not.toContain("daemon-busy-active");
    expect(markup).not.toContain("Ready —");
  });

  it("idle states that the backend is shared and free", () => {
    const markup = render(active({ busy: false, active: null, queued: 0 }));
    expect(markup).toContain('data-testid="daemon-busy-idle"');
    expect(markup).toContain("Ready");
    expect(markup).toContain("shared with your other windows");
    expect(markup).not.toContain("daemon-busy-active");
  });

  it("busy names the humanized tool and the owning client", () => {
    const markup = render(active());
    expect(markup).toContain('data-testid="daemon-busy-active"');
    expect(markup).toContain("Research running");
    expect(markup).toContain('data-testid="daemon-busy-client"');
    expect(markup).toContain("cursor-1");
    // Nothing queued behind it → no queue chip.
    expect(markup).not.toContain('data-testid="daemon-busy-queued"');
  });

  it("renders queue depth when work is waiting on the shared page", () => {
    const markup = render(active({ queued: 3 }));
    expect(markup).toContain('data-testid="daemon-busy-queued"');
    expect(markup).toContain("3 queued");
  });

  it("omits the client chip when the daemon does not attribute the op", () => {
    const markup = render(
      active({ active: { tool: "perplexity_search", clientId: null, startedAt: "2026-07-16T11:59:00.000Z" } }),
    );
    expect(markup).toContain("Search running");
    expect(markup).not.toContain('data-testid="daemon-busy-client"');
  });

  it("announces busy transitions politely in its own live region", () => {
    const markup = render(active());
    expect(markup).toMatch(/class="daemon-busy-strip"[^>]*role="status"[^>]*aria-live="polite"/);
  });

  it("the strip itself renders only tool/client/queue — no secret-shaped content", () => {
    // Scope to the strip: the surrounding card legitimately contains the
    // bearer-reveal UI. What matters is that the busy channel never carries a
    // secret into the webview.
    const markup = render(active({ queued: 2 }));
    const strip = /<div class="daemon-busy-strip".*?<\/div>\s*<div class="daemon-chip-row"/s.exec(markup)?.[0] ?? "";
    expect(strip).toContain("Research running");
    expect(strip.toLowerCase()).not.toContain("bearer");
    expect(strip.toLowerCase()).not.toContain("token");
    expect(strip).not.toContain("Authorization");
  });

  it("states that the daemon is shared across windows and IDEs", () => {
    expect(render(null)).toContain("shared by all VS Code windows and MCP clients");
  });

  it("keeps working for callers that pass no busy prop at all", () => {
    const markup = renderToStaticMarkup(
      <DaemonStatusView status={daemonStatus} auditTail={[]} tokenRotatedAt={null} send={vi.fn()} />,
    );
    expect(markup).toContain('data-testid="daemon-status-card"');
    expect(markup).not.toContain("daemon-busy-idle");
  });
});
