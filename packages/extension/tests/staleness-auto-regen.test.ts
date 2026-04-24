import { describe, expect, it, vi } from "vitest";
import type { McpTransportId } from "@perplexity-user-mcp/shared";

import type {
  ApplyIdeConfigDeps,
  ApplyIdeConfigResult,
  IdeConfigOptions,
} from "../src/auto-config/index.js";
import {
  regenerateStaleIdes,
  wrapDepsForAutoRegen,
  type RegenerateStaleIdesDeps,
  type RegenerateStaleIdesInput,
} from "../src/webview/staleness-auto-regen.js";
import type { StaleConfigEntry } from "../src/webview/staleness-detector.js";

/**
 * v0.8.5 - auto-regenerate stale IDE configs.
 *
 * Invariants exercised here:
 *   1. Setting off -> no applyIdeConfig call, no refresh, banner remains.
 *   2. Setting on  -> each stale IDE gets applyIdeConfig with the correct
 *      transport from mcpTransportByIde (fallback to MCP_TRANSPORT_DEFAULT).
 *   3. confirmTransport on the wrapped deps always returns true (no prompt).
 *   4. One IDE throwing does not stop the batch.
 *   5. refresh() is called once per `ran=true` batch so the banner clears.
 *   6. The audit override appends `auto=true` without mutating the base fields.
 */

function makeInput(overrides: Partial<RegenerateStaleIdesInput> = {}): RegenerateStaleIdesInput {
  return {
    stale: overrides.stale ?? [],
    autoRegenerateStaleConfigs: overrides.autoRegenerateStaleConfigs ?? true,
    mcpTransportByIde: overrides.mcpTransportByIde ?? {},
    serverPath: overrides.serverPath ?? "/opt/launcher.mjs",
    chromePath: overrides.chromePath,
  };
}

interface RecordedCall {
  options: IdeConfigOptions;
  deps: ApplyIdeConfigDeps;
}

function makeDeps(overrides: {
  applyIdeConfig?: (options: IdeConfigOptions, deps: ApplyIdeConfigDeps) => Promise<ApplyIdeConfigResult>;
  debug?: (line: string) => void;
  refresh?: () => Promise<void>;
  buildDeps?: () => Promise<ApplyIdeConfigDeps>;
} = {}): {
  deps: RegenerateStaleIdesDeps;
  calls: RecordedCall[];
  debugLines: string[];
  refreshCount: number;
} {
  const calls: RecordedCall[] = [];
  const debugLines: string[] = [];
  let refreshCount = 0;

  const baseApply =
    overrides.applyIdeConfig
    ?? (async (options, deps) => {
      calls.push({ options, deps });
      return {
        ok: true,
        path: `/fake/${options.target}.json`,
        bearerKind: "static",
        transportId: options.transportId ?? "stdio-daemon-proxy",
        warnings: [],
      } satisfies ApplyIdeConfigResult;
    });

  const wrappedApply: RegenerateStaleIdesDeps["applyIdeConfig"] = async (options, deps) => {
    if (!overrides.applyIdeConfig) {
      // When the caller did not override, record the call here. When they did,
      // the override is responsible for recording into `calls` itself if it wants.
      return baseApply(options, deps);
    }
    calls.push({ options, deps });
    return overrides.applyIdeConfig(options, deps);
  };

  const deps: RegenerateStaleIdesDeps = {
    buildDeps:
      overrides.buildDeps
      ?? (async () => ({
        confirmTransport: async () => true,
        nudgePortPin: () => {},
        auditGenerated: () => {},
      })),
    applyIdeConfig: wrappedApply,
    debug: (line) => {
      debugLines.push(line);
      overrides.debug?.(line);
    },
    refresh: async () => {
      refreshCount += 1;
      await overrides.refresh?.();
    },
  };

  return {
    deps,
    calls,
    debugLines,
    get refreshCount() {
      return refreshCount;
    },
  } as { deps: RegenerateStaleIdesDeps; calls: RecordedCall[]; debugLines: string[]; refreshCount: number };
}

