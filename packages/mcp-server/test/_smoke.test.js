import { describe, it, expect } from "vitest";

describe("workspace wiring smoke test", () => {
  it("mcp-server test harness runs via root vitest config", () => {
    expect(1 + 1).toBe(2);
  });
});
