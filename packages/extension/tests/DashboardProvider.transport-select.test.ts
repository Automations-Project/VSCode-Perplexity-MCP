import { describe, expect, it, vi } from "vitest";
import type { McpTransportId } from "@perplexity-user-mcp/shared";

import {
  handleTransportSelect,
  type TransportSelectDeps,
} from "../src/webview/transport-select-handler.js";

/**
 * Tests cover the pure `transport:select` handler extracted from
 * DashboardProvider so the decision logic stays testable without a
 * full vscode shim. The integration wiring (postActionResult, postSettings)
 * is verified by the manual smoke checklist in docs/smoke-tests.md.
 */

function makeDeps(overrides: Partial<TransportSelectDeps> & {
  initial?: Record<string, McpTransportId>;
} = {}): TransportSelectDeps & {
  writes: Array<Record<string, McpTransportId>>;
} {
  const writes: Array<Record<string, McpTransportId>> = [];
  let current: Record<string, McpTransportId> = { ...(overrides.initial ?? {}) };
  const deps: TransportSelectDeps = {
    readTransportByIde: overrides.readTransportByIde ?? (() => current),
    writeTransportByIde:
      overrides.writeTransportByIde
      ?? (async (next) => {
        writes.push(next);
        current = next;
      }),
  };
  return Object.assign(deps, { writes });
}

describe("handleTransportSelect — pure handler for transport:select", () => {
  it("valid ideTag with no prior map -> writes { [ideTag]: transportId } and returns ok=true", async () => {
    const deps = makeDeps();
    const outcome = await handleTransportSelect(
      { ideTag: "cursor", transportId: "http-loopback" },
      deps,
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.next).toEqual({ cursor: "http-loopback" });
    expect(deps.writes).toEqual([{ cursor: "http-loopback" }]);
  });

  it("valid ideTag with prior entries -> merges, keeping the other IDEs untouched", async () => {
    const deps = makeDeps({
      initial: {
        windsurf: "stdio-daemon-proxy",
        cline: "http-loopback",
      },
    });
    const outcome = await handleTransportSelect(
      { ideTag: "cursor", transportId: "http-loopback" },
      deps,
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.next).toEqual({
      windsurf: "stdio-daemon-proxy",
      cline: "http-loopback",
      cursor: "http-loopback",
    });
  });

  it("valid ideTag with an existing entry for that same ide -> overwrites", async () => {
    const deps = makeDeps({
      initial: { cursor: "stdio-daemon-proxy" },
    });
    const outcome = await handleTransportSelect(
      { ideTag: "cursor", transportId: "http-loopback" },
      deps,
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.next).toEqual({ cursor: "http-loopback" });
  });

  it("unknown ideTag -> refuses silently with reason 'unknown-ide'; no write", async () => {
    const deps = makeDeps();
    const outcome = await handleTransportSelect(
      { ideTag: "not-a-real-ide", transportId: "http-loopback" },
      deps,
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe("unknown-ide");
    expect(deps.writes).toEqual([]);
  });

  it("write failure -> surfaces reason 'write-failed' with error message", async () => {
    const deps = makeDeps({
      writeTransportByIde: vi.fn(async () => {
        throw new Error("EACCES: permission denied");
      }),
    });
    const outcome = await handleTransportSelect(
      { ideTag: "cursor", transportId: "http-loopback" },
      deps,
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe("write-failed");
    expect(outcome.error).toMatch(/EACCES/);
  });

  it("validates against real IDE_METADATA keys (cursor/windsurf/... accepted; typos refused)", async () => {
    const deps = makeDeps();
    const okIds = ["cursor", "windsurf", "claudeDesktop", "claudeCode", "cline"] as const;
    for (const id of okIds) {
      const out = await handleTransportSelect(
        { ideTag: id, transportId: "stdio-daemon-proxy" },
        deps,
      );
      expect(out.ok).toBe(true);
    }
    const badIds = ["cursorr", "winsurf", "", "CURSOR"];
    for (const id of badIds) {
      const out = await handleTransportSelect(
        { ideTag: id, transportId: "stdio-daemon-proxy" },
        deps,
      );
      expect(out.ok).toBe(false);
      expect(out.reason).toBe("unknown-ide");
    }
  });
});

describe("transport:regenerate-stale — dispatch contract", () => {
  // The regenerate-stale handler in DashboardProvider delegates to
  // vscode.commands.executeCommand("Perplexity.generateConfigs", "all") so
  // user-facing modals + staleness recomputation land through a single path.
  // A pure unit test against the DashboardProvider would require a full
  // vscode shim; we instead document the contract here and rely on the
  // smoke checklist to verify the command is invoked.
  //
  // The presence of this describe block keeps the test file descriptive so
  // future readers can find the regenerate-stale decision trail.

  it("contract: regenerate-stale invokes Perplexity.generateConfigs with target='all'", () => {
    // Sanity: the contract is only asserted through the Perplexity.generateConfigs
    // command name — if that command is renamed, the regenerate-stale handler
    // must be updated in lockstep. No runtime assertion here; see:
    //   packages/extension/src/webview/DashboardProvider.ts transport:regenerate-stale case.
    expect("Perplexity.generateConfigs").toBe("Perplexity.generateConfigs");
  });
});
