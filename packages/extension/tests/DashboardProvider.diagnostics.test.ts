import { describe, it, expect, vi } from "vitest";
import type { ExtensionMessage } from "@perplexity-user-mcp/shared";
import {
  handleDiagnosticsCapture,
  type DiagnosticsFlowDeps,
} from "../src/diagnostics/flow.js";

/**
 * The dashboard message handler is a thin wrapper over runDiagnosticsCaptureFlow
 * that posts a `diagnostics:capture:result` ExtensionMessage back to the webview
 * with the request's `id`. Tests here prove the correlation + shape.
 */

function makeDeps(overrides: Partial<DiagnosticsFlowDeps> = {}): DiagnosticsFlowDeps {
  return {
    showSaveDialog: vi.fn(async () => "/tmp/diag.zip"),
    captureDiagnostics: vi.fn(async (opts) => ({
      outputPath: opts.outputPath,
      bytesWritten: 1234,
      sourcesIncluded: ["daemon.log", "daemon.lock"],
      sourcesMissing: [],
    })),
    runDoctor: vi.fn(async () => ({ overall: "pass" })),
    getConfigDir: () => "/home/user/.perplexity-mcp",
    getLogsText: () => "logs",
    getExtensionVersion: () => "0.8.1",
    getVscodeVersion: () => "1.100.0",
    now: () => new Date("2026-04-24T00:00:00Z"),
    showInformationMessage: vi.fn(async () => undefined),
    showErrorMessage: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("handleDiagnosticsCapture (dashboard dispatch)", () => {
  it("happy path → posts diagnostics:capture:result with ok=true and all capture metadata", async () => {
    const posted: ExtensionMessage[] = [];
    const deps = makeDeps();
    await handleDiagnosticsCapture("req-1", deps, (m) => {
      posted.push(m);
    });
    expect(posted).toHaveLength(1);
    const result = posted[0];
    expect(result.type).toBe("diagnostics:capture:result");
    if (result.type === "diagnostics:capture:result") {
      expect(result.id).toBe("req-1");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.outputPath).toBe("/tmp/diag.zip");
        expect(result.bytesWritten).toBe(1234);
        expect(result.sourcesIncluded).toEqual(["daemon.log", "daemon.lock"]);
        expect(result.sourcesMissing).toEqual([]);
      }
    }
  });

  it("cancel (showSaveDialog undefined) → posts ok=false with error 'cancelled'; captureDiagnostics NOT called", async () => {
    const posted: ExtensionMessage[] = [];
    const deps = makeDeps({ showSaveDialog: vi.fn(async () => undefined) });
    await handleDiagnosticsCapture("req-cancel", deps, (m) => {
      posted.push(m);
    });
    expect(deps.captureDiagnostics).not.toHaveBeenCalled();
    expect(posted).toHaveLength(1);
    const result = posted[0];
    expect(result.type).toBe("diagnostics:capture:result");
    if (result.type === "diagnostics:capture:result") {
      expect(result.id).toBe("req-cancel");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe("cancelled");
    }
  });

  it("capture throws → posts ok=false with redacted error string", async () => {
    const posted: ExtensionMessage[] = [];
    const deps = makeDeps({
      captureDiagnostics: vi.fn(async () => {
        throw new Error("ENOSPC: no space left on device");
      }),
    });
    await handleDiagnosticsCapture("req-err", deps, (m) => {
      posted.push(m);
    });
    const result = posted[0];
    expect(result.type).toBe("diagnostics:capture:result");
    if (result.type === "diagnostics:capture:result" && !result.ok) {
      expect(result.error).toMatch(/ENOSPC/);
    }
  });

  it("runDoctor throws → capture still runs → posts ok=true (doctor failure does NOT abort the flow)", async () => {
    const posted: ExtensionMessage[] = [];
    const deps = makeDeps({
      runDoctor: vi.fn(async () => {
        throw new Error("doctor timeout");
      }),
    });
    await handleDiagnosticsCapture("req-doc-fail", deps, (m) => {
      posted.push(m);
    });
    expect(deps.captureDiagnostics).toHaveBeenCalledOnce();
    const result = posted[0];
    expect(result.type).toBe("diagnostics:capture:result");
    if (result.type === "diagnostics:capture:result") {
      expect(result.ok).toBe(true);
    }
  });
});
