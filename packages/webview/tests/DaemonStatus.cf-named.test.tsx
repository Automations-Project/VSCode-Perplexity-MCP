// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonStatusState } from "@perplexity-user-mcp/shared";
import { DaemonStatusView, deriveCfNamedState } from "../src/components/DaemonStatus";
import { useDashboardStore } from "../src/store";

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
  version: "0.8.0",
  startedAt: "2026-04-22T11:30:00.000Z",
  uptimeMs: 1_800_000,
  heartbeatCount: 3,
  tunnel: { status: "disabled", url: null, pid: null, error: null },
  bearerAvailable: true,
};

function cfNamedProviders(setup: {
  ready: boolean;
  reason?: string;
  action?: {
    label: string;
    kind: "open-url" | "input-authtoken" | "install-binary" | "run-command";
    url?: string;
    command?: string;
  };
}) {
  return {
    activeProvider: "cf-named" as const,
    providers: [
      {
        id: "cf-named" as const,
        displayName: "Cloudflare Named Tunnel",
        description: "Persistent URL on your own zone.",
        isActive: true,
        setup,
      },
    ],
    ngrok: { configured: false },
  };
}

describe("deriveCfNamedState", () => {
  it("maps 'not installed' reason → missing-binary", () => {
    expect(deriveCfNamedState({ ready: false, reason: "cloudflared binary not installed." })).toBe("missing-binary");
  });
  it("maps 'cloudflared login required — origin cert not found.' → missing-cert", () => {
    expect(
      deriveCfNamedState({ ready: false, reason: "cloudflared login required — origin cert not found." }),
    ).toBe("missing-cert");
  });
  it("maps 'named tunnel not configured — run the setup flow.' → missing-config", () => {
    expect(
      deriveCfNamedState({ ready: false, reason: "named tunnel not configured — run the setup flow." }),
    ).toBe("missing-config");
  });
  it("maps 'credentials file not found at /path/x.json.' → missing-credentials", () => {
    expect(
      deriveCfNamedState({ ready: false, reason: "credentials file not found at /x.json." }),
    ).toBe("missing-credentials");
  });

  it("regression: credentials-not-found reason embedding cloudflared advisory prose (contains 'origin certificate') stays missing-credentials, not missing-cert", () => {
    // A prior parser bug corrupted the managed YAML's credentials-file value
    // by swallowing cloudflared's trailing advisory text ("cloudflared chose
    // this file based on where your origin certificate was found..."). When
    // the provider's isSetupComplete then reported
    //   "credentials file not found at <that corrupted path>"
    // the widget's loose `/origin cert/` substring test matched "origin
    // certificate" inside the embedded prose and misrouted the state to
    // missing-cert — trapping the user in a 'Run cloudflared login' loop
    // because clicking login was correctly rejected by the helper (cert
    // already existed) yet the UI never offered a different action.
    // deriveCfNamedState now checks credentials-file-not-found BEFORE any
    // cert keyword check and tightens the cert regex to the exact
    // provider-emitted suffix "origin cert not found".
    const corruptedReason =
      "credentials file not found at C:\\Users\\admin\\.cloudflared\\c4175c8c-9ad7-4ccd-9d51-16d6d2b42c2e.json. cloudflared chose this file based on where your origin certificate was found. Keep this file secret. To revoke these credentials, delete the tunnel.";
    expect(deriveCfNamedState({ ready: false, reason: corruptedReason })).toBe("missing-credentials");
  });
  it("maps ready=true → ready (reason ignored)", () => {
    expect(deriveCfNamedState({ ready: true })).toBe("ready");
  });
  it("unknown reason falls back to missing-config (safest default surfaces the full setup form)", () => {
    expect(deriveCfNamedState({ ready: false, reason: "weird future reason copy" })).toBe("missing-config");
  });
  it("undefined setup → unknown", () => {
    expect(deriveCfNamedState(undefined)).toBe("unknown");
  });
});

