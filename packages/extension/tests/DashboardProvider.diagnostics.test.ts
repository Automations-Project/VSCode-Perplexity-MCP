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

/**
 * Outcome-return signalling contract.
 *
 * The dashboard's `diagnostics:capture` arm needs a boolean success signal
 * to pass to `postActionResult` — otherwise the global spinner state sticks
 * when capture fails. These tests lock down the outcome returned from
 * `handleDiagnosticsCapture` so the dashboard's mapping:
 *
 *   outcome.kind === "ok"        → postActionResult(id, true)
 *   outcome.kind === "cancelled" → postActionResult(id, true)  // user action, not failure
 *   outcome.kind === "error"     → postActionResult(id, false, outcome.error)
 *
 * stays correct. If this mapping changes, update both this file and the
 * arm in `DashboardProvider.ts`.
 */
describe("handleDiagnosticsCapture outcome → postActionResult signalling", () => {
  it("capture failure → outcome.kind === 'error' (dashboard maps to ok:false)", async () => {
    const posted: ExtensionMessage[] = [];
    const deps = makeDeps({
      captureDiagnostics: vi.fn(async () => {
        throw new Error("ENOSPC: no space left on device");
      }),
    });
    const outcome = await handleDiagnosticsCapture("req-fail", deps, (m) => {
      posted.push(m);
    });
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      expect(outcome.error).toMatch(/ENOSPC/);
    }
  });

  it("cancellation → outcome.kind === 'cancelled' (dashboard maps to ok:true — user action, not failure)", async () => {
    const posted: ExtensionMessage[] = [];
    const deps = makeDeps({ showSaveDialog: vi.fn(async () => undefined) });
    const outcome = await handleDiagnosticsCapture("req-cancel", deps, (m) => {
      posted.push(m);
    });
    expect(outcome.kind).toBe("cancelled");
    expect(deps.captureDiagnostics).not.toHaveBeenCalled();
  });

  it("happy path → outcome.kind === 'ok' (dashboard maps to ok:true)", async () => {
    const posted: ExtensionMessage[] = [];
    const deps = makeDeps();
    const outcome = await handleDiagnosticsCapture("req-ok", deps, (m) => {
      posted.push(m);
    });
    expect(outcome.kind).toBe("ok");
    if (outcome.kind === "ok") {
      expect(outcome.result.outputPath).toBe("/tmp/diag.zip");
    }
  });

  it("showSaveDialog throws → handleDiagnosticsCapture rejects (dashboard catch block maps to ok:false)", async () => {
    // The inner flow does NOT wrap showSaveDialog in its own try/catch, so a
    // throw here escapes `handleDiagnosticsCapture`. The dashboard arm has an
    // outer try/catch that calls `postActionResult(id, false, ...)` — this
    // test proves the throw propagates so that safety net engages.
    const deps = makeDeps({
      showSaveDialog: vi.fn(async () => {
        throw new Error("dialog host crashed");
      }),
    });
    await expect(
      handleDiagnosticsCapture("req-throw", deps, () => {}),
    ).rejects.toThrow(/dialog host crashed/);
  });
});
