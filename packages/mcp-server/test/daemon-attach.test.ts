import { describe, it, expect, vi } from "vitest";
import { attachToDaemon, DaemonAttachError } from "../src/daemon/attach.js";

describe("attachToDaemon throws DaemonAttachError when fallbackStdio=false", () => {
  it("wraps ensureDaemon failure into DaemonAttachError", async () => {
    const ensureDaemon = vi.fn(async () => {
      throw new Error("ECONNREFUSED 127.0.0.1:9001");
    });
    await expect(
      attachToDaemon({
        fallbackStdio: false,
        dependencies: { ensureDaemon },
      }),
    ).rejects.toMatchObject({
      name: "DaemonAttachError",
      code: "DAEMON_UNREACHABLE",
    });
  });

  it("includes 3 remediation strings", async () => {
    const ensureDaemon = vi.fn(async () => { throw new Error("nope"); });
    try {
      await attachToDaemon({ fallbackStdio: false, dependencies: { ensureDaemon } });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(DaemonAttachError);
      expect((err as DaemonAttachError).remediation).toHaveLength(3);
      expect((err as DaemonAttachError).remediation[0]).toMatch(/Reload the VS Code window/);
      expect((err as DaemonAttachError).remediation[1]).toMatch(/http-loopback/);
      expect((err as DaemonAttachError).remediation[2]).toMatch(/PERPLEXITY_NO_DAEMON/);
    }
  });

  it("preserves the underlying error as cause", async () => {
    const original = new Error("ECONNREFUSED");
    const ensureDaemon = vi.fn(async () => { throw original; });
    try {
      await attachToDaemon({ fallbackStdio: false, dependencies: { ensureDaemon } });
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as DaemonAttachError).cause).toBe(original);
    }
  });

  it("does not call process.exit", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code}) was called — forbidden in attach.ts`);
    }) as never);
    const ensureDaemon = vi.fn(async () => { throw new Error("nope"); });
    try {
      await attachToDaemon({ fallbackStdio: false, dependencies: { ensureDaemon } });
    } catch (err) {
      expect(err).toBeInstanceOf(DaemonAttachError);
    }
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it("with fallbackStdio: true, runs the legacy fallback (no DaemonAttachError thrown)", async () => {
    const ensureDaemon = vi.fn(async () => { throw new Error("nope"); });
    const runStdioMain = vi.fn(async () => undefined);
    await attachToDaemon({
      fallbackStdio: true,
      dependencies: { ensureDaemon, runStdioMain },
    });
    expect(runStdioMain).toHaveBeenCalledOnce();
  });
});
