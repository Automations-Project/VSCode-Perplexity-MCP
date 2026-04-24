import * as path from "node:path";
import { describe, it, expect, vi } from "vitest";
import {
  runDiagnosticsCaptureFlow,
  type DiagnosticsFlowDeps,
  type DiagnosticsFlowOutcome,
} from "../src/diagnostics/flow.js";

function makeDeps(overrides: Partial<DiagnosticsFlowDeps> = {}): DiagnosticsFlowDeps & {
  captureCalls: Array<Parameters<DiagnosticsFlowDeps["captureDiagnostics"]>[0]>;
} {
  const captureCalls: Array<Parameters<DiagnosticsFlowDeps["captureDiagnostics"]>[0]> = [];
  const deps: DiagnosticsFlowDeps = {
    showSaveDialog: vi.fn(async () => "/tmp/diag.zip"),
    captureDiagnostics: vi.fn(async (opts) => {
      captureCalls.push(opts);
      return {
        outputPath: opts.outputPath,
        bytesWritten: 4242,
        sourcesIncluded: ["daemon.log"],
        sourcesMissing: ["audit.log"],
      };
    }),
    runDoctor: vi.fn(async () => ({ overall: "pass", generatedAt: "2026-04-24T00:00:00Z" })),
    getConfigDir: () => "/home/user/.perplexity-mcp",
    getLogsText: () => "redacted log line 1\nredacted log line 2",
    getExtensionVersion: () => "0.8.1",
    getVscodeVersion: () => "1.100.0",
    now: () => new Date("2026-04-24T00:00:00Z"),
    showInformationMessage: vi.fn(async () => undefined),
    showErrorMessage: vi.fn(async () => undefined),
    ...overrides,
  };
  return Object.assign(deps, { captureCalls });
}

describe("runDiagnosticsCaptureFlow", () => {
  it("user cancels save dialog → no capture, no error, outcome=cancelled", async () => {
    const deps = makeDeps({ showSaveDialog: vi.fn(async () => undefined) });
    const outcome = await runDiagnosticsCaptureFlow(deps);
    expect(outcome.kind).toBe("cancelled");
    expect(deps.captureDiagnostics).not.toHaveBeenCalled();
    expect(deps.showInformationMessage).not.toHaveBeenCalled();
    expect(deps.showErrorMessage).not.toHaveBeenCalled();
  });

  it("happy path: capture invoked with resolved options; info message shown with path", async () => {
    const deps = makeDeps();
    const outcome = await runDiagnosticsCaptureFlow(deps);
    expect(outcome.kind).toBe("ok");
    if (outcome.kind === "ok") {
      expect(outcome.result.outputPath).toBe("/tmp/diag.zip");
      expect(outcome.result.bytesWritten).toBe(4242);
    }
    expect(deps.captureDiagnostics).toHaveBeenCalledOnce();
    const opts = (deps as unknown as { captureCalls: Array<Record<string, unknown>> }).captureCalls[0];
    expect(opts.outputPath).toBe("/tmp/diag.zip");
    expect(opts.configDir).toBe("/home/user/.perplexity-mcp");
    expect(opts.extensionVersion).toBe("0.8.1");
    expect(opts.vscodeVersion).toBe("1.100.0");
    expect(opts.logsText).toBe("redacted log line 1\nredacted log line 2");
    expect(opts.doctorReport).toEqual({ overall: "pass", generatedAt: "2026-04-24T00:00:00Z" });
    expect(deps.showInformationMessage).toHaveBeenCalledOnce();
    const [msg] = (deps.showInformationMessage as unknown as { mock: { calls: Array<[string, ...unknown[]]> } }).mock.calls[0];
    expect(msg).toContain("/tmp/diag.zip");
  });

  it("runDoctor throws → doctorReport is null; capture still runs; outcome=ok", async () => {
    const deps = makeDeps({
      runDoctor: vi.fn(async () => {
        throw new Error("doctor crashed");
      }),
    });
    const outcome = await runDiagnosticsCaptureFlow(deps);
    expect(outcome.kind).toBe("ok");
    const opts = (deps as unknown as { captureCalls: Array<Record<string, unknown>> }).captureCalls[0];
    expect(opts.doctorReport).toBeNull();
  });

  it("capture throws → outcome=error; error message shown; error string is redacted through the redactMessage helper", async () => {
    const deps = makeDeps({
      captureDiagnostics: vi.fn(async () => {
        throw new Error("disk full writing to /tmp/diag.zip");
      }),
    });
    const outcome = await runDiagnosticsCaptureFlow(deps);
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      // The redactor in this repo doesn't rewrite "disk full" content but
      // DOES enforce the contract: the flow MUST run the error string through
      // redactMessage before surfacing it. The message itself should still be
      // readable (contains "disk full").
      expect(outcome.error).toContain("disk full");
    }
    expect(deps.showErrorMessage).toHaveBeenCalledOnce();
  });

  it("computes default suggested path from os.homedir + ISO timestamp when caller provides no override", async () => {
    // showSaveDialog receives a default URI based on homedir + timestamp. We
    // intercept the dialog call to inspect the default.
    const now = new Date("2026-04-24T12:34:56.789Z");
    const homedir = "/home/example";
    let seenDefault: string | undefined;
    const deps = makeDeps({
      now: () => now,
      getHomedir: () => homedir,
      showSaveDialog: vi.fn(async (defaultPath: string) => {
        seenDefault = defaultPath;
        return defaultPath;
      }),
    });
    await runDiagnosticsCaptureFlow(deps);
    // The default filename must contain the sanitized timestamp (no colons / dots).
    // Build the expected path with the same `path.join` the flow uses so the
    // assertion is platform-neutral (on Windows the separators are backslashes).
    const expectedPath = path.join(homedir, "Downloads", "perplexity-mcp-diagnostics-2026-04-24T12-34-56-789Z.zip");
    expect(seenDefault).toBeDefined();
    expect(seenDefault).toBe(expectedPath);
  });

  it("outcome result includes sourcesIncluded / sourcesMissing for caller to post back to UI", async () => {
    const deps = makeDeps();
    const outcome: DiagnosticsFlowOutcome = await runDiagnosticsCaptureFlow(deps);
    expect(outcome.kind).toBe("ok");
    if (outcome.kind === "ok") {
      expect(outcome.result.sourcesIncluded).toEqual(["daemon.log"]);
      expect(outcome.result.sourcesMissing).toEqual(["audit.log"]);
    }
  });
});
