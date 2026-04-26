import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { safeAtomicWriteFileSync } from "../../safe-write.js";

import { cloudflaredQuickProvider } from "./cloudflared-quick.js";
import { cloudflaredNamedProvider, createCloudflaredNamedProvider } from "./cloudflared-named.js";
import { ngrokProvider, NgrokNativeMissingError } from "./ngrok.js";
import type { TunnelProvider, TunnelProviderId, TunnelProviderStatus } from "./types.js";

export { NgrokNativeMissingError, loadNgrokNative, isNgrokNativeAvailable } from "./ngrok.js";

export { readNgrokSettings, writeNgrokSettings, clearNgrokSettings, getNgrokConfigPath } from "./ngrok-config.js";
export type { NgrokSettings } from "./ngrok-config.js";
export type { TunnelProvider, TunnelProviderId, TunnelProviderStatus, SetupCheck } from "./types.js";
export { createCloudflaredNamedProvider };
// Re-export the cf-named setup helpers so the extension runtime can drive the
// 8.4.3 setup flow (dashboard widget) through the same subpath it already uses
// for tunnel provider status + ngrok settings.
export {
  runCloudflaredLogin,
  listNamedTunnels,
  createNamedTunnel,
  deleteNamedTunnel,
  clearNamedTunnelConfig,
  writeTunnelConfig,
  readNamedTunnelConfig,
  getNamedTunnelConfigPath,
  isActiveConnectionDeleteFailure,
  DeleteNamedTunnelError,
} from "./cloudflared-named-setup.js";
export type {
  CloudflaredLoginResult,
  NamedTunnelSummary,
  CreatedTunnel,
  NamedTunnelConfig,
  DeletedNamedTunnel,
  DeleteNamedTunnelFailureReason,
} from "./cloudflared-named-setup.js";

const REGISTRY: Record<TunnelProviderId, TunnelProvider> = {
  "cf-quick": cloudflaredQuickProvider,
  ngrok: ngrokProvider,
  "cf-named": cloudflaredNamedProvider,
};

export function getTunnelProvider(id: TunnelProviderId): TunnelProvider {
  const provider = REGISTRY[id];
  if (!provider) {
    throw new Error(`Unknown tunnel provider: ${id}`);
  }
  return provider;
}

export function listTunnelProviders(): TunnelProvider[] {
  return Object.values(REGISTRY);
}

// ────────────────────────────────────────────────────────────────────
// Tunnel settings file: <configDir>/tunnel-settings.json
// Holds the user's provider preference. Separate from the daemon
// lockfile because it persists across daemon restarts.
// ────────────────────────────────────────────────────────────────────

export interface TunnelSettings {
  activeProvider: TunnelProviderId;
  updatedAt: string;
}

const DEFAULT_PROVIDER: TunnelProviderId = "cf-quick";

export function getTunnelSettingsPath(configDir: string): string {
  return join(configDir, "tunnel-settings.json");
}

export function readTunnelSettings(configDir: string): TunnelSettings {
  const path = getTunnelSettingsPath(configDir);
  if (!existsSync(path)) {
    return { activeProvider: DEFAULT_PROVIDER, updatedAt: new Date(0).toISOString() };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<TunnelSettings>;
    const activeProvider = parsed.activeProvider && parsed.activeProvider in REGISTRY
      ? (parsed.activeProvider as TunnelProviderId)
      : DEFAULT_PROVIDER;
    return {
      activeProvider,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
    };
  } catch {
    return { activeProvider: DEFAULT_PROVIDER, updatedAt: new Date().toISOString() };
  }
}

export function writeTunnelSettings(configDir: string, patch: Partial<TunnelSettings>): TunnelSettings {
  const path = getTunnelSettingsPath(configDir);
  const prev = readTunnelSettings(configDir);
  const next: TunnelSettings = {
    activeProvider: patch.activeProvider && patch.activeProvider in REGISTRY
      ? (patch.activeProvider as TunnelProviderId)
      : prev.activeProvider,
    updatedAt: new Date().toISOString(),
  };
  mkdirSync(dirname(path), { recursive: true });
  safeAtomicWriteFileSync(path, JSON.stringify(next, null, 2) + "\n", "utf8");
  return next;
}

export async function listTunnelProviderStatuses(configDir: string): Promise<TunnelProviderStatus[]> {
  const { activeProvider } = readTunnelSettings(configDir);
  const results: TunnelProviderStatus[] = [];
  for (const provider of listTunnelProviders()) {
    const setup = await provider.isSetupComplete(configDir);
    results.push({
      id: provider.id,
      displayName: provider.displayName,
      description: provider.description,
      setup,
      isActive: provider.id === activeProvider,
    });
  }
  return results;
}