describe("regenerateStaleIdes", () => {
  it("no-ops when the stale list is empty (ran=false)", async () => {
    const harness = makeDeps();
    const outcome = await regenerateStaleIdes(makeInput({ stale: [] }), harness.deps);

    expect(outcome.ran).toBe(false);
    expect(outcome.results).toEqual([]);
    expect(harness.calls).toEqual([]);
    expect(harness.refreshCount).toBe(0);
  });

  it("no-ops when the setting is off, even with stale entries", async () => {
    const stale: StaleConfigEntry[] = [
      { ideTag: "cursor", reason: "url" },
      { ideTag: "claudeDesktop", reason: "bearer" },
    ];
    const harness = makeDeps();
    const outcome = await regenerateStaleIdes(
      makeInput({ stale, autoRegenerateStaleConfigs: false }),
      harness.deps,
    );

    expect(outcome.ran).toBe(false);
    expect(outcome.results).toEqual([]);
    expect(harness.calls).toEqual([]);
    expect(harness.refreshCount).toBe(0);
    expect(harness.debugLines.some((l) => l.includes("auto-regenerate disabled"))).toBe(true);
  });

  it("invokes applyIdeConfig for every stale entry with the correct transport", async () => {
    const stale: StaleConfigEntry[] = [
      { ideTag: "cursor", reason: "url" },
      { ideTag: "claudeDesktop", reason: "bearer" },
      { ideTag: "windsurf", reason: "url" },
    ];
    const mcpTransportByIde: Record<string, McpTransportId> = {
      cursor: "http-loopback",
      claudeDesktop: "http-tunnel",
      // windsurf intentionally omitted -> must fall back to MCP_TRANSPORT_DEFAULT (stdio-daemon-proxy).
    };

    const harness = makeDeps();
    const outcome = await regenerateStaleIdes(
      makeInput({ stale, mcpTransportByIde, serverPath: "/srv/launcher.mjs" }),
      harness.deps,
    );

    expect(outcome.ran).toBe(true);
    expect(outcome.results.map((r) => ({ ide: r.ideTag, transport: r.transportId, status: r.status }))).toEqual([
      { ide: "cursor", transport: "http-loopback", status: "ok" },
      { ide: "claudeDesktop", transport: "http-tunnel", status: "ok" },
      { ide: "windsurf", transport: "stdio-daemon-proxy", status: "ok" },
    ]);
    expect(harness.calls).toHaveLength(3);
    expect(harness.calls[0].options).toEqual({
      target: "cursor",
      serverPath: "/srv/launcher.mjs",
      chromePath: undefined,
      transportId: "http-loopback",
    });
    expect(harness.calls[1].options.transportId).toBe("http-tunnel");
    expect(harness.calls[2].options.transportId).toBe("stdio-daemon-proxy");
    expect(harness.refreshCount).toBe(1);
  });

  it("skips unknown ide tags (derived from stale on-disk config) without throwing", async () => {
    const stale: StaleConfigEntry[] = [
      { ideTag: "cursor", reason: "url" },
      { ideTag: "retiredIDE", reason: "url" },
    ];
    const harness = makeDeps();

    const outcome = await regenerateStaleIdes(makeInput({ stale }), harness.deps);

    expect(outcome.ran).toBe(true);
    expect(harness.calls.map((c) => c.options.target)).toEqual(["cursor"]);
    expect(outcome.results.find((r) => r.ideTag === "retiredIDE")?.status).toBe("skipped-unknown-ide");
  });

  it("per-IDE try/catch: a throwing IDE does not block the rest of the batch", async () => {
    const stale: StaleConfigEntry[] = [
      { ideTag: "cursor", reason: "url" },
      { ideTag: "claudeDesktop", reason: "url" },
      { ideTag: "windsurf", reason: "url" },
    ];
    const harness = makeDeps({
      applyIdeConfig: async (options) => {
        if (options.target === "claudeDesktop") {
          throw new Error("boom: disk permission denied");
        }
        return {
          ok: true,
          path: `/fake/${options.target}.json`,
          bearerKind: "static",
          transportId: options.transportId ?? "stdio-daemon-proxy",
          warnings: [],
        };
      },
    });

    const outcome = await regenerateStaleIdes(makeInput({ stale }), harness.deps);

    expect(outcome.ran).toBe(true);
    expect(outcome.results).toHaveLength(3);
    expect(outcome.results[0].status).toBe("ok");
    expect(outcome.results[1].status).toBe("threw");
    expect(outcome.results[1].message).toContain("boom");
    expect(outcome.results[2].status).toBe("ok");
    expect(harness.refreshCount).toBe(1);
  });

  it("surfaces applyIdeConfig's ok=false outcomes as 'failed' without interrupting the batch", async () => {
    const stale: StaleConfigEntry[] = [
      { ideTag: "cursor", reason: "url" },
      { ideTag: "claudeDesktop", reason: "url" },
    ];
    const harness = makeDeps({
      applyIdeConfig: async (options) => {
        if (options.target === "cursor") {
          return {
            ok: false,
            reason: "sync-folder",
            message: "config in iCloud Drive",
            transportId: options.transportId ?? "stdio-daemon-proxy",
          };
        }
        return {
          ok: true,
          path: `/fake/${options.target}.json`,
          bearerKind: "static",
          transportId: options.transportId ?? "stdio-daemon-proxy",
          warnings: [],
        };
      },
    });

    const outcome = await regenerateStaleIdes(makeInput({ stale }), harness.deps);

    expect(outcome.results[0]).toMatchObject({ status: "failed", reason: "sync-folder" });
    expect(outcome.results[1].status).toBe("ok");
    expect(harness.refreshCount).toBe(1);
  });

  it("calls buildDeps exactly once per batch (not per-IDE)", async () => {
    const stale: StaleConfigEntry[] = [
      { ideTag: "cursor", reason: "url" },
      { ideTag: "claudeDesktop", reason: "url" },
      { ideTag: "windsurf", reason: "url" },
    ];
    const buildDeps = vi.fn(async () => ({
      confirmTransport: async () => true,
      nudgePortPin: () => {},
    }) satisfies ApplyIdeConfigDeps);
    const harness = makeDeps({ buildDeps });

    await regenerateStaleIdes(makeInput({ stale }), harness.deps);

    expect(buildDeps).toHaveBeenCalledTimes(1);
  });
});

