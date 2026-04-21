import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTunnel } from "../../src/daemon/tunnel.ts";

describe("daemon tunnel", () => {
  let tempDir;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "pplx-daemon-tunnel-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("parses the trycloudflare URL and cleans up the child process", async () => {
    const fakeBinary = join(tempDir, "fake-cloudflared.js");
    writeFileSync(
      fakeBinary,
      [
        "setTimeout(() => {",
        "  process.stderr.write('INF Visit https://unit-test.trycloudflare.com to preview your tunnel\\n');",
        "}, 200);",
        "const shutdown = () => process.exit(0);",
        "process.on('SIGTERM', shutdown);",
        "process.on('SIGINT', shutdown);",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
      "utf8",
    );

    const transitions = [];
    const tunnel = startTunnel({
      command: process.execPath,
      args: [fakeBinary],
      port: 43123,
      onStateChange: (state) => transitions.push({ ...state }),
    });

    const url = await tunnel.waitUntilReady;
    expect(url).toBe("https://unit-test.trycloudflare.com");
    expect(tunnel.getState()).toMatchObject({
      status: "enabled",
      url: "https://unit-test.trycloudflare.com",
    });

    await tunnel.stop();
    expect(tunnel.getState()).toMatchObject({
      status: "disabled",
      url: null,
      pid: null,
    });
    expect(transitions.some((state) => state.status === "enabled")).toBe(true);
  });
});
