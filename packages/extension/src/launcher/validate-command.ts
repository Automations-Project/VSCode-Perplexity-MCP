import { existsSync } from "node:fs";
import { basename, isAbsolute } from "node:path";

/**
 * Health classification for the `command` field of a stored IDE MCP config.
 *
 * The doctor uses this to demote a "configured" IDE to a `warn` when the
 * persisted command path is unlikely to actually launch a Node.js runtime.
 *
 *   - `ok`            — command resolves to a Node-shaped executable on disk
 *                       (basename starts with "node") OR a bare "node" /
 *                       "node.exe" that resolves via PATH.
 *   - `missing`       — absolute path that does not exist on disk (stale).
 *   - `wrong-runtime` — basename matches a known Electron/IDE-host blacklist
 *                       (Code, Cursor, Windsurf, Electron, Claude desktop,
 *                       etc.) OR a macOS `.app/Contents/MacOS/<bin>` path
 *                       whose basename isn't node.
 *   - `unresolved`    — bare `node` / `node.exe` with no PATH match.
 *   - `unknown`       — absolute path that exists, basename doesn't start
 *                       with `node`, and isn't on the blacklist. We don't
 *                       know if it's a Node-compatible runtime — surface a
 *                       light warning so the user can verify.
 *
 * IMPORTANT: classification is path-shape + filesystem-only. The validator
 * MUST NOT spawn the command (`spawnSync(command, ["--version"])`) because
 * config files are user-editable and doctor must never execute arbitrary
 * paths picked up from disk.
 */
export type CommandHealth =
  | "ok"
  | "missing"
  | "wrong-runtime"
  | "unresolved"
  | "unknown";

/**
 * Optional dependency injection for the validator. Tests inject a synthetic
 * platform/PATH/PATHEXT/file-existence triple to exercise cross-platform
 * behavior without touching the host filesystem.
 */
export interface ValidateCommandDeps {
  platform?: NodeJS.Platform;
  /** Raw PATH string, separator-style matching `platform`. */
  envPath?: string;
  /** Raw PATHEXT string (Windows only). */
  envPathExt?: string;
  /** Predicate replacement for fs.existsSync. */
  existsSync?: (p: string) => boolean;
}

// Known non-Node runtimes that have, in real bug reports, ended up in stored
// `command` fields after a user copy-pasted the wrong path or an extension
// host wrote `process.execPath`. Compared against `basename().toLowerCase()`,
// so entries are listed lowercase here.
const RUNTIME_BLACKLIST = new Set<string>([
  "code",
  "code.exe",
  "code - insiders",
  "code - insiders.exe",
  "code-insiders",
  "code-insiders.exe",
  "cursor",
  "cursor.exe",
  "windsurf",
  "windsurf.exe",
  "windsurf - next",
  "windsurf - next.exe",
  "electron",
  "electron.exe",
  "claude",
  "claude.exe",
  "claude desktop",
  "claude desktop.exe",
]);

/**
 * Returns `true` when `name` (a basename, not a full path) looks like a Node
 * binary. On Windows file matching is case-insensitive in practice; the
 * caller has already lowercased.
 */
function isNodeBasename(name: string): boolean {
  // Accept "node", "node.exe", "node18", "nodejs" — anything starting with
  // "node". Deliberately lenient: nvm shims and packaged distros sometimes
  // version-suffix the binary.
  return name.startsWith("node");
}

/**
 * Join a directory and a filename using the synthetic platform's separator.
 *
 * `path.join` always uses the host OS separator (so on Windows it produces
 * `\\usr\\local\\bin\\node` even for a Linux-shaped PATH). PATH-search is
 * inherently platform-specific, so we hand-roll the join to honour the
 * caller-injected `platform`. This lets the test suite exercise both Windows
 * and POSIX semantics regardless of the host OS.
 */
function joinFor(platform: NodeJS.Platform, dir: string, name: string): string {
  const sep = platform === "win32" ? "\\" : "/";
  // Strip a trailing separator on `dir` so we don't emit a doubled separator.
  const trimmed = dir.replace(/[\\/]+$/, "");
  return `${trimmed}${sep}${name}`;
}

/**
 * Walk `PATH` looking for `node` (and on Windows, every `PATHEXT` variant).
 * Returns the first existing absolute candidate, or null.
 */
