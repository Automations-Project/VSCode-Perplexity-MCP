import { CheckCircle2, Download, FolderOpen, Monitor, RefreshCcw, Sparkles, Trash2, TriangleAlert } from "lucide-react";
import type {
  AuthState,
  BrowserChannel,
  BrowserInfo,
  WebviewMessage,
} from "@perplexity-user-mcp/shared";
import { DaemonActionButton } from "./DaemonActionButton";
import { StatusDot } from "./StatusDot";
import { getBrowserIcon } from "../browser-icons";

/**
 * The full browser-runtime picker: every detected Chromium-family browser,
 * plus the bundled-Chromium downloader.
 *
 * State comes entirely from `AuthState` (produced by AuthManager). All writes
 * go back out via `WebviewMessage` — no local mutation — so the extension
 * host is the single source of truth for persistence + process lifecycle.
 */

type SendFn = (message: WebviewMessage | Omit<Extract<WebviewMessage, { id: string }>, "id">) => void;

interface BrowserSettingsProps {
  auth: AuthState | null;
  send: SendFn;
}

/**
 * Pick a small brand icon for each channel so the radio options read
 * at a glance even when labels truncate on narrow dashboards.
 */
const CHANNEL_ICON: Record<BrowserChannel, () => React.ReactNode> = {
  chrome: getBrowserIcon("chrome"),
  msedge: getBrowserIcon("msedge"),
  chromium: getBrowserIcon("chromium"),
};

function channelLabel(channel?: BrowserChannel): string {
  switch (channel) {
    case "chrome": return "Google Chrome";
    case "msedge": return "Microsoft Edge";
    case "chromium": return "Chromium-based";
    default: return "Unknown";
  }
}

function truncatePath(p: string | undefined): string {
  if (!p) return "";
  if (p.length <= 58) return p;
  return `${p.slice(0, 25)}…${p.slice(-30)}`;
}

function BrowserActiveChip({ browser }: { browser: BrowserInfo | undefined }) {
  if (!browser?.found) {
    return (
      <span className="chip chip-warn" data-testid="browser-active-chip">
        <TriangleAlert size={12} />
        <span>No browser detected</span>
      </span>
    );
  }
  const Icon = browser.channel ? CHANNEL_ICON[browser.channel] : CHANNEL_ICON.chromium;
  return (
    <span className="chip chip-pro" data-testid="browser-active-chip">
      <StatusDot variant="ok" decorative />
      <span>
        <span aria-hidden="true" className="browser-active-icon"><Icon /></span>
        {browser.label ?? channelLabel(browser.channel)}
      </span>
    </span>
  );
}

/**
 * A single row in the radio-picker. Selection fires a `browser:select`
 * message with the full triple (channel + path + label) so the extension
 * host doesn't have to re-derive fields from the label.
 */
function BrowserOption({
  option,
  isSelected,
  send,
}: {
  option: BrowserInfo;
  isSelected: boolean;
  send: SendFn;
}) {
  const Icon = option.channel ? CHANNEL_ICON[option.channel] : CHANNEL_ICON.chromium;
  const channel = option.channel;
  const sublabel = option.executablePath
    ? truncatePath(option.executablePath)
    : option.downloaded
      ? "Bundled with the extension"
      : "";

  const classes = [
    "browser-option",
    isSelected ? "is-selected" : "",
  ].filter(Boolean).join(" ");

  return (
    <label className={classes} data-testid={`browser-option-${option.channel ?? "unknown"}`}>
      <input
        type="radio"
        name="browser-pick"
        checked={isSelected}
        disabled={!option.found}
        onChange={() => {
          send({
            type: "browser:select",
            payload: {
              mode: "auto",
              ...(channel ? { channel } : {}),
              ...(option.executablePath ? { executablePath: option.executablePath } : {}),
              ...(option.label ? { label: option.label } : {}),
            },
          });
        }}
      />
      <div className="browser-option-body">
        <div className="browser-option-label">
          <span aria-hidden="true" className="browser-option-icon"><Icon /></span>
          {option.label ?? channelLabel(option.channel)}
          {option.downloaded && (
            <span className="chip chip-neutral browser-option-tag">Bundled</span>
          )}
        </div>
        {sublabel && (
          <div className="browser-option-sublabel text-[var(--text-muted)]">{sublabel}</div>
        )}
      </div>
    </label>
  );
}

function ProgressBar({ value }: { value: number }) {
  const clamped = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div className="browser-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={clamped}>
      <div className="browser-progress-fill" style={{ width: `${clamped}%` }} />
      <span className="browser-progress-label">{clamped}%</span>
    </div>
  );
}

/**
 * Bundled-Chromium installer. Patchright bakes the launch path into its
 * runtime so there's no subprocess lifecycle to manage — only download +
 * remove.
 */