describe("cf-named widget — unready states", () => {
  beforeEach(() => {
    useDashboardStore.setState({
      daemonStatus: baseStatus,
      daemonAuditTail: [],
      daemonTokenRotatedAt: null,
      tunnelProviders: cfNamedProviders({ ready: false, reason: "cloudflared binary not installed." }),
    });
  });
  afterEach(() => {
    useDashboardStore.setState({ tunnelProviders: null });
  });

  it("renders the missing-binary state with an Install cloudflared button", () => {
    const markup = renderToStaticMarkup(
      <DaemonStatusView
        status={baseStatus}
        auditTail={[]}
        tokenRotatedAt={null}
        tunnelProviders={cfNamedProviders({ ready: false, reason: "cloudflared binary not installed." })}
        send={vi.fn()}
      />,
    );
    expect(markup).toContain('data-testid="cf-named-setup-box"');
    expect(markup).toContain("cloudflared binary not installed");
    expect(markup).toContain('data-testid="cf-named-install-cloudflared"');
    expect(markup).toContain("Install cloudflared");
    // missing-binary state must NOT render login / create forms yet
    expect(markup).not.toContain('data-testid="cf-named-login-btn"');
    expect(markup).not.toContain('data-testid="cf-named-create-btn"');
  });

  it("renders the missing-cert state with a Run cloudflared login button", () => {
    const markup = renderToStaticMarkup(
      <DaemonStatusView
        status={baseStatus}
        auditTail={[]}
        tokenRotatedAt={null}
        tunnelProviders={cfNamedProviders({
          ready: false,
          reason: "cloudflared login required — origin cert not found.",
          action: { label: "Run cloudflared login", kind: "run-command", command: "cf-named-login" },
        })}
        send={vi.fn()}
      />,
    );
    expect(markup).toContain('data-testid="cf-named-login-btn"');
    expect(markup).toContain("Run cloudflared login");
    expect(markup).toContain("cloudflared login required");
    // missing-cert state must NOT show the install or create forms
    expect(markup).not.toContain('data-testid="cf-named-install-cloudflared"');
    expect(markup).not.toContain('data-testid="cf-named-create-btn"');
  });

  it("renders the missing-config state with create + bind forms", () => {
    const markup = renderToStaticMarkup(
      <DaemonStatusView
        status={baseStatus}
        auditTail={[]}
        tokenRotatedAt={null}
        tunnelProviders={cfNamedProviders({
          ready: false,
          reason: "named tunnel not configured — run the setup flow.",
        })}
        send={vi.fn()}
      />,
    );
    expect(markup).toContain('data-testid="cf-named-setup-box"');
    expect(markup).toContain('data-testid="cf-named-create-name"');
    expect(markup).toContain('data-testid="cf-named-create-hostname"');
    expect(markup).toContain('data-testid="cf-named-create-btn"');
    expect(markup).toContain('data-testid="cf-named-bind-uuid"');
    expect(markup).toContain('data-testid="cf-named-bind-hostname"');
    expect(markup).toContain('data-testid="cf-named-bind-btn"');
    expect(markup).toContain('data-testid="cf-named-list-btn"');
    expect(markup).toContain("Create a new tunnel");
    expect(markup).toContain("Or bind an existing tunnel");
    // SSR default: inputs are empty → both buttons disabled
    expect(markup).toMatch(/data-testid="cf-named-create-btn"[^>]*disabled=""/);
    expect(markup).toMatch(/data-testid="cf-named-bind-btn"[^>]*disabled=""/);
  });

  it("renders the missing-credentials state with a red banner AND the create/bind recovery forms", () => {
    // Previous UX left this state as copy-only, trapping users with no
    // actionable controls. The recovery path is identical to missing-config
    // (create a new tunnel or bind a different existing UUID), so the
    // widget now renders the same forms plus a red banner naming the
    // specific problem.
    const markup = renderToStaticMarkup(
      <DaemonStatusView
        status={baseStatus}
        auditTail={[]}
        tokenRotatedAt={null}
        tunnelProviders={cfNamedProviders({
          ready: false,
          reason: "credentials file not found at /home/user/.cloudflared/missing.json.",
        })}
        send={vi.fn()}
      />,
    );
    expect(markup).toContain('data-testid="cf-named-creds-missing"');
    expect(markup).toContain("credentials file for this tunnel");
    // Recovery forms MUST render — previous regression had no buttons here.
    expect(markup).toContain('data-testid="cf-named-create-btn"');
    expect(markup).toContain('data-testid="cf-named-bind-btn"');
    expect(markup).toContain('data-testid="cf-named-list-btn"');
    // Still no login button in this state (user's cert is fine — it's the
    // per-tunnel credentials file that's missing).
    expect(markup).not.toContain('data-testid="cf-named-login-btn"');
    expect(markup).not.toContain('data-testid="cf-named-install-cloudflared"');
  });
});

