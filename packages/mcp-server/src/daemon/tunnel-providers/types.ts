import type { StartedTunnel, TunnelState } from "../tunnel.js";

export type TunnelProviderId = "cf-quick" | "ngrok";

export interface TunnelProviderStartOptions {
  port: number;
  configDir: string;
  onStateChange: (state: TunnelState) => void;
}

export interface SetupCheck {
  ready: boolean;
  /** User-facing reason the provider isn't ready (e.g. "ngrok authtoken not set"). */
  reason?: string;
  /** Optional action hint the dashboard can surface. */
  action?: { label: string; kind: "open-url" | "input-authtoken" | "install-binary"; url?: string };
}

export interface TunnelProvider {
  readonly id: TunnelProviderId;
  readonly displayName: string;
  /** Brief description surfaced next to the provider in the dashboard picker. */
  readonly description: string;
  /**
   * Returns whether the provider has everything it needs to start a tunnel.
   * Called before start(); the dashboard also calls this to render a setup widget.
   */
  isSetupComplete(configDir: string): Promise<SetupCheck>;
  /**
   * Start the tunnel. Must resolve once the public URL is known OR reject if
   * setup is missing / start fails. onStateChange fires on every state
   * transition including "starting" and "enabled".
   */
  start(options: TunnelProviderStartOptions): Promise<StartedTunnel>;
}

export interface TunnelProviderStatus {
  id: TunnelProviderId;
  displayName: string;
  description: string;
  setup: SetupCheck;
  isActive: boolean;
}