function resolveBareNode(deps: ValidateCommandDeps): string | null {
  const platform = deps.platform ?? process.platform;
  const envPath = deps.envPath ?? process.env.PATH ?? "";
  const exists = deps.existsSync ?? existsSync;
  const sep = platform === "win32" ? ";" : ":";
  const dirs = envPath.split(sep).filter((d) => d.length > 0);

  if (platform === "win32") {
    // PATHEXT is case-insensitive on Windows. Default mirrors a vanilla
    // install in case the env var is missing (rare but possible in some
    // sandboxed shells).
    const pathExt =
      (deps.envPathExt ?? process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
        .split(";")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    for (const dir of dirs) {
      // Try the literal basename first, then each PATHEXT extension.
      const literal = joinFor(platform, dir, "node");
      if (exists(literal)) return literal;
      for (const ext of pathExt) {
        const candidate = joinFor(platform, dir, `node${ext}`);
        if (exists(candidate)) return candidate;
      }
    }
    return null;
  }

  for (const dir of dirs) {
    const candidate = joinFor(platform, dir, "node");
    if (exists(candidate)) return candidate;
  }
  return null;
}

/**
 * Classify the `command` string from an IDE MCP config entry. See the
 * `CommandHealth` doc-comment for semantics.
 *
 * Bare-string handling:
 *   - "" / undefined-equivalent → `"missing"` (config exists but command
 *     field was blank — treat the same as a stale absolute path).
 *   - "node" / "node.exe" → resolve via PATH; `"ok"` or `"unresolved"`.
 *
 * Absolute-path handling:
 *   - blacklisted basename (regardless of disk existence) → `"wrong-runtime"`.
 *   - macOS `*.app/Contents/MacOS/<bin>` where `<bin>` ≠ node →
 *     `"wrong-runtime"`.
 *   - exists + node-shaped basename → `"ok"`.
 *   - exists + non-node basename + not blacklisted → `"unknown"`.
 *   - missing → `"missing"`.
 *
 * Relative non-bare paths are treated as `"unknown"` — we can't safely
 * resolve them without spawning, and the IDE will resolve them against its
 * own cwd, not ours.
 */
export function validateCommand(
  command: string | undefined | null,
  deps: ValidateCommandDeps = {},
): CommandHealth {
  if (typeof command !== "string" || command.trim().length === 0) {
    return "missing";
  }

  const trimmed = command.trim();
  const platform = deps.platform ?? process.platform;
  const exists = deps.existsSync ?? existsSync;

  // Normalize basename for case-insensitive comparison on Windows. On POSIX
  // we still lowercase for blacklist/Node-name matching because the
  // blacklist entries themselves are lowercase by convention; the IDE host
  // executables compare cleanly that way.
  const baseRaw = basename(trimmed);
  const base = baseRaw.toLowerCase();

  // Bare "node" / "node.exe" — try to resolve via PATH.
  const isBareNode = trimmed === "node" || trimmed === "node.exe";
  if (isBareNode) {
    const resolved = resolveBareNode(deps);
    return resolved ? "ok" : "unresolved";
  }

  // Anything else that isn't an absolute path: we can't classify safely
  // without executing it. Treat as unknown.
  if (!isAbsolute(trimmed)) {
    return "unknown";
  }

  // Absolute path. Blacklist always wins — even if a future macOS bundle
  // ships a binary named `Code` somewhere unexpected, we want to flag it.
  if (RUNTIME_BLACKLIST.has(base)) {
    return "wrong-runtime";
  }

  // macOS .app bundles: `/Applications/Foo.app/Contents/MacOS/Foo` is an
  // IDE host binary 99% of the time. The 1% where someone genuinely points
  // at a Node packaged inside a .app bundle still works because we only
  // flag it when the basename isn't node-shaped.
  if (platform === "darwin" || /\.app\//i.test(trimmed)) {
    if (/\.app\/Contents\/MacOS\//i.test(trimmed) && !isNodeBasename(base)) {
      return "wrong-runtime";
    }
  }

  if (!exists(trimmed)) {
    return "missing";
  }

  if (isNodeBasename(base)) {
    return "ok";
  }

  return "unknown";
}
