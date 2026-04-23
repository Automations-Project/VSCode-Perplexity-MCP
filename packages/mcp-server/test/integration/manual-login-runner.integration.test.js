import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start as startMock } from "./mock-server.js";
import { Vault } from "../../src/vault.js";
import { createProfile, setActive, getProfilePaths } from "../../src/profiles.js";

const RUNNER = fileURLToPath(new URL("../../dist/manual-login-runner.mjs", import.meta.url));

function fork_(env, ipcMessages = []) {
  return new Promise((resolve) => {
    const child = fork(RUNNER, [], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe", "ipc"] });
    const msgs = [];
    let out = "";
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.on("message", (m) => {
      msgs.push(m);
      const next = ipcMessages.shift();
      if (next) child.send(next);
    });
    child.on("close", (code) => {
      const lines = out.trim().split("\n").filter(Boolean);
      resolve({ code, result: JSON.parse(lines[lines.length - 1]), msgs });
    });
  });
}

describe("manual-login-runner (integration)", () => {
  let mock, configDir;
  beforeAll(async () => { mock = await startMock({ port: 0 }); });
  afterAll(async () => { await mock.close(); });

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "px-man-"));
    process.env.PERPLEXITY_CONFIG_DIR = configDir;
    process.env.PERPLEXITY_VAULT_PASSPHRASE = "test-pass-2";
    createProfile("default");
    setActive("default");
  });

  it("emits awaiting_user, then writes vault + .reinit + exits 0 after auto-login", async () => {
    const { code, result, msgs } = await fork_({
      PERPLEXITY_CONFIG_DIR: configDir,
      PERPLEXITY_VAULT_PASSPHRASE: "test-pass-2",
      PERPLEXITY_PROFILE: "default",
      PERPLEXITY_ORIGIN: mock.url,
      PERPLEXITY_LOGIN_PATH: "/login",
      PERPLEXITY_TEST_AUTO_LOGIN_EMAIL: "user@mock.test",
      PERPLEXITY_POLL_MS: "200",
    });

    expect(msgs.some((m) => m?.phase === "awaiting_user")).toBe(true);
    expect(code).toBe(0);
    expect(result.ok).toBe(true);
    expect(result.email).toBeUndefined();   // PII-min: not in exit payload

    const vault = new Vault();
    const cookies = JSON.parse(await vault.get("default", "cookies"));
    expect(cookies.some((c) => c.name === "__Secure-next-auth.session-token")).toBe(true);
    expect(await vault.get("default", "email")).toBe("user@mock.test");
    expect(await vault.get("default", "userId")).toMatch(/^user_/);

    expect(existsSync(getProfilePaths("default").reinit)).toBe(true);
  }, 30_000);

  it("exits 2 {reason:'cancelled'} when the browser closes before the session cookie appears", async () => {
    const { code, result } = await fork_({
      PERPLEXITY_CONFIG_DIR: configDir,
      PERPLEXITY_VAULT_PASSPHRASE: "test-pass-2",
      PERPLEXITY_PROFILE: "default",
      PERPLEXITY_ORIGIN: mock.url,
      PERPLEXITY_LOGIN_PATH: "/login",
      PERPLEXITY_TEST_BROWSER_CLOSE_AFTER_MS: "500",
    });
    expect(code).toBe(2);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("cancelled");
  }, 15_000);

  it("exits 3 {reason:'cf_blocked'} when CF challenge never resolves", async () => {
    const { code, result } = await fork_({
      PERPLEXITY_CONFIG_DIR: configDir,
      PERPLEXITY_VAULT_PASSPHRASE: "test-pass-2",
      PERPLEXITY_PROFILE: "default",
      PERPLEXITY_ORIGIN: `${mock.url}/login?force_cf=1`,
      PERPLEXITY_CF_TIMEOUT_MS: "1000",
    });
    expect(code).toBe(3);
    expect(result.reason).toBe("cf_blocked");
  }, 15_000);
});
