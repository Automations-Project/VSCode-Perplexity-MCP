import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start as startMock } from "./mock-server.js";
import { Vault } from "../../src/vault.js";
import { createProfile, setActive } from "../../src/profiles.js";

const RUNNER = fileURLToPath(new URL("../../dist/health-check.mjs", import.meta.url));

function runRunner(env) {
  return new Promise((resolve, reject) => {
    const child = fork(RUNNER, [], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe", "ipc"],
    });
    let out = "";
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.on("close", (code) => {
      const lines = out.trim().split("\n").filter(Boolean);
      const last = lines[lines.length - 1];
      try { resolve({ code, result: JSON.parse(last) }); }
      catch (e) { reject(new Error(`bad runner output: ${out}`)); }
    });
    child.on("error", reject);
  });
}

describe("health-check runner (integration)", () => {
  let mock, configDir, vault;
  beforeAll(async () => { mock = await startMock({ port: 0 }); });
  afterAll(async () => { await mock.close(); });

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "px-health-"));
    process.env.PERPLEXITY_CONFIG_DIR = configDir;
    process.env.PERPLEXITY_VAULT_PASSPHRASE = "test-pass-1";
    createProfile("default");
    setActive("default");
    vault = new Vault();
  });

  it("returns {valid:true, tier:'Pro', modelCount:2} for a good session", async () => {
    await vault.set("default", "cookies", JSON.stringify([
      { name: "__Secure-next-auth.session-token", value: (await seedMockSession(mock)).token,
        domain: "127.0.0.1", path: "/", secure: false, httpOnly: true, sameSite: "Lax" },
    ]));

    const { code, result } = await runRunner({
      PERPLEXITY_CONFIG_DIR: configDir,
      PERPLEXITY_VAULT_PASSPHRASE: "test-pass-1",
      PERPLEXITY_PROFILE: "default",
      PERPLEXITY_ORIGIN: mock.url,
      PERPLEXITY_LOGIN_PATH: "/login",
    });

    expect(code).toBe(0);
    expect(result.valid).toBe(true);
    expect(result.tier).toBe("Pro");
    expect(result.modelCount).toBe(2);
    expect(result.userId).toBeUndefined();
  });

  it("returns {valid:false, reason:'no_cookies'} when the vault has no cookies", async () => {
    const { code, result } = await runRunner({
      PERPLEXITY_CONFIG_DIR: configDir,
      PERPLEXITY_VAULT_PASSPHRASE: "test-pass-1",
      PERPLEXITY_PROFILE: "default",
      PERPLEXITY_ORIGIN: mock.url,
      PERPLEXITY_LOGIN_PATH: "/login",
    });
    expect(code).toBe(2);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("no_cookies");
  });

  it("returns {valid:false, reason:'expired'} when the session is not recognized", async () => {
    await vault.set("default", "cookies", JSON.stringify([
      { name: "__Secure-next-auth.session-token", value: "bogus-token",
        domain: "127.0.0.1", path: "/", secure: false, httpOnly: true, sameSite: "Lax" },
    ]));
    const { code, result } = await runRunner({
      PERPLEXITY_CONFIG_DIR: configDir,
      PERPLEXITY_VAULT_PASSPHRASE: "test-pass-1",
      PERPLEXITY_PROFILE: "default",
      PERPLEXITY_ORIGIN: mock.url,
      PERPLEXITY_LOGIN_PATH: "/login",
    });
    expect(code).toBe(2);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("expired");
  });
});

async function seedMockSession(mock) {
  await fetch(`${mock.url}/login/email`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "a@b.co" }) });
  const r = await fetch(`${mock.url}/login/otp`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "a@b.co", otp: "123456" }) });
  const setCookie = r.headers.get("set-cookie");
  const token = /__Secure-next-auth\.session-token=([^;]+)/.exec(setCookie)[1];
  return { token };
}
