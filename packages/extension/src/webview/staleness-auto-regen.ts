import {
  IDE_METADATA,
  MCP_TRANSPORT_DEFAULT,
  type IdeTarget,
  type McpTransportId,
} from "@perplexity-user-mcp/shared";

import type {
  ApplyIdeConfigDeps,
  ApplyIdeConfigResult,
  IdeConfigOptions,
} from "../auto-config/index.js";
import type { StaleConfigEntry } from "./staleness-detector.js";

/**
 * v0.8.5 - Auto-regenerate stale MCP configs.
 *
 * Staleness in an IDE's mcp.json is caused exclusively by the extension's own
 * side effects (daemon port rotating after ephemeral-port restart, tunnel URL
 * rotating, bearer token rotating). Rewriting the config with the current live
 * values is a REFRESH, not a silent first-time write - the user already
 * approved this IDE + transport pair when the config was originally created.
 *
 * The pure helper lives here so the decision logic (setting gate, confirm
 * override, per-IDE try/catch, audit tagging) is testable without standing up
 * the full DashboardProvider + vscode mock tree. DashboardProvider wires the
 * live deps and calls this from its `postStaleness` hook.
 */

export interface RegenerateStaleIdesInput {
  /** Staleness map from `detectStaleConfigs`. Empty = no-op. */
  stale: readonly StaleConfigEntry[];
  /** Whether the setting is enabled. `false` = no-op so the banner remains. */
  autoRegenerateStaleConfigs: boolean;
  /** Per-IDE transport selection. Missing keys fall back to MCP_TRANSPORT_DEFAULT. */
  mcpTransportByIde: Readonly<Record<string, McpTransportId>>;
  /** Absolute path to the stable launcher. Threaded through applyIdeConfig options. */
  serverPath: string;
  /** Optional Chrome path override (cloned from settings). */
  chromePath?: string;
}

export interface RegenerateStaleIdesDeps {
  /**
   * Returns the live ApplyIdeConfigDeps but with `confirmTransport` and
   * `nudgePortPin` pre-overridden for the auto-regen path (see factory below).
   */
  buildDeps: () => Promise<ApplyIdeConfigDeps>;
  /** Invokes the real applyIdeConfig. Injected so tests don't touch disk. */
  applyIdeConfig: (
    options: IdeConfigOptions,
    deps: ApplyIdeConfigDeps,
  ) => Promise<ApplyIdeConfigResult>;
  /**
   * Resolves a real Node.js binary for stdio transport `command` fields.
   * Called once per batch (not per IDE) and forwarded into every applyIdeConfig
   * call. Mirrors `configureTargets`'s nodePath defaulting so an auto-refresh
   * cannot silently rewrite a fixed stdio config back to `process.execPath`
   * (which inside the VS Code extension host is the Electron binary).
   */
  resolveNodePath: () => string;
  /** Debug trace sink (extension output channel in production). */
  debug: (line: string) => void;
  /** Called after the batch so the webview's staleness banner can re-render. */
  refresh: () => Promise<void>;
}

export interface RegenerateStaleIdesOutcome {
  /** True iff the setting was enabled AND there was at least one stale entry. */
  ran: boolean;
  /** Per-IDE outcome; empty when ran=false. */
  results: Array<{
    ideTag: string;
    transportId: McpTransportId;
    status: "ok" | "failed" | "threw" | "skipped-unknown-ide";
    reason?: string;
    message?: string;
  }>;
}

/**
 * Applies updated transport configs to every stale IDE. Per-IDE errors are
 * swallowed so one misconfigured IDE can't block the rest of the batch;
 * details are returned in the outcome and surfaced through `debug`.
 */
