import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { withScopedVaultPassphrase } from "../src/auth/scoped-env.js";

const ENV_KEY = "PERPLEXITY_VAULT_PASSPHRASE";

describe("withScopedVaultPassphrase", () => {
  beforeEach(() => {
    delete process.env[ENV_KEY];
  });

  afterEach(() => {
    delete process.env[ENV_KEY];
  });

  it("sets env for the duration of the callback then deletes", async () => {
    const seen: Array<string | undefined> = [];
    await withScopedVaultPassphrase("secret-1", async () => {
      seen.push(process.env[ENV_KEY]);
    });
    expect(seen).toEqual(["secret-1"]);
    expect(process.env[ENV_KEY]).toBeUndefined();
  });

  it("skips the branch entirely when passphrase is undefined", async () => {
    process.env[ENV_KEY] = "ambient-value";
    const seen: Array<string | undefined> = [];
    await withScopedVaultPassphrase(undefined, async () => {
      seen.push(process.env[ENV_KEY]);
    });
    // Caller asked for no injection — env untouched, including a pre-existing ambient.
    expect(seen).toEqual(["ambient-value"]);
    expect(process.env[ENV_KEY]).toBe("ambient-value");
  });

  it("restores a pre-existing env value instead of deleting it", async () => {
    process.env[ENV_KEY] = "ambient-value";
    await withScopedVaultPassphrase("overridden", async () => {
      expect(process.env[ENV_KEY]).toBe("overridden");
    });
    expect(process.env[ENV_KEY]).toBe("ambient-value");
  });

  it("cleans up the env even when the callback throws", async () => {
    await expect(
      withScopedVaultPassphrase("secret", async () => {
        expect(process.env[ENV_KEY]).toBe("secret");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(process.env[ENV_KEY]).toBeUndefined();
  });

  it("propagates the callback's return value", async () => {
    const result = await withScopedVaultPassphrase("secret", async () => 42);
    expect(result).toBe(42);
  });
});
