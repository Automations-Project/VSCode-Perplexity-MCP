import { describe, it, expect, vi } from "vitest";
import { join } from "node:path";

vi.mock("vscode", () => {
  class EventEmitter<T> {
    private listeners: ((value: T) => void)[] = [];
    event = (listener: (value: T) => void) => {
      this.listeners.push(listener);
      return { dispose: () => {} };
    };
    fire(value: T): void {
      for (const listener of this.listeners) listener(value);
    }
    dispose(): void {
      this.listeners = [];
    }
  }
  return { EventEmitter };
});

import { spawnRunner } from "../src/mcp/auth-manager";

const FAKE = join(__dirname, "fixtures", "fake-runner.mjs");

describe("spawnRunner", () => {
  it("parses last JSON line on success", async () => {
    const res = await spawnRunner(FAKE, { FAKE_ROLE: "ok" });
    expect(res.ok).toBe(true);
    expect((res as { userId: string }).userId).toBe("test");
  });

  it("parses last JSON line on non-zero exit", async () => {
    const res = await spawnRunner(FAKE, { FAKE_ROLE: "fail" });
    expect(res.ok).toBe(false);
    expect((res as { reason: string }).reason).toBe("simulated");
  });

  it("kills the child on timeout and rejects", async () => {
    await expect(
      spawnRunner(FAKE, { FAKE_ROLE: "hang" }, { timeoutMs: 500 })
    ).rejects.toThrow(/timed out/i);
  });
});
