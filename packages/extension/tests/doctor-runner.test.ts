import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as path from "node:path";

vi.mock("vscode", () => {
  const Uri = {
    file: (p: string) => ({ fsPath: p }),
    joinPath: (base: { fsPath: string }, ...segments: string[]) => ({
      fsPath: path.join(base.fsPath, ...segments),
    }),
  };
  return { Uri };
});

vi.mock("perplexity-user-mcp", () => ({
  runDoctor: vi.fn(async (opts: unknown) => ({ opts, receivedEnvPassphrase: process.env.PERPLEXITY_VAULT_PASSPHRASE })),
}));

vi.mock("../src/auto-config/index.js", () => ({
  getIdeStatuses: vi.fn((bundledServerPath: string, chromePath: string | undefined) => ({
    __bundledServerPath: bundledServerPath,
    __chromePath: chromePath,
  })),
}));

import { runDoctor as runDoctorCore } from "perplexity-user-mcp";
import { createExtensionAwareRunDoctor } from "../src/diagnostics/doctor-runner.js";

const runDoctorMock = runDoctorCore as unknown as ReturnType<typeof vi.fn>;

const ENV_KEY = "PERPLEXITY_VAULT_PASSPHRASE";

function makeContext(extensionUriFsPath = "/ext"): import("vscode").ExtensionContext {
  return {
    extensionUri: { fsPath: extensionUriFsPath },
  } as unknown as import("vscode").ExtensionContext;
}

describe("createExtensionAwareRunDoctor", () => {
  beforeEach(() => {
    runDoctorMock.mockClear();
    delete process.env[ENV_KEY];
  });

  afterEach(() => {
    delete process.env[ENV_KEY];
  });

  it("passes baseDir, ideStatuses derived from extensionUri", async () => {
    const context = makeContext("/home/me/.vscode/ext");
    const run = createExtensionAwareRunDoctor(context, {
      getChromePath: () => "/chrome",
    });

    await run();

    expect(runDoctorMock).toHaveBeenCalledTimes(1);
    const opts = runDoctorMock.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.baseDir).toMatch(/dist$/);
    expect(opts.ideStatuses).toMatchObject({
      __bundledServerPath: expect.stringMatching(/dist[\\/]mcp[\\/]server\.mjs$/),
      __chromePath: "/chrome",
    });
  });

  it("forwards optional extras like { probe: true }", async () => {
    const run = createExtensionAwareRunDoctor(makeContext(), {
      getChromePath: () => undefined,
    });

    await run({ probe: true });

    const opts = runDoctorMock.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.probe).toBe(true);
  });

  it("injects passphrase via scoped env when getVaultPassphrase returns a value", async () => {
    const run = createExtensionAwareRunDoctor(makeContext(), {
      getChromePath: () => undefined,
      getVaultPassphrase: async () => "hunter22xx",
    });

    const result = await run();

    // Captured during the runDoctor call
    expect((result as { receivedEnvPassphrase?: string }).receivedEnvPassphrase).toBe("hunter22xx");
    // And cleaned up after
    expect(process.env[ENV_KEY]).toBeUndefined();
  });

  it("does not touch env when getVaultPassphrase returns undefined", async () => {
    const run = createExtensionAwareRunDoctor(makeContext(), {
      getChromePath: () => undefined,
      getVaultPassphrase: async () => undefined,
    });

    const result = await run();

    expect((result as { receivedEnvPassphrase?: string }).receivedEnvPassphrase).toBeUndefined();
    expect(process.env[ENV_KEY]).toBeUndefined();
  });

  it("restores a pre-existing env value rather than deleting it", async () => {
    process.env[ENV_KEY] = "ambient-value";
    const run = createExtensionAwareRunDoctor(makeContext(), {
      getChromePath: () => undefined,
      getVaultPassphrase: async () => "overridden",
    });

    const result = await run();

    expect((result as { receivedEnvPassphrase?: string }).receivedEnvPassphrase).toBe("overridden");
    expect(process.env[ENV_KEY]).toBe("ambient-value");
  });

  it("cleans up env even when runDoctor throws", async () => {
    runDoctorMock.mockImplementationOnce(async () => {
      expect(process.env[ENV_KEY]).toBe("secret");
      throw new Error("boom");
    });

    const run = createExtensionAwareRunDoctor(makeContext(), {
      getChromePath: () => undefined,
      getVaultPassphrase: async () => "secret",
    });

    await expect(run()).rejects.toThrow("boom");
    expect(process.env[ENV_KEY]).toBeUndefined();
  });

  it("skips the passphrase branch entirely when no provider is supplied", async () => {
    const run = createExtensionAwareRunDoctor(makeContext(), {
      getChromePath: () => undefined,
      // no getVaultPassphrase
    });

    await run();

    expect(process.env[ENV_KEY]).toBeUndefined();
    expect(runDoctorMock).toHaveBeenCalledTimes(1);
  });
});
