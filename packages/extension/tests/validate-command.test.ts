import { describe, expect, it } from "vitest";
import {
  validateCommand,
  type CommandHealth,
  type ValidateCommandDeps,
} from "../src/launcher/validate-command.js";

// Build a deps object that does no real disk I/O. The `existsSync` predicate
// is driven from a Set of "files that exist on this synthetic filesystem".
function makeDeps(opts: {
  platform: NodeJS.Platform;
  envPath?: string;
  envPathExt?: string;
  existing?: string[];
}): ValidateCommandDeps {
  // Windows file system is case-insensitive in practice — mirror that here so
  // tests can list `node.exe` and the validator can probe `node.EXE` (the
  // case it derives from PATHEXT) without the lookup spuriously failing.
  const norm = (p: string) =>
    opts.platform === "win32" ? p.toLowerCase() : p;
  const existing = new Set((opts.existing ?? []).map(norm));
  return {
    platform: opts.platform,
    envPath: opts.envPath ?? "",
    envPathExt: opts.envPathExt,
    existsSync: (p: string) => existing.has(norm(p)),
  };
}

describe("validateCommand", () => {
  describe("blank/missing input", () => {
    it.each([
      ["", "missing"],
      ["   ", "missing"],
      [undefined, "missing"],
      [null, "missing"],
    ] as const)("returns 'missing' for %p", (input, expected) => {
      expect(
        validateCommand(input as string | undefined | null, makeDeps({ platform: "linux" })),
      ).toBe(expected as CommandHealth);
    });
  });

  describe("bare 'node' on POSIX", () => {
    it("resolves to ok when PATH contains a node binary", () => {
      const deps = makeDeps({
        platform: "linux",
        envPath: "/usr/local/bin:/usr/bin",
        existing: ["/usr/local/bin/node"],
      });
      expect(validateCommand("node", deps)).toBe("ok");
    });

    it("returns unresolved when PATH has no node", () => {
      const deps = makeDeps({
        platform: "linux",
        envPath: "/usr/local/bin:/usr/bin",
        existing: [],
      });
      expect(validateCommand("node", deps)).toBe("unresolved");
    });

    it("returns unresolved with empty PATH", () => {
      const deps = makeDeps({ platform: "linux", envPath: "" });
      expect(validateCommand("node", deps)).toBe("unresolved");
    });
  });

  describe("bare 'node' on Windows", () => {
    it("resolves to ok via PATHEXT when only node.exe exists", () => {
      const deps = makeDeps({
        platform: "win32",
        envPath: "C:\\Program Files\\nodejs",
        envPathExt: ".COM;.EXE;.BAT;.CMD",
        existing: ["C:\\Program Files\\nodejs\\node.exe"],
      });
      expect(validateCommand("node", deps)).toBe("ok");
    });

    it("resolves bare 'node.exe' (with extension) the same as 'node'", () => {
      const deps = makeDeps({
        platform: "win32",
        envPath: "C:\\nodejs",
        envPathExt: ".EXE",
        existing: ["C:\\nodejs\\node.exe"],
      });
      expect(validateCommand("node.exe", deps)).toBe("ok");
    });

    it("returns unresolved when no PATH dir contains a node binary", () => {
      const deps = makeDeps({
        platform: "win32",
        envPath: "C:\\Windows;C:\\Windows\\System32",
        envPathExt: ".EXE",
        existing: ["C:\\Windows\\notepad.exe"],
      });
      expect(validateCommand("node", deps)).toBe("unresolved");
    });
  });

  describe("absolute path: node-shaped + exists", () => {
    it("returns ok for /usr/local/bin/node that exists", () => {
      const deps = makeDeps({
        platform: "linux",
        existing: ["/usr/local/bin/node"],
      });
      expect(validateCommand("/usr/local/bin/node", deps)).toBe("ok");
    });

    it("returns ok for nvm-style versioned node binary", () => {
      const deps = makeDeps({
        platform: "linux",
        existing: ["/home/me/.nvm/versions/node/v20.10.0/bin/node"],
      });
      expect(
        validateCommand("/home/me/.nvm/versions/node/v20.10.0/bin/node", deps),
      ).toBe("ok");
    });

    it("returns ok for Windows node.exe path that exists", () => {
      const deps = makeDeps({
        platform: "win32",
        existing: ["C:\\Program Files\\nodejs\\node.exe"],
      });
      expect(
        validateCommand("C:\\Program Files\\nodejs\\node.exe", deps),
      ).toBe("ok");
    });
  });

  describe("absolute path: missing on disk", () => {
    it("returns missing for stale /opt/node path", () => {
      const deps = makeDeps({ platform: "linux", existing: [] });
      expect(validateCommand("/opt/old-node/node", deps)).toBe("missing");
    });

    it("returns missing for stale Windows path", () => {
      const deps = makeDeps({ platform: "win32", existing: [] });
      expect(
        validateCommand("D:\\nvm\\v18.0.0\\node.exe", deps),
      ).toBe("missing");
    });
  });

  describe("absolute path: blacklisted runtime basename", () => {
    it.each([
      ["C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe"],
      ["C:\\Users\\me\\AppData\\Local\\Programs\\cursor\\Cursor.exe"],
      ["C:\\Users\\me\\AppData\\Local\\Programs\\Windsurf - Next\\Windsurf - Next.exe"],
      ["/usr/share/code/code"],
      ["/usr/share/code-insiders/code-insiders"],
      ["/Applications/Cursor.app/Contents/MacOS/Cursor"],
    ])("flags %s as wrong-runtime", (cmd) => {
      // Existence shouldn't matter — blacklist wins regardless.
      const deps = makeDeps({
        platform: cmd.includes("\\") ? "win32" : "linux",
        existing: [cmd],
      });
      expect(validateCommand(cmd, deps)).toBe("wrong-runtime");
    });

    it("flags Electron host binary even when it exists on disk", () => {
      const deps = makeDeps({
        platform: "linux",
        existing: ["/snap/code/current/usr/share/code/electron"],
      });
      expect(
        validateCommand("/snap/code/current/usr/share/code/electron", deps),
      ).toBe("wrong-runtime");
    });
  });

  describe("absolute path: macOS .app bundle pattern", () => {
    it("flags non-node binary inside *.app/Contents/MacOS/ as wrong-runtime", () => {
      const deps = makeDeps({
        platform: "darwin",
        existing: ["/Applications/Visual Studio Code.app/Contents/MacOS/Electron"],
      });
      expect(
        validateCommand(
          "/Applications/Visual Studio Code.app/Contents/MacOS/Electron",
          deps,
        ),
      ).toBe("wrong-runtime");
    });

    it("does NOT flag node binary inside a .app bundle (basename is node)", () => {
      const deps = makeDeps({
        platform: "darwin",
        existing: ["/Applications/Foo.app/Contents/MacOS/node"],
      });
      expect(
        validateCommand("/Applications/Foo.app/Contents/MacOS/node", deps),
      ).toBe("ok");
    });
  });

  describe("absolute path: unknown runtime (exists, non-blacklisted, non-node)", () => {
    it("returns unknown for a custom shell wrapper that exists", () => {
      const deps = makeDeps({
        platform: "linux",
        existing: ["/opt/wrappers/run-mcp.sh"],
      });
      expect(validateCommand("/opt/wrappers/run-mcp.sh", deps)).toBe("unknown");
    });

    it("returns unknown for an existing Windows wrapper .cmd", () => {
      const deps = makeDeps({
        platform: "win32",
        existing: ["C:\\tools\\run-perplexity.cmd"],
      });
      expect(
        validateCommand("C:\\tools\\run-perplexity.cmd", deps),
      ).toBe("unknown");
    });
  });

  describe("relative non-bare paths", () => {
    it("returns unknown for ./node (we don't know the IDE's cwd)", () => {
      const deps = makeDeps({ platform: "linux" });
      expect(validateCommand("./node", deps)).toBe("unknown");
    });

    it("returns unknown for a relative wrapper script", () => {
      const deps = makeDeps({ platform: "linux" });
      expect(validateCommand("scripts/start.sh", deps)).toBe("unknown");
    });
  });

  describe("case-insensitive blacklist matching", () => {
    it("matches CODE.EXE the same as code.exe on Windows", () => {
      const deps = makeDeps({
        platform: "win32",
        existing: ["C:\\Program Files\\Microsoft VS Code\\CODE.EXE"],
      });
      expect(
        validateCommand(
          "C:\\Program Files\\Microsoft VS Code\\CODE.EXE",
          deps,
        ),
      ).toBe("wrong-runtime");
    });
  });
});