describe("cf-named widget — ready state + managed-config caveat", () => {
  it("renders the managed-config caveat only when setup.ready is true", () => {
    const ready = renderToStaticMarkup(
      <DaemonStatusView
        status={baseStatus}
        auditTail={[]}
        tokenRotatedAt={null}
        tunnelProviders={cfNamedProviders({ ready: true })}
        send={vi.fn()}
      />,
    );
    expect(ready).toContain('data-testid="cf-named-managed-caveat"');
    expect(ready).toContain("provider-managed");
    expect(ready).toContain("overwritten");
    // No setup-box when ready
    expect(ready).not.toContain('data-testid="cf-named-setup-box"');
  });

  it("does NOT render the caveat when provider is cf-named but setup is not ready", () => {
    const notReady = renderToStaticMarkup(
      <DaemonStatusView
        status={baseStatus}
        auditTail={[]}
        tokenRotatedAt={null}
        tunnelProviders={cfNamedProviders({ ready: false, reason: "cloudflared binary not installed." })}
        send={vi.fn()}
      />,
    );
    expect(notReady).not.toContain('data-testid="cf-named-managed-caveat"');
  });

  it("does NOT render cf-named widget or caveat when activeProvider is cf-quick", () => {
    const markup = renderToStaticMarkup(
      <DaemonStatusView
        status={baseStatus}
        auditTail={[]}
        tokenRotatedAt={null}
        tunnelProviders={{
          activeProvider: "cf-quick",
          providers: [
            {
              id: "cf-quick",
              displayName: "Cloudflare Quick Tunnel",
              description: "Ephemeral URL.",
              isActive: true,
              setup: { ready: true },
            },
            {
              id: "cf-named",
              displayName: "Cloudflare Named Tunnel",
              description: "Persistent URL on your zone.",
              isActive: false,
              setup: { ready: false, reason: "cloudflared binary not installed." },
            },
          ],
          ngrok: { configured: false },
        }}
        send={vi.fn()}
      />,
    );
    expect(markup).not.toContain('data-testid="cf-named-setup-box"');
    expect(markup).not.toContain('data-testid="cf-named-managed-caveat"');
  });
});

