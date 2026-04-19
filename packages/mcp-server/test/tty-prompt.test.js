import { describe, it, expect } from "vitest";
import { promptSecret } from "../src/tty-prompt.js";

describe("promptSecret", () => {
  it("reads one line from stdin, trims, echoes prompt to stderr", async () => {
    const stdin = new (await import("node:stream")).Readable({ read() {} });
    const stderr = { writes: [], write(x) { this.writes.push(x); } };
    const p = promptSecret({ stdin, stderr, prompt: "Passphrase: " });
    setImmediate(() => stdin.push("hunter2\n"));
    setImmediate(() => stdin.push(null));
    const res = await p;
    expect(res).toBe("hunter2");
    expect(stderr.writes.some((s) => s.includes("Passphrase:"))).toBe(true);
  });
});