function BundledChromiumCard({ auth, send }: BrowserSettingsProps) {
  const download = auth?.browserDownload;
  const downloading = download?.status === "downloading";
  const errored = download?.status === "error";
  const bundled = (auth?.availableBrowsers ?? []).find((b) => b.downloaded);

  return (
    <div className="browser-subcard">
      <div className="browser-subcard-header">
        <div className="browser-subcard-title">
          <Monitor size={13} />
          <span>Bundled Chromium</span>
        </div>
        <div className="browser-subcard-detail">
          Patchright's prebuilt Chromium (~170 MB). Zero-system-browser fallback that lives inside the extension's globalStorage.
        </div>
      </div>

      {errored && download?.error && (
        <div className="browser-inline-error" data-testid="bundled-error">
          <TriangleAlert size={12} />
          <span>{download.error}</span>
        </div>
      )}

      {bundled && (
        <div className="browser-running-row" data-testid="bundled-installed">
          <CheckCircle2 size={12} />
          <span className="browser-running-label">
            Installed · <code>{truncatePath(bundled.executablePath)}</code>
          </span>
        </div>
      )}

      {downloading && <ProgressBar value={download?.progress ?? 0} />}

      <div className="browser-action-row">
        {!bundled && !downloading && (
          <DaemonActionButton
            type="browser:install-bundled"
            label="Install bundled Chromium (~170 MB)"
            pendingLabel="Installing…"
            className="primary-button btn-sm"
            icon={<Download size={12} />}
            onClick={() => send({ type: "browser:install-bundled" })}
            data-testid="bundled-install"
          />
        )}
        {bundled && !downloading && (
          <DaemonActionButton
            type="browser:remove-bundled"
            label="Remove"
            pendingLabel="Removing…"
            className="ghost-button btn-sm"
            icon={<Trash2 size={12} />}
            onClick={() => send({ type: "browser:remove-bundled" })}
            data-testid="bundled-remove"
          />
        )}
      </div>
    </div>
  );
}

export function BrowserSettings({ auth, send }: BrowserSettingsProps) {
  const available = auth?.availableBrowsers ?? [];
  const active = auth?.browser;
  const choice = auth?.browserChoice;
  const isCustom = choice?.mode === "custom";

  // Determine which option is "currently picked". For custom mode, none of
  // the detected options match — we surface the custom path as its own row.
  // We read the persisted user pick (`choice`) before the runtime-resolved
  // `active` so the picker reflects intent even before resolution catches
  // up (e.g. between selection and the next detection refresh).
  const selectedPath = !isCustom ? (choice?.executablePath ?? active?.executablePath) : undefined;
  const selectedChannel = !isCustom ? (choice?.channel ?? active?.channel) : undefined;

  // Every detected runtime is selectable in the radio picker — including
  // Bundled Chromium. The Bundled-Chromium card still owns the install/remove
  // lifecycle; the picker is just where the user pins which runtime is active.
  const allBrowsers: BrowserInfo[] = available;

  return (
    <div className="glass-panel section-panel" data-testid="browser-settings-card">
      <div className="section-header">
        <div className="eyebrow">Browser Runtime</div>
        <div className="title">How MCP reaches Perplexity</div>
        <div className="detail">
          Pick which Chromium-family browser the MCP server uses for both login and headless search. Chrome is the safe default; if no system browser is installed, download patchright's bundled Chromium below.
        </div>
      </div>

      <div className="browser-active-row">
        <div className="eyebrow">Active</div>
        <BrowserActiveChip browser={active} />
        <div className="browser-active-actions">
          <DaemonActionButton
            type="browser:refresh-detection"
            label="Refresh"
            pendingLabel="Scanning…"
            className="ghost-button btn-sm"
            icon={<RefreshCcw size={11} />}
            onClick={() => send({ type: "browser:refresh-detection" })}
            data-testid="browser-refresh"
          />
          <DaemonActionButton
            type="browser:pick-custom"
            label="Browse…"
            pendingLabel="Opening…"
            className="ghost-button btn-sm"
            icon={<FolderOpen size={11} />}
            onClick={() => send({ type: "browser:pick-custom" })}
            data-testid="browser-pick-custom"
          />
        </div>
      </div>

      {isCustom && choice?.executablePath && (
        <div className="browser-custom-row" data-testid="browser-custom-row">
          <span className="chip chip-accent">
            <Sparkles size={12} />
            <span>Custom</span>
          </span>
          <code className="browser-custom-path" title={choice.executablePath}>
            {truncatePath(choice.executablePath)}
          </code>
          <button
            className="ghost-button btn-sm"
            onClick={() => send({ type: "browser:select", payload: { mode: "auto" } })}
            data-testid="browser-clear-custom"
          >
            Clear
          </button>
        </div>
      )}

      {available.length === 0 ? (
        <div className="browser-empty" data-testid="browser-empty">
          <TriangleAlert size={14} />
          <span>No Chromium-family browser detected. Install Chrome/Edge/Brave or download bundled Chromium below.</span>
        </div>
      ) : (
        <fieldset className="browser-picker" aria-label="Browser runtime">
          <legend className="eyebrow">Detected browsers</legend>
          {allBrowsers.map((option, idx) => {
            const isSelected = !isCustom && option.found && (
              (!!selectedPath && option.executablePath === selectedPath) ||
              (!selectedPath && option.channel === selectedChannel && idx === 0)
            );
            return (
              <BrowserOption
                key={`${option.channel ?? "unknown"}-${option.executablePath ?? idx}`}
                option={option}
                isSelected={isSelected}
                send={send}
              />
            );
          })}
        </fieldset>
      )}

      <div className="browser-subcard-grid">
        <BundledChromiumCard auth={auth} send={send} />
      </div>
    </div>
  );
}