describe("cf-named widget — send message wiring (jsdom)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("missing-binary → Install cloudflared click sends daemon:install-cloudflared", async () => {
    // @vitest-environment jsdom
    const { render, fireEvent, cleanup } = await import("@testing-library/react");
    const send = vi.fn();
    const { container } = render(
      <DaemonStatusView
        status={baseStatus}
        auditTail={[]}
        tokenRotatedAt={null}
        tunnelProviders={cfNamedProviders({ ready: false, reason: "cloudflared binary not installed." })}
        send={send}
      />,
    );
    const button = container.querySelector('[data-testid="cf-named-install-cloudflared"]');
    expect(button).not.toBeNull();
    fireEvent.click(button!);
    expect(send).toHaveBeenCalledWith({ type: "daemon:install-cloudflared" });
    cleanup();
  });

  it("missing-cert → Run cloudflared login click sends daemon:cf-named-login", async () => {
    const { render, fireEvent, cleanup } = await import("@testing-library/react");
    const send = vi.fn();
    const { container } = render(
      <DaemonStatusView
        status={baseStatus}
        auditTail={[]}
        tokenRotatedAt={null}
        tunnelProviders={cfNamedProviders({
          ready: false,
          reason: "cloudflared login required — origin cert not found.",
        })}
        send={send}
      />,
    );
    const button = container.querySelector('[data-testid="cf-named-login-btn"]');
    expect(button).not.toBeNull();
    fireEvent.click(button!);
    expect(send).toHaveBeenCalledWith({ type: "daemon:cf-named-login" });
    cleanup();
  });

  it("missing-config → Create button is disabled until both inputs are valid, then dispatches cf-named-create (mode: create)", async () => {
    const { render, fireEvent, cleanup } = await import("@testing-library/react");
    const send = vi.fn();
    const { container } = render(
      <DaemonStatusView
        status={baseStatus}
        auditTail={[]}
        tokenRotatedAt={null}
        tunnelProviders={cfNamedProviders({
          ready: false,
          reason: "named tunnel not configured — run the setup flow.",
        })}
        send={send}
      />,
    );
    const createBtn = container.querySelector('[data-testid="cf-named-create-btn"]') as HTMLButtonElement;
    expect(createBtn.disabled).toBe(true);

    const nameInput = container.querySelector('[data-testid="cf-named-create-name"]') as HTMLInputElement;
    const hostnameInput = container.querySelector('[data-testid="cf-named-create-hostname"]') as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "perplexity-mcp" } });
    fireEvent.change(hostnameInput, { target: { value: "mcp.example.com" } });
    expect(createBtn.disabled).toBe(false);

    fireEvent.click(createBtn);
    expect(send).toHaveBeenCalledWith({
      type: "daemon:cf-named-create",
      payload: { mode: "create", name: "perplexity-mcp", hostname: "mcp.example.com" },
    });
    cleanup();
  });

  it("missing-config → Bind button dispatches cf-named-create (mode: bind-existing) with UUID + hostname", async () => {
    const { render, fireEvent, cleanup } = await import("@testing-library/react");
    const send = vi.fn();
    const { container } = render(
      <DaemonStatusView
        status={baseStatus}
        auditTail={[]}
        tokenRotatedAt={null}
        tunnelProviders={cfNamedProviders({
          ready: false,
          reason: "named tunnel not configured — run the setup flow.",
        })}
        send={send}
      />,
    );
    const bindBtn = container.querySelector('[data-testid="cf-named-bind-btn"]') as HTMLButtonElement;
    expect(bindBtn.disabled).toBe(true);

    const uuidInput = container.querySelector('[data-testid="cf-named-bind-uuid"]') as HTMLInputElement;
    const hostnameInput = container.querySelector('[data-testid="cf-named-bind-hostname"]') as HTMLInputElement;
    fireEvent.change(uuidInput, { target: { value: "11111111-2222-3333-4444-555555555555" } });
    fireEvent.change(hostnameInput, { target: { value: "mcp.example.com" } });
    expect(bindBtn.disabled).toBe(false);

    fireEvent.click(bindBtn);
    expect(send).toHaveBeenCalledWith({
      type: "daemon:cf-named-create",
      payload: {
        mode: "bind-existing",
        uuid: "11111111-2222-3333-4444-555555555555",
        hostname: "mcp.example.com",
      },
    });
    cleanup();
  });

  it("missing-config → List existing button dispatches daemon:cf-named-list (no modal, read-only)", async () => {
    const { render, fireEvent, cleanup } = await import("@testing-library/react");
    const send = vi.fn();
    const { container } = render(
      <DaemonStatusView
        status={baseStatus}
        auditTail={[]}
        tokenRotatedAt={null}
        tunnelProviders={cfNamedProviders({
          ready: false,
          reason: "named tunnel not configured — run the setup flow.",
        })}
        send={send}
      />,
    );
    const listBtn = container.querySelector('[data-testid="cf-named-list-btn"]') as HTMLButtonElement;
    expect(listBtn).not.toBeNull();
    fireEvent.click(listBtn);
    expect(send).toHaveBeenCalledWith({ type: "daemon:cf-named-list" });
    cleanup();
  });
});