export async function regenerateStaleIdes(
  input: RegenerateStaleIdesInput,
  deps: RegenerateStaleIdesDeps,
): Promise<RegenerateStaleIdesOutcome> {
  if (input.stale.length === 0) {
    return { ran: false, results: [] };
  }
  if (!input.autoRegenerateStaleConfigs) {
    deps.debug(
      `[staleness] auto-regenerate disabled; ${input.stale.length} stale config${
        input.stale.length === 1 ? "" : "s"
      } left for manual user action`,
    );
    return { ran: false, results: [] };
  }

  deps.debug(
    `[staleness] auto-regenerating ${input.stale.length} stale config${
      input.stale.length === 1 ? "" : "s"
    }`,
  );

  const applyDeps = await deps.buildDeps();
  // Resolve the Node interpreter once per batch and forward it into every
  // applyIdeConfig call. See the dep's JSDoc for the rationale; the same
  // defaulting also happens inside configureTargets for the user-initiated
  // "Regenerate all" path.
  const nodePath = deps.resolveNodePath();
  const results: RegenerateStaleIdesOutcome["results"] = [];

  for (const entry of input.stale) {
    const transportId: McpTransportId =
      input.mcpTransportByIde[entry.ideTag] ?? MCP_TRANSPORT_DEFAULT;

    // The picker surface guards against unknown tags, but the staleness map is
    // derived from on-disk config and could in theory include a tag that was
    // removed between releases. Skip rather than crash the batch.
    if (!(entry.ideTag in IDE_METADATA)) {
      deps.debug(`[staleness] auto-regenerate ${entry.ideTag}: unknown ide tag, skipped`);
      results.push({ ideTag: entry.ideTag, transportId, status: "skipped-unknown-ide" });
      continue;
    }

    try {
      const result = await deps.applyIdeConfig(
        {
          target: entry.ideTag as IdeTarget,
          serverPath: input.serverPath,
          chromePath: input.chromePath,
          nodePath,
          transportId,
        },
        applyDeps,
      );
      if (result.ok) {
        deps.debug(`[staleness] auto-regenerated ${entry.ideTag} transport=${transportId}`);
        results.push({ ideTag: entry.ideTag, transportId, status: "ok" });
      } else {
        deps.debug(
          `[staleness] auto-regenerate ${entry.ideTag} failed: ${result.reason} ${result.message}`,
        );
        results.push({
          ideTag: entry.ideTag,
          transportId,
          status: "failed",
          reason: result.reason,
          message: result.message,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.debug(`[staleness] auto-regenerate ${entry.ideTag} threw: ${message}`);
      results.push({ ideTag: entry.ideTag, transportId, status: "threw", message });
    }
  }

  // Re-run the detector + post the (hopefully empty) map so the banner clears.
  await deps.refresh();

  return { ran: true, results };
}

/**
 * Wraps a live `ApplyIdeConfigDeps` with the two overrides the auto-regen path
 * requires:
 *
 * 1. `confirmTransport` -> always `true`. The user already approved this pair
 *    when the config was first generated; the refresh is not a surprise write.
 * 2. `nudgePortPin` -> no-op. The user has already been notified about the
 *    port mismatch through the staleness banner; duplicating the prompt here
 *    would be noise.
 * 3. `auditGenerated` -> the same line the live factory emits, with `auto=true`
 *    appended so audit readers can distinguish a user-initiated regenerate
 *    from an auto-refresh.
 *
 * `warnSyncFolder` is deliberately NOT overridden: a config that lives in a
 * cloud-sync folder should still prompt the user, even on a refresh, because
 * the sync-leak risk does not go away when the pair is already approved.
 */
export function wrapDepsForAutoRegen(
  base: ApplyIdeConfigDeps,
  auditSink: (line: string) => void,
): ApplyIdeConfigDeps {
  return {
    ...base,
    confirmTransport: async () => true,
    nudgePortPin: () => {},
    auditGenerated: (entry) => {
      auditSink(
        `[auto-config:audit] ide=${entry.ideTag} transport=${entry.transportId} ` +
          `bearer=${entry.bearerKind} result=${entry.resultCode} path=${entry.configPath} auto=true`,
      );
    },
  };
}
