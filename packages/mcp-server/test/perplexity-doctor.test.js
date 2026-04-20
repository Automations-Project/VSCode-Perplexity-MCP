import { describe, it, expect } from "vitest";
import { registerTools } from "../src/tools.js";

describe("perplexity_doctor tool", () => {
  it("registers when enabledTools includes it", () => {
    const registered = [];
    const fakeServer = {
      registerTool: (name) => { registered.push(name); },
    };
    registerTools(
      fakeServer,
      async () => ({ authenticated: false, accountInfo: {} }),
      new Set(["perplexity_doctor"]),
    );
    expect(registered).toContain("perplexity_doctor");
  });
});
