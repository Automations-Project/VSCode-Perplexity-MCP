// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import type { IdeCapabilities, McpTransportId } from "@perplexity-user-mcp/shared";
import { TransportPicker } from "../src/components/TransportPicker.tsx";

afterEach(() => {
  cleanup();
});

const fullyCapable: IdeCapabilities = {
  stdio: true,
  httpBearerLoopback: true,
  httpOAuthLoopback: true,
  httpOAuthTunnel: true,
};

function makeCaps(overrides: Partial<IdeCapabilities> = {}): IdeCapabilities {
  return { ...fullyCapable, ...overrides };
}

function getRadio(id: McpTransportId): HTMLInputElement {
  const el = document.querySelector<HTMLInputElement>(
    `input[type="radio"][value="${id}"]`,
  );
  if (!el) {
    throw new Error(`Radio input for ${id} not found`);
  }
  return el;
}

describe("TransportPicker", () => {
  it("renders four radio inputs with the four transport ids", () => {
    const send = vi.fn();
    render(
      <TransportPicker
        ideTag="cursor"
        ideDisplayName="Cursor"
        capabilities={makeCaps()}
        selected="stdio-daemon-proxy"
        send={send}
      />,
    );
    const radios = document.querySelectorAll<HTMLInputElement>(
      'input[type="radio"]',
    );
    expect(radios).toHaveLength(4);
    const values = Array.from(radios).map((r) => r.value).sort();
    expect(values).toEqual(
      [
        "http-loopback",
        "http-tunnel",
        "stdio-daemon-proxy",
        "stdio-in-process",
      ].sort(),
    );
  });

  it("only the `selected` prop's option is checked", () => {
    render(
      <TransportPicker
        ideTag="cursor"
        ideDisplayName="Cursor"
        capabilities={makeCaps()}
        selected="http-loopback"
        send={vi.fn()}
      />,
    );
    expect(getRadio("stdio-in-process").checked).toBe(false);
    expect(getRadio("stdio-daemon-proxy").checked).toBe(false);
    expect(getRadio("http-loopback").checked).toBe(true);
    expect(getRadio("http-tunnel").checked).toBe(false);
  });

  it("clicking a different available option calls send with the new transportId", () => {
    const send = vi.fn();
    render(
      <TransportPicker
        ideTag="cursor"
        ideDisplayName="Cursor"
        capabilities={makeCaps()}
        selected="stdio-daemon-proxy"
        send={send}
      />,
    );
    fireEvent.click(getRadio("http-tunnel"));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      type: "transport:select",
      payload: { ideTag: "cursor", transportId: "http-tunnel" },
    });
  });

  it("clicking the currently-selected option is a no-op", () => {
    const send = vi.fn();
    render(
      <TransportPicker
        ideTag="cursor"
        ideDisplayName="Cursor"
        capabilities={makeCaps()}
        selected="stdio-daemon-proxy"
        send={send}
      />,
    );
    fireEvent.click(getRadio("stdio-daemon-proxy"));
    expect(send).not.toHaveBeenCalled();
  });

  it("both stdio options are disabled when capabilities.stdio is false", () => {
    render(
      <TransportPicker
        ideTag="copilot"
        ideDisplayName="GitHub Copilot"
        capabilities={makeCaps({ stdio: false })}
        selected="http-loopback"
        send={vi.fn()}
      />,
    );
    expect(getRadio("stdio-in-process").disabled).toBe(true);
    expect(getRadio("stdio-daemon-proxy").disabled).toBe(true);
  });

  it("http-loopback is disabled and shows inline reason containing displayName when both loopback caps are false", () => {
    render(
      <TransportPicker
        ideTag="cursor"
        ideDisplayName="Cursor"
        capabilities={makeCaps({
          httpOAuthLoopback: false,
          httpBearerLoopback: false,
        })}
        selected="stdio-daemon-proxy"
        send={vi.fn()}
      />,
    );
    expect(getRadio("http-loopback").disabled).toBe(true);
    expect(
      screen.getByText(
        /No evidence yet that Cursor supports HTTP loopback MCP\./,
      ),
    ).toBeDefined();
  });

  it("http-tunnel is disabled and shows inline reason when httpOAuthTunnel is false", () => {
    render(
      <TransportPicker
        ideTag="cursor"
        ideDisplayName="Cursor"
        capabilities={makeCaps({ httpOAuthTunnel: false })}
        selected="stdio-daemon-proxy"
        send={vi.fn()}
      />,
    );
    expect(getRadio("http-tunnel").disabled).toBe(true);
    expect(
      screen.getByText(
        /No evidence yet that Cursor supports HTTP tunnel MCP\./,
      ),
    ).toBeDefined();
  });

  it("clicking a disabled option does not call send", () => {
    const send = vi.fn();
    render(
      <TransportPicker
        ideTag="cursor"
        ideDisplayName="Cursor"
        capabilities={makeCaps({ httpOAuthTunnel: false })}
        selected="stdio-daemon-proxy"
        send={send}
      />,
    );
    const tunnel = getRadio("http-tunnel");
    fireEvent.click(tunnel);
    expect(send).not.toHaveBeenCalled();
  });

  it("disabled prop disables all four options", () => {
    render(
      <TransportPicker
        ideTag="cursor"
        ideDisplayName="Cursor"
        capabilities={makeCaps()}
        selected="stdio-daemon-proxy"
        disabled={true}
        send={vi.fn()}
      />,
    );
    const disabledRadios = document.querySelectorAll<HTMLInputElement>(
      'input[type="radio"][disabled]',
    );
    expect(disabledRadios).toHaveLength(4);
  });

  it("only the selected option has the is-selected className", () => {
    render(
      <TransportPicker
        ideTag="cursor"
        ideDisplayName="Cursor"
        capabilities={makeCaps()}
        selected="http-loopback"
        send={vi.fn()}
      />,
    );
    const selectedLabels = document.querySelectorAll<HTMLLabelElement>(
      "label.transport-option.is-selected",
    );
    expect(selectedLabels).toHaveLength(1);
    const selectedRadio = selectedLabels[0].querySelector<HTMLInputElement>(
      'input[type="radio"]',
    );
    expect(selectedRadio?.value).toBe("http-loopback");
  });

  it("fieldset has accessible Transport label and renders a legend", () => {
    render(
      <TransportPicker
        ideTag="cursor"
        ideDisplayName="Cursor"
        capabilities={makeCaps()}
        selected="stdio-daemon-proxy"
        send={vi.fn()}
      />,
    );
    const fieldset = document.querySelector("fieldset.transport-picker");
    expect(fieldset).toBeDefined();
    expect(fieldset?.getAttribute("aria-label")).toBe("Transport");
    expect(screen.getByText("Transport")).toBeDefined();
  });
});
