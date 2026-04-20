import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start as startMock } from "./mock-server.js";
import { Vault } from "../../src/vault.js";
import { createProfile, setActive } from "../../src/profiles.js";

const RUNNER = fileURLToPath(new URL("../../dist/login-runner.mjs", import.meta.url));

function runWithOtp(env, otpReplies = []) {
  return new Promise((resolve) => {
    const child = fork(RUNNER, [], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe", "ipc"] });
    const msgs = [];
    let out = "";
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.on("message", (m) => {
      msgs.push(m);
      if (m?.phase === "awaiting_otp" && otpReplies.length) {
        child.send({ otp: otpReplies.shift() });
      }
    });
    child.on("close", (code) => {
      const lines = out.trim().split("\n").filter(Boolean);
      resolve({ code, result: lines[lines.length - 1] ? JSON.parse(lines[lines.length - 1]) : null, msgs });
    });
  });
}

describe("login-runner (integration)", () => {
  let mock, configDir;
  beforeAll(async () => { mock = await startMock({ port: 0 }); });
  afterAll(async () => { await mock.close(); });

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "px-auto-"));
    process.env.PERPLEXITY_CONFIG_DIR = configDir;
    process.env.PERPLEXITY_VAULT_PASSPHRASE = "test-pass-3";
    createProfile("default");
    setActive("default");
  });

  it("happy path: correct OTP on first try -> vault written, exit 0", async () => {
    const { code, result, msgs } = await runWithOtp({
      PERPLEXITY_CONFIG_DIR: configDir,
      PERPLEXITY_VAULT_PASSPHRASE: "test-pass-3",
      PERPLEXITY_PROFILE: "default",
      PERPLEXITY_EMAIL: "auto@mock.test",
      PERPLEXITY_ORIGIN: mock.url,
      PERPLEXITY_LOGIN_PATH: "/login",
    }, ["123456"]);
    expect(msgs.some((m) => m?.phase === "awaiting_otp")).toBe(true);
    expect(code).toBe(0);
    expect(result.ok).toBe(true);
    const vault = new Vault();
    expect(await vault.get("default", "email")).toBe("auto@mock.test");
  }, 30_000);

  it("retries up to 2x on wrong OTP, then exits 2 {reason:'otp_rejected'}", async () => {
    const { code, result, msgs } = await runWithOtp({
      PERPLEXITY_CONFIG_DIR: configDir,
      PERPLEXITY_VAULT_PASSPHRASE: "test-pass-3",
      PERPLEXITY_PROFILE: "default",
      PERPLEXITY_EMAIL: "auto@mock.test",
      PERPLEXITY_ORIGIN: mock.url,
      PERPLEXITY_LOGIN_PATH: "/login",
    }, ["000000", "000000", "000000"]);
    const otpPrompts = msgs.filter((m) => m?.phase === "awaiting_otp").length;
    expect(otpPrompts).toBeGreaterThanOrEqual(2);
    expect(code).toBe(2);
    expect(result.reason).toBe("otp_rejected");
  }, 30_000);

  it("exits 2 {reason:'sso_required'} when the email triggers SSO", async () => {
    const { code, result } = await runWithOtp({
      PERPLEXITY_CONFIG_DIR: configDir,
      PERPLEXITY_VAULT_PASSPHRASE: "test-pass-3",
      PERPLEXITY_PROFILE: "default",
      PERPLEXITY_EMAIL: "someone@sso.test",
      PERPLEXITY_ORIGIN: mock.url,
      PERPLEXITY_LOGIN_PATH: "/login",
    });
    expect(code).toBe(2);
    expect(result.reason).toBe("sso_required");
  }, 30_000);

  it("exits 2 {reason:'otp_timeout'} when parent never sends OTP", async () => {
    const { code, result } = await runWithOtp({
      PERPLEXITY_CONFIG_DIR: configDir,
      PERPLEXITY_VAULT_PASSPHRASE: "test-pass-3",
      PERPLEXITY_PROFILE: "default",
      PERPLEXITY_EMAIL: "auto@mock.test",
      PERPLEXITY_ORIGIN: mock.url,
      PERPLEXITY_LOGIN_PATH: "/login",
      PERPLEXITY_OTP_TIMEOUT_MS: "500",
    });
    expect(code).toBe(2);
    expect(result.reason).toBe("otp_timeout");
  }, 30_000);

  it("exits 2 {reason:'auto_unsupported'} when /login/email returns 404 HTML (real-site shape)", async () => {
    const unsupportedMock = await startMock({ port: 0, forceUnsupported: true });
    try {
      const { code, result } = await runWithOtp({
        PERPLEXITY_CONFIG_DIR: configDir,
        PERPLEXITY_VAULT_PASSPHRASE: "test-pass-3",
        PERPLEXITY_PROFILE: "default",
        PERPLEXITY_EMAIL: "auto@mock.test",
        PERPLEXITY_ORIGIN: unsupportedMock.url,
        PERPLEXITY_LOGIN_PATH: "/login",
      });
      expect(code).toBe(2);
      expect(result.reason).toBe("auto_unsupported");
      expect(result.detail).toBeDefined();
      expect(result.detail.status).toBe(404);
    } finally {
      await unsupportedMock.close();
    }
  }, 30_000);
});
