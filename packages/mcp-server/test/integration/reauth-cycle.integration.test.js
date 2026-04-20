import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start as startMock } from "./mock-server.js";
import { watchReinit } from "../../src/reinit-watcher.js";
import { createProfile, setActive } from "../../src/profiles.js";
import { Vault } from "../../src/vault.js";

describe("end-to-end re-auth cycle", () => {
  let mock, configDir;
  beforeAll(async () => { mock = await startMock({ port: 0 }); });
  afterAll(async () => { await mock.close(); });
  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "px-e2e-"));
    process.env.PERPLEXITY_CONFIG_DIR = configDir;
    process.env.PERPLEXITY_VAULT_PASSPHRASE = "e2e-pass";
    createProfile("default");
    setActive("default");
  });

  it("expired -> manual runner -> .reinit fires -> cookies present", async () => {
    let reinitFired = 0;
    const watcher = watchReinit("default", () => { reinitFired++; });
    try {
      const RUNNER = fileURLToPath(new URL("../../dist/manual-login-runner.mjs", import.meta.url));
      const child = fork(RUNNER, [], {
        env: {
          ...process.env,
          PERPLEXITY_CONFIG_DIR: configDir,
          PERPLEXITY_VAULT_PASSPHRASE: "e2e-pass",
          PERPLEXITY_PROFILE: "default",
          PERPLEXITY_ORIGIN: mock.url,
      PERPLEXITY_LOGIN_PATH: "/login",
          PERPLEXITY_TEST_AUTO_LOGIN_EMAIL: "e2e@mock.test",
          PERPLEXITY_POLL_MS: "200",
        },
        stdio: ["pipe", "pipe", "pipe", "ipc"],
      });
      await new Promise((r) => child.on("close", r));
      await new Promise((r) => setTimeout(r, 400));
      expect(reinitFired).toBeGreaterThanOrEqual(1);
      const cookies = JSON.parse(await new Vault().get("default", "cookies"));
      expect(cookies.some((c) => c.name === "__Secure-next-auth.session-token")).toBe(true);
    } finally { watcher.dispose(); }
  }, 30_000);
});
