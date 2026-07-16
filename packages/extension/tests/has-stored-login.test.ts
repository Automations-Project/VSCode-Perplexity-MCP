import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProfile, recordLoginSuccess, setActive } from "perplexity-user-mcp/profiles";
import { softLogout } from "perplexity-user-mcp/logout";
// No public /vault subpath — reach into the workspace source (tests only).
import { Vault } from "../../mcp-server/src/vault.js";
import { hasStoredLogin } from "../src/auth/session.js";

// hasStoredLogin used to be `existsSync(vault.enc)`. Soft logout deletes only
// the vault's `cookies` key (email survives by design), so the FILE outlives
// every logout and the extension reported "logged in" forever — including
// resolveMcpServerDefinition happily starting the MCP server for a logged-out
// profile. The honest signal is meta.lastLogin: every login runner records it,
// softLogout deletes it.
describe("hasStoredLogin (session truth)", () => {
  let configDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "px-session-"));
    process.env.PERPLEXITY_CONFIG_DIR = configDir;
    process.env.PERPLEXITY_VAULT_PASSPHRASE = "t-pass";
    createProfile("default");
    setActive("default");
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  it("is false for a fresh profile", () => {
    expect(hasStoredLogin()).toBe(false);
  });

  it("is true after a recorded login", () => {
    recordLoginSuccess("default", {
      tier: "Pro",
      loginMode: "manual",
      lastLogin: new Date(0).toISOString(),
    });
    expect(hasStoredLogin()).toBe(true);
  });

  it("is false again after soft logout, even though vault.enc still exists", async () => {
    const vault = new Vault();
    await vault.set("default", "cookies", JSON.stringify([{ name: "x", value: "y" }]));
    await vault.set("default", "email", "a@b.co"); // guarantees vault.enc survives the logout
    recordLoginSuccess("default", {
      tier: "Pro",
      loginMode: "manual",
      lastLogin: new Date(0).toISOString(),
    });
    expect(hasStoredLogin()).toBe(true);

    await softLogout("default");

    expect(hasStoredLogin()).toBe(false);
  });
});