describe("wrapDepsForAutoRegen", () => {
  it("forces confirmTransport to resolve true regardless of base behavior", async () => {
    const base: ApplyIdeConfigDeps = {
      confirmTransport: vi.fn(async () => false),
      nudgePortPin: vi.fn(),
      auditGenerated: vi.fn(),
    };
    const audits: string[] = [];
    const wrapped = wrapDepsForAutoRegen(base, (line) => audits.push(line));

    const approved = await wrapped.confirmTransport!({
      ideTag: "cursor",
      transportId: "http-loopback",
      configPath: "/tmp/mcp.json",
    });

    expect(approved).toBe(true);
    // The base confirmTransport must NOT be invoked - auto-regen bypasses the modal entirely.
    expect(base.confirmTransport).not.toHaveBeenCalled();
  });

  it("no-ops nudgePortPin so the user is not re-prompted mid-refresh", () => {
    const base: ApplyIdeConfigDeps = {
      nudgePortPin: vi.fn(),
    };
    const wrapped = wrapDepsForAutoRegen(base, () => {});

    wrapped.nudgePortPin!({ ideTag: "cursor" });
    expect(base.nudgePortPin).not.toHaveBeenCalled();
  });

  it("auditGenerated prepends auto=true tag and preserves the base fields", () => {
    const audits: string[] = [];
    const wrapped = wrapDepsForAutoRegen({}, (line) => audits.push(line));

    wrapped.auditGenerated!({
      ideTag: "cursor",
      transportId: "http-loopback",
      configPath: "/tmp/mcp.json",
      bearerKind: "static",
      resultCode: "ok",
      ts: "2026-04-24T00:00:00.000Z",
    });

    expect(audits).toHaveLength(1);
    expect(audits[0]).toContain("ide=cursor");
    expect(audits[0]).toContain("transport=http-loopback");
    expect(audits[0]).toContain("bearer=static");
    expect(audits[0]).toContain("result=ok");
    expect(audits[0]).toContain("path=/tmp/mcp.json");
    expect(audits[0]).toContain("auto=true");
  });

  it("warnSyncFolder is NOT overridden: sync-folder gate still fires even on refresh", () => {
    const warnSyncFolder = vi.fn();
    const base: ApplyIdeConfigDeps = { warnSyncFolder };
    const wrapped = wrapDepsForAutoRegen(base, () => {});

    // The wrapped deps must preserve reference equality to the base sync-folder handler.
    expect(wrapped.warnSyncFolder).toBe(warnSyncFolder);
  });
});
