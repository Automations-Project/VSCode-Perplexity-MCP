import { describe, it, expect, vi } from "vitest";

// vitest's Node environment has no real "vscode" module — every extension test
// in this repo mocks it. We don't call any vscode runtime API here (the fake
// context's `.secrets` is wired by the test), but vault-passphrase.ts does
// `import * as vscode from "vscode"` and we transitively load it through
// build-daemon-env.ts, so the mock must exist before the import below.
vi.mock("vscode", () => ({
  window: {
    showInputBox: async () => undefined,
  },
}));

import * as vscode from "vscode";
import { buildDaemonEnv } from "../src/auth/build-daemon-env";

function fakeContext(stored: string | undefined): vscode.ExtensionContext {
  return {
    secrets: {
      get: vi.fn(async (key: string) =>
        key === "perplexity.vault.passphrase" ? stored : undefined,
      ),
      store: vi.fn(),
      delete: vi.fn(),
      onDidChange: vi.fn(),
    },
  } as unknown as vscode.ExtensionContext;
}

describe("buildDaemonEnv", () => {
  it("returns empty object when SecretStorage is empty", async () => {
    const env = await buildDaemonEnv(fakeContext(undefined));
    expect(env).toEqual({});
  });

  it("returns PERPLEXITY_VAULT_PASSPHRASE when SecretStorage has a value", async () => {
    const env = await buildDaemonEnv(fakeContext("hunter2-correct-horse"));
    expect(env).toEqual({ PERPLEXITY_VAULT_PASSPHRASE: "hunter2-correct-horse" });
  });

  it("ignores empty-string passphrase (treats as absent)", async () => {
    const env = await buildDaemonEnv(fakeContext(""));
    expect(env).toEqual({});
  });

  it("does not mutate process.env", async () => {
    const before = process.env.PERPLEXITY_VAULT_PASSPHRASE;
    await buildDaemonEnv(fakeContext("never-leak-this"));
    expect(process.env.PERPLEXITY_VAULT_PASSPHRASE).toBe(before);
  });
});
