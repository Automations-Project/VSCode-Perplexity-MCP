import { describe, expect, it } from "vitest";

import { TunnelEnableRecorder } from "../src/webview/tunnel-enable-recorder.js";

describe("TunnelEnableRecorder", () => {
  it("records a single entry and returns it via snapshot", () => {
    const r = new TunnelEnableRecorder(5);
    r.record({
      provider: "cf-quick",
      startedAt: "2026-04-24T10:00:00.000Z",
      durationMs: 5500,
      ok: true,
    });
    const snap = r.snapshot();
    expect(snap.length).toBe(1);
    expect(snap[0]).toEqual({
      provider: "cf-quick",
      startedAt: "2026-04-24T10:00:00.000Z",
      durationMs: 5500,
      ok: true,
    });
  });

  it("snapshot is newest-first", () => {
    const r = new TunnelEnableRecorder(5);
    r.record({ provider: "cf-quick", startedAt: "2026-04-24T10:00:00.000Z", durationMs: 5500, ok: true });
    r.record({ provider: "ngrok", startedAt: "2026-04-24T10:01:00.000Z", durationMs: 2000, ok: true });
    r.record({ provider: "cf-named", startedAt: "2026-04-24T10:02:00.000Z", durationMs: 1500, ok: true });
    const snap = r.snapshot();
    expect(snap.map((e) => e.provider)).toEqual(["cf-named", "ngrok", "cf-quick"]);
  });

  it("evicts oldest entries when capacity is exceeded", () => {
    const r = new TunnelEnableRecorder(2);
    r.record({ provider: "cf-quick", startedAt: "2026-04-24T10:00:00.000Z", durationMs: 1, ok: true });
    r.record({ provider: "ngrok", startedAt: "2026-04-24T10:01:00.000Z", durationMs: 2, ok: true });
    r.record({ provider: "cf-named", startedAt: "2026-04-24T10:02:00.000Z", durationMs: 3, ok: true });
    const snap = r.snapshot();
    expect(snap.length).toBe(2);
    // cf-quick (oldest) has been evicted.
    expect(snap.map((e) => e.provider)).toEqual(["cf-named", "ngrok"]);
  });

  it("clear() empties the buffer", () => {
    const r = new TunnelEnableRecorder(5);
    r.record({ provider: "cf-quick", startedAt: "2026-04-24T10:00:00.000Z", durationMs: 1, ok: true });
    r.record({ provider: "ngrok", startedAt: "2026-04-24T10:01:00.000Z", durationMs: 2, ok: true });
    expect(r.snapshot().length).toBe(2);
    r.clear();
    expect(r.snapshot().length).toBe(0);
    // Still usable after clear.
    r.record({ provider: "cf-named", startedAt: "2026-04-24T10:02:00.000Z", durationMs: 3, ok: true });
    expect(r.snapshot().length).toBe(1);
  });

  it("preserves ok=false records verbatim", () => {
    const r = new TunnelEnableRecorder();
    r.record({ provider: "ngrok", startedAt: "2026-04-24T10:00:00.000Z", durationMs: 12000, ok: false });
    const snap = r.snapshot();
    expect(snap[0].ok).toBe(false);
    expect(snap[0].durationMs).toBe(12000);
  });

  it("floors negative durations to 0 (clock skew guard)", () => {
    const r = new TunnelEnableRecorder();
    r.record({ provider: "cf-quick", startedAt: "2026-04-24T10:00:00.000Z", durationMs: -50, ok: true });
    expect(r.snapshot()[0].durationMs).toBe(0);
  });

  it("capacity below 1 is coerced to 1", () => {
    const r = new TunnelEnableRecorder(0);
    r.record({ provider: "cf-quick", startedAt: "2026-04-24T10:00:00.000Z", durationMs: 1, ok: true });
    r.record({ provider: "ngrok", startedAt: "2026-04-24T10:01:00.000Z", durationMs: 2, ok: true });
    // Both records should be accepted, but only the newest retained.
    expect(r.snapshot().length).toBe(1);
    expect(r.snapshot()[0].provider).toBe("ngrok");
  });

  it("snapshot is a copy — mutating it does not affect future snapshots", () => {
    const r = new TunnelEnableRecorder(5);
    r.record({ provider: "cf-quick", startedAt: "2026-04-24T10:00:00.000Z", durationMs: 1, ok: true });
    const first = r.snapshot() as ReturnType<TunnelEnableRecorder["snapshot"]>;
    // first is readonly by type, but runtime-mutable. Verify the internal
    // buffer is not aliased to it.
    (first as unknown as { length: number }).length = 0;
    expect(r.snapshot().length).toBe(1);
  });
});
