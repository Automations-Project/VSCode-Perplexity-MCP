import { describe, it, expect, vi } from "vitest";
import type { TunnelProviderId } from "perplexity-user-mcp/daemon/tunnel-providers";

import {
  confirmTunnelSwitch,
  type TunnelSwitchConfirmDeps,
} from "../src/webview/tunnel-switch-confirm.js";

/**
 * Helper that builds a TunnelSwitchConfirmDeps fixture. The showWarningMessage
 * default resolves to undefined (modelling VS Code Cancel / dismiss) so tests
 * must opt-in to "Continue switching".
 */
function makeDeps(
  overrides: Partial<TunnelSwitchConfirmDeps> = {},
): TunnelSwitchConfirmDeps & {
  showWarningMessage: ReturnType<typeof vi.fn>;
} {
  const showWarningMessage = vi.fn(async () => undefined);
  return {
    showWarningMessage,
    currentProvider: "cf-named" as TunnelProviderId,
    currentTunnelEnabled: true,
    ...overrides,
  } as TunnelSwitchConfirmDeps & {
    showWarningMessage: ReturnType<typeof vi.fn>;
  };
}

describe("confirmTunnelSwitch", () => {
  it("returns true and does NOT show a modal when no tunnel is currently enabled", async () => {
    const deps = makeDeps({
      currentTunnelEnabled: false,
      currentProvider: "cf-quick",
    });
    const ok = await confirmTunnelSwitch({
      nextProvider: "ngrok",
      deps,
    });
    expect(ok).toBe(true);
    expect(deps.showWarningMessage).not.toHaveBeenCalled();
  });

  it("returns true and does NOT show a modal when nextProvider === currentProvider (idempotent re-select)", async () => {
    const deps = makeDeps({
      currentTunnelEnabled: true,
      currentProvider: "ngrok",
    });
    const ok = await confirmTunnelSwitch({
      nextProvider: "ngrok",
      deps,
    });
    expect(ok).toBe(true);
    expect(deps.showWarningMessage).not.toHaveBeenCalled();
  });

  it("shows the modal with modal:true + Continue/Cancel buttons and returns true when user picks 'Continue switching'", async () => {
    const deps = makeDeps({
      currentTunnelEnabled: true,
      currentProvider: "cf-named",
      showWarningMessage: vi.fn(async () => "Continue switching"),
    });
    const ok = await confirmTunnelSwitch({
      nextProvider: "ngrok",
      deps,
    });
    expect(ok).toBe(true);
    expect(deps.showWarningMessage).toHaveBeenCalledOnce();
    const call = (deps.showWarningMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe("Switch tunnel provider?");
    expect(call[1]).toMatchObject({ modal: true });
    expect(typeof call[1].detail).toBe("string");
    // Remaining args are the button labels. Order matters: primary first.
    expect(call[2]).toBe("Continue switching");
    expect(call[3]).toBe("Cancel");
  });

  it("returns false when user picks 'Cancel'", async () => {
    const deps = makeDeps({
      currentTunnelEnabled: true,
      currentProvider: "cf-named",
      showWarningMessage: vi.fn(async () => "Cancel"),
    });
    const ok = await confirmTunnelSwitch({
      nextProvider: "ngrok",
      deps,
    });
    expect(ok).toBe(false);
    expect(deps.showWarningMessage).toHaveBeenCalledOnce();
  });

  it("returns false when user dismisses the modal (showWarningMessage resolves undefined)", async () => {
    const deps = makeDeps({
      currentTunnelEnabled: true,
      currentProvider: "cf-named",
      showWarningMessage: vi.fn(async () => undefined),
    });
    const ok = await confirmTunnelSwitch({
      nextProvider: "ngrok",
      deps,
    });
    expect(ok).toBe(false);
  });

  it("modal detail text includes the current provider AND the next provider labels", async () => {
    const deps = makeDeps({
      currentTunnelEnabled: true,
      currentProvider: "cf-named",
      showWarningMessage: vi.fn(async () => "Continue switching"),
    });
    await confirmTunnelSwitch({ nextProvider: "ngrok", deps });
    const call = (deps.showWarningMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    const detail: string = call[1].detail;
    expect(detail).toContain("Cloudflare Named Tunnel");
    expect(detail).toContain("ngrok");
  });

  it("modal detail text explicitly mentions http-loopback and stdio IDEs are unaffected", async () => {
    const deps = makeDeps({
      currentTunnelEnabled: true,
      currentProvider: "cf-quick",
      showWarningMessage: vi.fn(async () => "Continue switching"),
    });
    await confirmTunnelSwitch({ nextProvider: "ngrok", deps });
    const call = (deps.showWarningMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    const detail: string = call[1].detail;
    expect(detail).toContain("http-loopback and stdio IDEs are unaffected");
  });
});
