import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as childProcess from "node:child_process";

vi.mock("vscode", () => ({
  window: { showInputBox: async () => undefined },
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn() };
});

vi.mock("node:fs", async (orig) => {
  const actual = await orig<typeof import("node:fs")>();
  return {
    ...actual,
    openSync: vi.fn(() => 99),
    closeSync: vi.fn(),
    mkdirSync: vi.fn(),
    statSync: vi.fn(() => ({ size: 0 })),
    renameSync: vi.fn(),
    writeSync: vi.fn(),
  };
});

// resolveNodePath() probes disk; force its bare-"node" last resort by making
// every candidate miss and clearing the override.
vi.mock("../src/auto-config/index", async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return { ...actual, resolveNodePath: vi.fn(() => "node") };
});

import { configureDaemonRuntime, ensureBundledDaemon, type DaemonSpawnProblem } from "../src/daemon/runtime";

const spawnMock = childProcess.spawn as unknown as ReturnType<typeof vi.fn>;
const FAST_DEADLINE_MS = 200;

/**
 * A child whose "error" listener we can fire on demand — spawn() reports
 * ENOENT asynchronously on the child, it does not throw.
 */
function fakeChild() {
  const handlers: Record<string, (arg: unknown) => void> = {};
  return {
    on: vi.fn((event: string, cb: (arg: unknown) => void) => {
      handlers[event] = cb;
    }),
    unref: vi.fn(),
    emit: (event: string, arg: unknown) => handlers[event]?.(arg),
  } as unknown as ReturnType<typeof childProcess.spawn> & {
    emit: (e: string, a: unknown) => void;
  };
}

function enoent(): NodeJS.ErrnoException {
  const err = new Error("spawn node ENOENT") as NodeJS.ErrnoException;
  err.code = "ENOENT";
  return err;
}

// When resolveNodePath() finds nothing on disk it returns the literal string
// "node" and bets on PATH. If that bet loses, the ONLY symptom used to be
// ensureDaemon timing out after 15s plus a line buried in daemon.log — the
// user had no way to know Node was simply missing.
describe("spawnBundledDaemon — Node.js not found on PATH", () => {
  let problems: DaemonSpawnProblem[];

  beforeEach(() => {
    spawnMock.mockReset();
    problems = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function configure() {
    configureDaemonRuntime({
      configDir: "/tmp/perp-node-missing",
      serverPath: "/tmp/perp-node-missing/server.mjs",
      bundledVersion: "0.8.55",
      notifyDaemonProblem: (p) => problems.push(p),
    });
  }

  it("reports node-missing and falls back ONCE to the editor runtime", async () => {
    const first = fakeChild();
    const fallback = fakeChild();
    spawnMock.mockImplementationOnce(() => first).mockImplementationOnce(() => fallback);

    configure();
    const ensure = ensureBundledDaemon({ startTimeoutMs: FAST_DEADLINE_MS }).catch(() => undefined);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());

    // First attempt used the unresolved bare "node" guess.
    expect(spawnMock.mock.calls[0][0]).toBe("node");
    // Real-node path must NOT set ELECTRON_RUN_AS_NODE.
    expect(spawnMock.mock.calls[0][2].env.ELECTRON_RUN_AS_NODE).toBeUndefined();

    first.emit("error", enoent());

    expect(problems).toHaveLength(1);
    expect(problems[0].kind).toBe("node-missing");
    expect(problems[0].message).toContain("Node.js not found");
    expect(problems[0].message).toContain("PERPLEXITY_NODE_PATH");
    expect(problems[0].degradedFallbackStarted).toBe(true);

    // Fallback re-spawned on the editor's own binary in Node mode.
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock.mock.calls[1][0]).toBe(process.execPath);
    expect(spawnMock.mock.calls[1][2].env.ELECTRON_RUN_AS_NODE).toBe("1");
    // The fallback must still be a real daemon spawn, not a stub.
    expect(spawnMock.mock.calls[1][1]).toEqual(spawnMock.mock.calls[0][1]);
    expect(spawnMock.mock.calls[1][2].env.PERPLEXITY_CONFIG_DIR).toBe("/tmp/perp-node-missing");
    expect(spawnMock.mock.calls[1][2].detached).toBe(true);

    // ONCE: a failing fallback must not recurse into another fallback.
    fallback.emit("error", enoent());
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(problems).toHaveLength(1);

    await ensure;
  });

  it("does not fire for a non-ENOENT spawn error", async () => {
    const child = fakeChild();
    spawnMock.mockImplementation(() => child);
    configure();
    const ensure = ensureBundledDaemon({ startTimeoutMs: FAST_DEADLINE_MS }).catch(() => undefined);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());

    const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
    err.code = "EACCES";
    child.emit("error", err);

    // A permissions problem is not "Node is missing" — don't misdiagnose it,
    // and don't silently swap the user onto a degraded runtime for it.
    expect(problems).toEqual([]);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    await ensure;
  });

  it("a throwing notifier cannot break the spawn path", async () => {
    const first = fakeChild();
    spawnMock.mockImplementation(() => first);
    configureDaemonRuntime({
      configDir: "/tmp/perp-node-missing",
      serverPath: "/tmp/perp-node-missing/server.mjs",
      bundledVersion: "0.8.55",
      notifyDaemonProblem: () => {
        throw new Error("toast blew up");
      },
    });
    const ensure = ensureBundledDaemon({ startTimeoutMs: FAST_DEADLINE_MS }).catch(() => undefined);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());

    expect(() => first.emit("error", enoent())).not.toThrow();
    await ensure;
  });
});

describe("spawnBundledDaemon — resolved node path", () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it("an ENOENT from a RESOLVED node path is not treated as node-missing", async () => {
    // resolveNodePath() found a real binary on disk; if spawning THAT yields
    // ENOENT something else is wrong (deleted mid-flight, bad mount) and
    // "install Node" would be the wrong advice — plus the file existing means
    // PERPLEXITY_NODE_PATH is not the fix.
    const mod = await import("../src/auto-config/index.js");
    vi.mocked(mod.resolveNodePath).mockReturnValueOnce("C:/Program Files/nodejs/node.exe");

    const child = fakeChild();
    spawnMock.mockImplementation(() => child);
    const problems: DaemonSpawnProblem[] = [];
    configureDaemonRuntime({
      configDir: "/tmp/perp-resolved",
      serverPath: "/tmp/perp-resolved/server.mjs",
      bundledVersion: "0.8.55",
      notifyDaemonProblem: (p) => problems.push(p),
    });

    const ensure = ensureBundledDaemon({ startTimeoutMs: FAST_DEADLINE_MS }).catch(() => undefined);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    expect(spawnMock.mock.calls[0][0]).toBe("C:/Program Files/nodejs/node.exe");

    child.emit("error", enoent());
    expect(problems).toEqual([]);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    await ensure;
  });
});
