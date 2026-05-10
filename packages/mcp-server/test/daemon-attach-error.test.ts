import { describe, it, expect } from "vitest";
import { DaemonAttachError } from "../src/daemon/attach.js";

describe("DaemonAttachError", () => {
  it("has code DAEMON_UNREACHABLE", () => {
    const e = new DaemonAttachError("nope", ["a"]);
    expect(e.code).toBe("DAEMON_UNREACHABLE");
  });

  it("preserves remediation array", () => {
    const e = new DaemonAttachError("nope", ["one", "two", "three"]);
    expect(e.remediation).toEqual(["one", "two", "three"]);
  });

  it("preserves cause when supplied", () => {
    const cause = new Error("ECONNREFUSED");
    const e = new DaemonAttachError("nope", ["a"], cause);
    expect(e.cause).toBe(cause);
  });

  it("name is DaemonAttachError", () => {
    const e = new DaemonAttachError("nope", ["a"]);
    expect(e.name).toBe("DaemonAttachError");
  });

  it("instanceof Error", () => {
    const e = new DaemonAttachError("nope", ["a"]);
    expect(e).toBeInstanceOf(Error);
  });
});
