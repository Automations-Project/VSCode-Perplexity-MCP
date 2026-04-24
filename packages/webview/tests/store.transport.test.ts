import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionMessage } from "@perplexity-user-mcp/shared";
import { useDashboardStore } from "../src/store";

// Phase 8.6.5: the webview store owns a `staleConfigs` slice that is populated
// by the `transport:staleness` ExtensionMessage. The extension host is
// authoritative — each message overwrites the entire prior array, including
// an explicit empty array (which is a meaningful "zero stale" signal and must
// not collapse back to `null`).

describe("store — transport:staleness", () => {
  beforeEach(() => {
    useDashboardStore.setState({ staleConfigs: null });
  });

  afterEach(() => {
    useDashboardStore.setState({ staleConfigs: null });
  });

  it("initial staleConfigs slice is null (pre-hydrate, no signal yet)", () => {
    expect(useDashboardStore.getState().staleConfigs).toBeNull();
  });

  it("dispatching transport:staleness with a non-empty array populates staleConfigs", () => {
    const { hydrate } = useDashboardStore.getState();
    const msg: ExtensionMessage = {
      type: "transport:staleness",
      payload: {
        stale: [
          { ideTag: "cursor", reason: "bearer" },
          { ideTag: "claudeCode", reason: "url" },
        ],
      },
    };
    hydrate(msg);
    expect(useDashboardStore.getState().staleConfigs).toEqual([
      { ideTag: "cursor", reason: "bearer" },
      { ideTag: "claudeCode", reason: "url" },
    ]);
  });

  it("a second transport:staleness overwrites the prior slice (not merges)", () => {
    const { hydrate } = useDashboardStore.getState();
    hydrate({
      type: "transport:staleness",
      payload: { stale: [{ ideTag: "cursor", reason: "bearer" }] },
    });
    expect(useDashboardStore.getState().staleConfigs?.length).toBe(1);
    hydrate({
      type: "transport:staleness",
      payload: {
        stale: [
          { ideTag: "windsurf", reason: "url" },
          { ideTag: "amp", reason: "bearer" },
        ],
      },
    });
    const after = useDashboardStore.getState().staleConfigs;
    expect(after).toEqual([
      { ideTag: "windsurf", reason: "url" },
      { ideTag: "amp", reason: "bearer" },
    ]);
  });

  it("transport:staleness with payload.stale = [] sets staleConfigs to [] (NOT null)", () => {
    const { hydrate } = useDashboardStore.getState();
    // First seed with some stale items to prove the zero-signal overwrites, not
    // just short-circuits a null initial.
    hydrate({
      type: "transport:staleness",
      payload: { stale: [{ ideTag: "cursor", reason: "bearer" }] },
    });
    expect(useDashboardStore.getState().staleConfigs?.length).toBe(1);
    hydrate({ type: "transport:staleness", payload: { stale: [] } });
    const slice = useDashboardStore.getState().staleConfigs;
    // Empty array and null must be distinguishable — the UI hides the banner
    // for both but uses the difference to avoid flashing during pre-hydrate.
    expect(slice).toEqual([]);
    expect(slice).not.toBeNull();
  });
});
