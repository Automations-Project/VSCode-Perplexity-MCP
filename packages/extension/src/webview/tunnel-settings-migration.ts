import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";

const MIGRATION_KEY = "perplexity.enableTunnels.migrated";

/**
 * Injection surface used by unit tests. Production calls default to the real
 * filesystem and the real VS Code configuration. The helper reads
 * `<configDir>/tunnel-settings.json` directly rather than going through
 * `perplexity-user-mcp/daemon/tunnel-providers` because the migration needs
 * to know whether the FILE exists — readTunnelSettings() synthesizes a
 * default object when the file is missing, which is the wrong signal here:
 * a newly-installed user with no tunnel ever configured shouldn't be flipped
 * to enableTunnels=true.
 */
export interface MigrateDeps {
  configDir: string;
  /** Defaults to node:fs existsSync. */
  fileExists?: (path: string) => boolean;
  /** Defaults to node:fs readFileSync. */
  readFile?: (path: string) => string;
}

/**
 * v0.8.5 loopback-default rollout. Upgraders who already configured a tunnel
 * provider in a prior release have a tunnel-settings.json on disk; we flip
 * `enableTunnels` to `true` for them so the familiar UI stays visible. Fresh
 * installs (no tunnel-settings.json) get loopback-only posture with the
 * opt-in card. Explicit user choices in VS Code settings always win.
 */
export async function migrateEnableTunnelsOnce(
  context: vscode.ExtensionContext,
  deps: MigrateDeps
): Promise<void> {
  if (context.globalState.get<boolean>(MIGRATION_KEY)) return;

  const config = vscode.workspace.getConfiguration("Perplexity");
  // If user has already explicitly set enableTunnels in their global/workspace
  // settings, don't override — their choice wins over the migration heuristic.
  const inspect = config.inspect<boolean>("enableTunnels");
  const userSet =
    inspect?.globalValue !== undefined ||
    inspect?.workspaceValue !== undefined;
  if (userSet) {
    await context.globalState.update(MIGRATION_KEY, true);
    return;
  }

  const fileExists = deps.fileExists ?? existsSync;
  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  const settingsPath = join(deps.configDir, "tunnel-settings.json");

  try {
    if (fileExists(settingsPath)) {
      const raw = readFile(settingsPath);
      const parsed = JSON.parse(raw) as { activeProvider?: unknown };
      const hasProvider =
        typeof parsed.activeProvider === "string" &&
        parsed.activeProvider.length > 0;
      if (hasProvider) {
        await config.update(
          "enableTunnels",
          true,
          vscode.ConfigurationTarget.Global
        );
      }
    }
  } catch {
    // Unreadable / malformed tunnel-settings.json — treat as "no migration
    // signal" and leave enableTunnels at its default (false). The user can
    // always flip it on manually from the opt-in card.
  }

  await context.globalState.update(MIGRATION_KEY, true);
}

export { MIGRATION_KEY as ENABLE_TUNNELS_MIGRATION_KEY };
