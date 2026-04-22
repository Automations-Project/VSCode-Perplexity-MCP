import * as vscode from "vscode";
import type { ExtensionSettingsSnapshot } from "@perplexity-user-mcp/shared";

const SECTION = "Perplexity";

const DEFAULTS: ExtensionSettingsSnapshot = {
  defaultSearchModel: "pplx_pro",
  reasonModel: "claude46sonnetthinking",
  researchModel: "pplx_alpha",
  computeModel: "pplx_asi",
  chromePath: "",
  debugMode: false,
  autoConfigureCursor: false,
  autoConfigureWindsurf: false,
  autoConfigureWindsurfNext: false,
  autoConfigureClaudeDesktop: false,
  autoConfigureClaudeCode: false,
  autoConfigureCline: false,
  autoConfigureAmp: false,
  autoConfigureCodexCli: false,
  autoRefreshIntervalHours: 0,
  debugBufferSize: 1000,
  debugVerboseHttp: false,
  oauthConsentCacheTtlHours: 24
};

export function getSettingsSnapshot(): ExtensionSettingsSnapshot {
  const configuration = vscode.workspace.getConfiguration(SECTION);
  return {
    defaultSearchModel: configuration.get("defaultSearchModel", DEFAULTS.defaultSearchModel),
    reasonModel: configuration.get("reasonModel", DEFAULTS.reasonModel),
    researchModel: configuration.get("researchModel", DEFAULTS.researchModel),
    computeModel: configuration.get("computeModel", DEFAULTS.computeModel),
    chromePath: configuration.get("chromePath", DEFAULTS.chromePath),
    debugMode: configuration.get("debugMode", DEFAULTS.debugMode),
    autoConfigureCursor: configuration.get("autoConfigureCursor", DEFAULTS.autoConfigureCursor),
    autoConfigureWindsurf: configuration.get("autoConfigureWindsurf", DEFAULTS.autoConfigureWindsurf),
    autoConfigureWindsurfNext: configuration.get("autoConfigureWindsurfNext", DEFAULTS.autoConfigureWindsurfNext),
    autoConfigureClaudeDesktop: configuration.get(
      "autoConfigureClaudeDesktop",
      DEFAULTS.autoConfigureClaudeDesktop
    ),
    autoConfigureClaudeCode: configuration.get(
      "autoConfigureClaudeCode",
      DEFAULTS.autoConfigureClaudeCode
    ),
    autoConfigureCline: configuration.get(
      "autoConfigureCline",
      DEFAULTS.autoConfigureCline
    ),
    autoConfigureAmp: configuration.get(
      "autoConfigureAmp",
      DEFAULTS.autoConfigureAmp
    ),
    autoConfigureCodexCli: configuration.get(
      "autoConfigureCodexCli",
      DEFAULTS.autoConfigureCodexCli
    ),
    autoRefreshIntervalHours: configuration.get("autoRefreshIntervalHours", DEFAULTS.autoRefreshIntervalHours),
    debugBufferSize: configuration.get("debugBufferSize", DEFAULTS.debugBufferSize),
    debugVerboseHttp: configuration.get("debugVerboseHttp", DEFAULTS.debugVerboseHttp),
    oauthConsentCacheTtlHours: configuration.get(
      "oauthConsentCacheTtlHours",
      DEFAULTS.oauthConsentCacheTtlHours
    )
  } satisfies ExtensionSettingsSnapshot;
}

export async function updateSettings(
  partial: Partial<ExtensionSettingsSnapshot>,
  target: vscode.ConfigurationTarget = vscode.ConfigurationTarget.Global
): Promise<void> {
  const configuration = vscode.workspace.getConfiguration(SECTION);
  await Promise.all(
    Object.entries(partial).map(([key, value]) => configuration.update(key, value, target))
  );
}
