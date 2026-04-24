/**
 * Lazy-load defense for the ngrok provider.
 *
 * Regression against the 0.8.5 → 0.8.6 Linux activation crash:
 *   Error: Cannot find module '@ngrok/ngrok-linux-x64-gnu'
 * The VSIX was packaged on Windows and shipped only the win32 NAPI
 * subpackage; on Linux the top-level `import ngrok from "@ngrok/ngrok"` in
 * tunnel-providers/ngrok.ts crashed extension activation before the
 * webview ever registered.
 *
 * These tests assert:
 *   1. Importing the tunnel-providers index (and ngrok.ts directly) does NOT
 *      eagerly load the native binding.
 *   2. `isSetupComplete` never throws — if the native is missing it reports
 *      setup.ready === false with a user-facing reason.
 *   3. Calling `start()` when the native is missing surfaces
 *      NgrokNativeMissingError with platform/arch context, not a raw
 *      MODULE_NOT_FOUND.
 *   4. If @ngrok/ngrok loads successfully but fails for a non-MODULE-NOT-FOUND
 *      reason, the original error propagates (we do NOT silently upgrade
 *      everything to NgrokNativeMissingError).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDirs = [];

/**
 * Make the dynamic `import("@ngrok/ngrok")` throw a MODULE_NOT_FOUND on the
 * platform-specific subpackage. Vitest mock factories don't let us throw
 * synchronously (that's caught as a mock-setup error), but they DO let us
 * return a module whose property access triggers our thrower. We lean on the
 * fact that ngrok.ts destructures `.default ?? mod` — if the factory returns
 * an ESM-namespace-shaped object with a getter that throws, the access path
 * behaves exactly like a real native-subpackage miss.
 *
 * For the stricter test-of-last-resort we prime a shared mutable flag the
 * factory closes over, rather than throwing from the factory body itself.
 */
function mockNgrokNativeMissing() {
  vi.doMock("@ngrok/ngrok", () => {
    const err = Object.assign(
      new Error("Cannot find module '@ngrok/ngrok-linux-x64-gnu'"),
      { code: "MODULE_NOT_FOUND" },
    );
    // Return a module whose default export getter throws. When ngrok.ts does
    // `mod.default ?? mod`, accessing `.default` surfaces the synthesized
    // MODULE_NOT_FOUND — mimicking the real failure shape from 0.8.5.
    return new Proxy(
      {},
      {
        get(_target, prop) {
          // Let Symbol.toStringTag etc. return undefined quietly so the
          // module namespace object is still constructible; only userland
          // property reads throw.
          if (typeof prop === "symbol") return undefined;
          throw err;
        },
      },
    );
  });
}

function mockNgrokNativeBrokenNonMissing() {
  vi.doMock("@ngrok/ngrok", () => {
    const err = new TypeError("ngrok init blew up for an unrelated reason");
    return new Proxy(
      {},
      {
        get(_target, prop) {
          if (typeof prop === "symbol") return undefined;
          throw err;
        },
      },
    );
  });
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("@ngrok/ngrok");
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    rmSync(dir, { recursive: true, force: true });
  }
});

function mkTempConfigDir() {
  const dir = mkdtempSync(join(tmpdir(), "pplx-ngrok-lazy-"));
  tempDirs.push(dir);
  return dir;
}

function writeNgrokTokenFile(configDir, authtoken = "fake-authtoken-0123456789") {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "ngrok.json"),
    JSON.stringify({ authtoken, updatedAt: new Date().toISOString() }) + "\n",
    "utf8",
  );
}

