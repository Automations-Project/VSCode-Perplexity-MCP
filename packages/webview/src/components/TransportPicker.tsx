import type { IdeCapabilities, McpTransportId } from "@perplexity-user-mcp/shared";

interface TransportOption {
  id: McpTransportId;
  label: string;
  sublabel: string;
}

const OPTIONS: ReadonlyArray<TransportOption> = [
  {
    id: "stdio-in-process",
    label: "stdio — in-process",
    sublabel: "Legacy airgap. Each IDE spawns its own Chromium.",
  },
  {
    id: "stdio-daemon-proxy",
    label: "stdio — daemon proxy",
    sublabel: "Default. Shared Chromium across all IDEs.",
  },
  {
    id: "http-loopback",
    label: "HTTP — loopback",
    sublabel:
      "Client connects to 127.0.0.1. OAuth if supported, scoped bearer fallback.",
  },
  {
    id: "http-tunnel",
    label: "HTTP — tunnel",
    sublabel: "Public URL + OAuth. No secret is written to the config.",
  },
];

function isAvailable(
  transportId: McpTransportId,
  capabilities: IdeCapabilities,
): boolean {
  switch (transportId) {
    case "stdio-in-process":
    case "stdio-daemon-proxy":
      return capabilities.stdio;
    case "http-loopback":
      return (
        capabilities.httpOAuthLoopback || capabilities.httpBearerLoopback
      );
    case "http-tunnel":
      return capabilities.httpOAuthTunnel;
    default:
      return false;
  }
}

function reasonFor(
  transportId: McpTransportId,
  _capabilities: IdeCapabilities,
  ideDisplayName: string,
): string {
  switch (transportId) {
    case "stdio-in-process":
    case "stdio-daemon-proxy":
      return "This IDE doesn't support stdio MCP.";
    case "http-loopback":
      return `No evidence yet that ${ideDisplayName} supports HTTP loopback MCP.`;
    case "http-tunnel":
      return `No evidence yet that ${ideDisplayName} supports HTTP tunnel MCP.`;
    default:
      return "";
  }
}

export interface TransportPickerProps {
  ideTag: string;
  ideDisplayName: string;
  capabilities: IdeCapabilities;
  selected: McpTransportId;
  disabled?: boolean;
  /**
   * v0.8.5: when false, omit the http-tunnel option entirely from the
   * rendered radio list (not merely disabled — removed). The picker still
   * honours per-IDE capabilities for the remaining transports. Defaults to
   * `true` so callers that haven't migrated yet render the same four
   * options as before.
   */
  tunnelsEnabled?: boolean;
  send: (message: {
    type: "transport:select";
    payload: { ideTag: string; transportId: McpTransportId };
  }) => void;
}

export function TransportPicker(props: TransportPickerProps) {
  const {
    ideTag,
    ideDisplayName,
    capabilities,
    selected,
    disabled,
    tunnelsEnabled = true,
    send,
  } = props;

  // Filter http-tunnel out when the user hasn't opted into tunnels. The
  // other three transports remain subject to per-IDE capability gating.
  const visibleOptions = tunnelsEnabled
    ? OPTIONS
    : OPTIONS.filter((opt) => opt.id !== "http-tunnel");

  return (
    <fieldset className="transport-picker" aria-label="Transport">
      <legend className="eyebrow">Transport</legend>
      {visibleOptions.map((opt) => {
        const optionDisabled =
          Boolean(disabled) || !isAvailable(opt.id, capabilities);
        const reason = !isAvailable(opt.id, capabilities)
          ? reasonFor(opt.id, capabilities, ideDisplayName)
          : undefined;
        const isSelected = opt.id === selected;
        const classes = [
          "transport-option",
          optionDisabled ? "is-disabled" : "",
          isSelected ? "is-selected" : "",
        ]
          .filter(Boolean)
          .join(" ");

        return (
          <label key={opt.id} className={classes}>
            <input
              type="radio"
              name={`transport-${ideTag}`}
              value={opt.id}
              checked={isSelected}
              disabled={optionDisabled}
              onChange={() => {
                if (optionDisabled) return;
                if (opt.id === selected) return;
                send({
                  type: "transport:select",
                  payload: { ideTag, transportId: opt.id },
                });
              }}
            />
            <div>
              <div className="transport-option-label">{opt.label}</div>
              <div className="transport-option-sublabel text-[var(--text-muted)]">
                {opt.sublabel}
              </div>
              {reason ? (
                <div className="transport-option-reason text-[var(--text-warning,var(--text-muted))]">
                  {reason}
                </div>
              ) : null}
            </div>
          </label>
        );
      })}
    </fieldset>
  );
}
