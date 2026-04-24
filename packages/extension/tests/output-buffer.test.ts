import { describe, it, expect } from "vitest";
import { OutputRingBuffer } from "../src/diagnostics/output-buffer.js";

describe("OutputRingBuffer", () => {
  it("appends under the cap and reports size", () => {
    const buf = new OutputRingBuffer(3);
    buf.append("a");
    buf.append("b");
    expect(buf.size).toBe(2);
    expect(buf.snapshot()).toBe("a\nb");
  });

  it("evicts the oldest line when appending past the cap", () => {
    const buf = new OutputRingBuffer(3);
    buf.append("a");
    buf.append("b");
    buf.append("c");
    buf.append("d");
    expect(buf.size).toBe(3);
    expect(buf.snapshot()).toBe("b\nc\nd");
  });

  it("snapshot() joins with \\n and has no trailing newline", () => {
    const buf = new OutputRingBuffer(10);
    buf.append("first");
    buf.append("second");
    const snap = buf.snapshot();
    expect(snap.endsWith("\n")).toBe(false);
    expect(snap).toBe("first\nsecond");
  });

  it("snapshot() on an empty buffer is the empty string", () => {
    const buf = new OutputRingBuffer(5);
    expect(buf.size).toBe(0);
    expect(buf.snapshot()).toBe("");
  });

  it("clear() resets size and snapshot", () => {
    const buf = new OutputRingBuffer(5);
    buf.append("a");
    buf.append("b");
    buf.clear();
    expect(buf.size).toBe(0);
    expect(buf.snapshot()).toBe("");
    // Post-clear writes still respect the cap
    buf.append("c");
    expect(buf.snapshot()).toBe("c");
  });

  it("heavy eviction: appending 10x the cap keeps only the last maxLines entries", () => {
    const buf = new OutputRingBuffer(3);
    for (let i = 0; i < 30; i++) buf.append(`line-${i}`);
    expect(buf.size).toBe(3);
    expect(buf.snapshot()).toBe("line-27\nline-28\nline-29");
  });
});