describe("ngrok provider — lazy native load", () => {
  it("imports the tunnel-providers index without loading @ngrok/ngrok", async () => {
    // If the index statically imported @ngrok/ngrok, module resolution alone
    // would trigger the proxy's getter and crash the import. Our lazy refactor
    // means the access never happens at module-load time, so we can enumerate
    // the registry without touching the native binding at all.
    mockNgrokNativeMissing();

    const mod = await import("../../src/daemon/tunnel-providers/index.ts");
    expect(typeof mod.getTunnelProvider).toBe("function");
    expect(typeof mod.listTunnelProviders).toBe("function");
    const providers = mod.listTunnelProviders();
    expect(providers.find((p) => p.id === "ngrok")).toBeDefined();
    expect(providers.find((p) => p.id === "cf-quick")).toBeDefined();
    expect(providers.find((p) => p.id === "cf-named")).toBeDefined();
  });

  it("imports ngrok.ts directly without loading @ngrok/ngrok", async () => {
    mockNgrokNativeMissing();

    const mod = await import("../../src/daemon/tunnel-providers/ngrok.ts");
    expect(mod.ngrokProvider.id).toBe("ngrok");
    expect(mod.ngrokProvider.displayName).toBe("ngrok");
    expect(typeof mod.loadNgrokNative).toBe("function");
    expect(typeof mod.NgrokNativeMissingError).toBe("function");
  });

  it("isSetupComplete reports native-missing without throwing", async () => {
    mockNgrokNativeMissing();
    const { ngrokProvider, __resetNgrokNativeCacheForTests } = await import(
      "../../src/daemon/tunnel-providers/ngrok.ts"
    );
    __resetNgrokNativeCacheForTests();

    const configDir = mkTempConfigDir();
    writeNgrokTokenFile(configDir); // token present; native still missing
    const setup = await ngrokProvider.isSetupComplete(configDir);
    expect(setup.ready).toBe(false);
    expect(setup.reason).toMatch(/@ngrok\/ngrok native binding/);
    expect(setup.reason).toMatch(new RegExp(`${process.platform}-${process.arch}`));
  });

  it("listTunnelProviderStatuses survives when ngrok native is missing", async () => {
    mockNgrokNativeMissing();
    const { listTunnelProviderStatuses } = await import(
      "../../src/daemon/tunnel-providers/index.ts"
    );
    const { __resetNgrokNativeCacheForTests } = await import(
      "../../src/daemon/tunnel-providers/ngrok.ts"
    );
    __resetNgrokNativeCacheForTests();

    const configDir = mkTempConfigDir();
    const statuses = await listTunnelProviderStatuses(configDir);
    const ngrokStatus = statuses.find((s) => s.id === "ngrok");
    expect(ngrokStatus).toBeDefined();
    expect(ngrokStatus.setup.ready).toBe(false);
    expect(ngrokStatus.setup.reason).toMatch(/native binding/i);
    // Other providers must still be reported — one missing native mustn't
    // knock out the whole registry.
    expect(statuses.find((s) => s.id === "cf-quick")).toBeDefined();
    expect(statuses.find((s) => s.id === "cf-named")).toBeDefined();
  });

  it("start() throws NgrokNativeMissingError (not raw MODULE_NOT_FOUND) on missing native", async () => {
    mockNgrokNativeMissing();
    const { ngrokProvider, NgrokNativeMissingError, __resetNgrokNativeCacheForTests } = await import(
      "../../src/daemon/tunnel-providers/ngrok.ts"
    );
    __resetNgrokNativeCacheForTests();

    const configDir = mkTempConfigDir();
    writeNgrokTokenFile(configDir);

    let caught;
    try {
      await ngrokProvider.start({
        port: 9999,
        configDir,
        onStateChange: () => {},
      });
      throw new Error("start() should have thrown but did not");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NgrokNativeMissingError);
    expect(caught.message).toMatch(/@ngrok\/ngrok native binding/);
    expect(caught.message).toMatch(new RegExp(`${process.platform}-${process.arch}`));
    // Original cause preserved for debugging/telemetry.
    expect(caught.cause).toBeDefined();
    expect(String(caught.cause?.message ?? caught.cause)).toMatch(/Cannot find module/);
  });

  it("loadNgrokNative caches the module on success", async () => {
    const fakeForward = vi.fn(async () => ({
      url: () => "https://fake.ngrok-free.app",
      close: async () => {},
    }));
    const factory = vi.fn(() => ({
      default: { forward: fakeForward, kill: async () => {} },
    }));
    vi.doMock("@ngrok/ngrok", factory);

    const { loadNgrokNative, __resetNgrokNativeCacheForTests } = await import(
      "../../src/daemon/tunnel-providers/ngrok.ts"
    );
    __resetNgrokNativeCacheForTests();

    const a = await loadNgrokNative();
    const b = await loadNgrokNative();
    expect(a).toBe(b);
    expect(typeof a.forward).toBe("function");
    // Factory is called at most once per ESM module graph; we only assert that
    // repeated loadNgrokNative() calls return the same cached reference.
  });

  it("propagates non-MODULE_NOT_FOUND errors from the ngrok module", async () => {
    // Deliberately NOT a module-not-found — something broken inside the
    // package itself. We must not swallow this as NgrokNativeMissingError.
    mockNgrokNativeBrokenNonMissing();
    const { loadNgrokNative, NgrokNativeMissingError, __resetNgrokNativeCacheForTests } = await import(
      "../../src/daemon/tunnel-providers/ngrok.ts"
    );
    __resetNgrokNativeCacheForTests();

    let caught;
    try {
      await loadNgrokNative();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught).not.toBeInstanceOf(NgrokNativeMissingError);
    expect(caught.message).toMatch(/ngrok init blew up/);
  });

  it("isSetupComplete still gates on authtoken when native IS available", async () => {
    vi.doMock("@ngrok/ngrok", () => ({
      default: {
        forward: async () => ({ url: () => "https://x", close: async () => {} }),
        kill: async () => {},
      },
    }));
    const { ngrokProvider, __resetNgrokNativeCacheForTests } = await import(
      "../../src/daemon/tunnel-providers/ngrok.ts"
    );
    __resetNgrokNativeCacheForTests();

    const configDir = mkTempConfigDir();
    // No authtoken written — should report "authtoken not set", not native-missing.
    const setup = await ngrokProvider.isSetupComplete(configDir);
    expect(setup.ready).toBe(false);
    expect(setup.reason).toMatch(/authtoken not set/i);
    expect(setup.action?.kind).toBe("open-url");
  });

  it("provider registry exposes ngrok metadata without invoking native", async () => {
    // Even if the native is BROKEN beyond MODULE_NOT_FOUND, reading static
    // metadata (id / displayName / description) must never touch it.
    mockNgrokNativeMissing();

    const { getTunnelProvider } = await import("../../src/daemon/tunnel-providers/index.ts");
    const provider = getTunnelProvider("ngrok");
    expect(provider.id).toBe("ngrok");
    expect(provider.displayName).toBe("ngrok");
    expect(provider.description).toMatch(/ngrok/i);
  });
});
