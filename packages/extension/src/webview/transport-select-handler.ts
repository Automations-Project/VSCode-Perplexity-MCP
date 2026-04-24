import { IDE_METADATA, type McpTransportId } from "@perplexity-user-mcp/shared";

/**
 * Phase 8.4 / v0.8.4 - Pure handler for the `transport:select` webview
 * message. Extracted into its own module so the router in DashboardProvider
 * stays thin and the decision logic (ideTag validation, workspace config
 * read/write, post-settings) is unit-testable without a full vscode shim.
 *
 * The handler MUST:
 *   1. Refuse silently (ok=false) when ideTag is not in IDE_METADATA.
 *      The picker UI already filters unknown tags; this is defensive only.
 *   2. Read the current `Perplexity.mcpTransportByIde` map.
 *   3. Merge the new { [ideTag]: transportId } entry.
 *   4. Write back via `ConfigurationTarget.Global`.
 *   5. Return ok=true so the caller can post-settings and `postActionResult`.
 */

export interface TransportSelectDeps {
  /** Returns the current mcpTransportByIde map. Missing keys fall back to `{}`. */
  readTransportByIde: () => Record<string, McpTransportId>;
  /** Writes the full replacement map to user/global settings. */
  writeTransportByIde: (next: Record<string, McpTransportId>) => Promise<void>;
}

export interface TransportSelectInput {
  ideTag: string;
  transportId: McpTransportId;
}

export interface TransportSelectOutcome {
  ok: boolean;
  /** Populated only when ok=true; the new map after the update. */
  next?: Record<string, McpTransportId>;
  /** Populated only when ok=false; short machine-readable reason. */
  reason?: "unknown-ide" | "write-failed";
  /** Populated only on write-failed; the underlying error message. */
  error?: string;
}

export async function handleTransportSelect(
  input: TransportSelectInput,
  deps: TransportSelectDeps,
): Promise<TransportSelectOutcome> {
  if (!(input.ideTag in IDE_METADATA)) {
    return { ok: false, reason: "unknown-ide" };
  }

  const current = deps.readTransportByIde();
  const next: Record<string, McpTransportId> = {
    ...current,
    [input.ideTag]: input.transportId,
  };

  try {
    await deps.writeTransportByIde(next);
  } catch (err) {
    return {
      ok: false,
      reason: "write-failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }

  return { ok: true, next };
}
