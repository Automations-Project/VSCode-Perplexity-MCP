import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { getConfigDir, getActiveName, getProfilePaths } from "./profiles.js";

const BUILTIN_VIEWERS = [
  {
    id: "obsidian",
    label: "Obsidian",
    urlTemplate: "obsidian://open?vault={vaultName}&file={relPath}",
    needsVaultBridge: true,
  },
  {
    id: "typora",
    label: "Typora",
    urlTemplate: "typora://{absPath}",
    needsVaultBridge: false,
  },
  {
    id: "logseq",
    label: "Logseq",
    urlTemplate: "logseq://graph/{graphName}?page={filenameNoExt}",
    needsVaultBridge: true,
  },
];

export function listViewers(overrides = []) {
  const resolvedOverrides = overrides.length > 0 ? overrides : loadViewerConfig();
  const byId = new Map(BUILTIN_VIEWERS.map((viewer) => [viewer.id, {
    ...viewer,
    detected: false,
    enabled: false,
  }]));
  for (const viewer of resolvedOverrides) {
    byId.set(viewer.id, { ...byId.get(viewer.id), ...viewer });
  }
  return [...byId.values()];
}

function getConfigPath() {
  return join(getConfigDir(), "config.json");
}

function readConfig() {
  if (!existsSync(getConfigPath())) {
    return {};
  }
  try {
    return JSON.parse(readFileSync(getConfigPath(), "utf8"));
  } catch {
    return {};
  }
}

function writeConfig(nextConfig) {
  mkdirSync(dirname(getConfigPath()), { recursive: true });
  const tempPath = `${getConfigPath()}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");
  renameSync(tempPath, getConfigPath());
}

export function loadViewerConfig() {
  const config = readConfig();
  return Array.isArray(config.mdViewers) ? config.mdViewers : [];
}

export function saveViewerConfig(viewer) {
  const config = readConfig();
  const current = Array.isArray(config.mdViewers) ? config.mdViewers : [];
  const next = [...current.filter((item) => item?.id !== viewer.id), viewer];
  writeConfig({ ...config, mdViewers: next });
  return viewer;
}

export function substituteViewerTemplate(viewer, values) {
  const requiredSafe = ["absPath", "relPath", "vault", "vaultName", "filename", "filenameNoExt", "profile", "graphName"];
  const safeValues = Object.fromEntries(requiredSafe.map((key) => [key, encodeURIComponent(String(values?.[key] ?? ""))]));
  return viewer.urlTemplate.replace(/\{([a-zA-Z0-9]+)\}/g, (_, key) => safeValues[key] ?? "");
}

export function ensureObsidianBridge(options) {
  const { mdPath, viewer, profile = process.env.PERPLEXITY_PROFILE || getActiveName() || "default" } = options;
  if (!viewer?.vaultPath || !viewer?.vaultName) {
    throw new Error("Obsidian viewer requires vaultPath and vaultName.");
  }

  const historyDir = getProfilePaths(profile).history;
  const relPath = relative(historyDir, mdPath);
  if (relPath.startsWith("..")) {
    throw new Error("Refusing to bridge a markdown file outside the profile history directory.");
  }

  const bridgePath = resolve(join(viewer.vaultPath, "Perplexity", profile, relPath));
  mkdirSync(dirname(bridgePath), { recursive: true });
  copyFileSync(mdPath, bridgePath);
  return bridgePath;
}

export function buildViewerUrl(options) {
  const {
    viewer,
    mdPath,
    profile = process.env.PERPLEXITY_PROFILE || getActiveName() || "default",
  } = options;

  const activePath = viewer.needsVaultBridge ? ensureObsidianBridge({ mdPath, viewer, profile }) : mdPath;
  const relPath = relative(getConfigDir(), activePath).replace(/\\/g, "/");
  const filename = activePath.split(/[\\/]/).pop() ?? "entry.md";
  const filenameNoExt = filename.replace(/\.[^.]+$/, "");

  return substituteViewerTemplate(viewer, {
    absPath: activePath,
    relPath,
    vault: viewer.vaultPath ?? "",
    vaultName: viewer.vaultName ?? "",
    filename,
    filenameNoExt,
    profile,
    graphName: viewer.graphName ?? "",
  });
}
