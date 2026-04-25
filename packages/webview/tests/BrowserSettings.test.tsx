// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import type { AuthState, BrowserInfo, WebviewMessage } from "@perplexity-user-mcp/shared";
import { BrowserSettings } from "../src/components/BrowserSettings";

afterEach(() => {
  cleanup();
});

/**
 * Minimal AuthState factory. Most tests only need `browser` + `availableBrowsers`,
 * everything else is stubbed with sensible defaults.
 */
function makeAuth(overrides: Partial<AuthState> = {}): AuthState {
  return {
    profile: "default",
    status: "unknown",
    ...overrides,
  };
}

const chromeProbe: BrowserInfo = {
  found: true,
  channel: "chrome",
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  label: "Google Chrome",
};
const edgeProbe: BrowserInfo = {
  found: true,
  channel: "msedge",
  executablePath: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  label: "Microsoft Edge",
};

describe("BrowserSettings", () => {
  it("renders the empty-state warning when no browsers are detected", () => {
    const send = vi.fn();
    render(<BrowserSettings auth={makeAuth({ availableBrowsers: [] })} send={send} />);

    expect(screen.getByTestId("browser-active-chip").textContent).toContain("No browser detected");
    expect(screen.getByTestId("browser-empty")).toBeTruthy();
    // Bundled-Chromium install button stays available so the user can recover
    // when no system browser is installed.
    expect(screen.getByTestId("bundled-install")).toBeTruthy();
  });

  it("lists every detected browser as a radio option", () => {
    const send = vi.fn();
    render(
      <BrowserSettings
        auth={makeAuth({
          browser: chromeProbe,
          availableBrowsers: [chromeProbe, edgeProbe],
        })}
        send={send}
      />,
    );

    expect(screen.getByTestId("browser-option-chrome")).toBeTruthy();
    expect(screen.getByTestId("browser-option-msedge")).toBeTruthy();
    // Active chip reflects the currently-selected browser.
    expect(screen.getByTestId("browser-active-chip").textContent).toContain("Google Chrome");
  });

  it("emits browser:select with channel + path when a radio option is clicked", () => {
    const send = vi.fn();
    render(
      <BrowserSettings
        auth={makeAuth({
          browser: chromeProbe,
          availableBrowsers: [chromeProbe, edgeProbe],
        })}
        send={send}
      />,
    );

    const edgeOption = screen.getByTestId("browser-option-msedge").querySelector("input[type='radio']")!;
    fireEvent.click(edgeOption);

    expect(send).toHaveBeenCalledWith({
      type: "browser:select",
      payload: {
        mode: "auto",
        channel: "msedge",
        executablePath: edgeProbe.executablePath,
        label: edgeProbe.label,
      },
    });
  });

  it("surfaces a custom-path chip when browserChoice.mode === 'custom'", () => {
    const send = vi.fn();
    render(
      <BrowserSettings
        auth={makeAuth({
          browser: { found: true, channel: "chromium", executablePath: "/usr/local/bin/custom", label: "MyBrowser" },
          availableBrowsers: [chromeProbe],
          browserChoice: { mode: "custom", channel: "chromium", executablePath: "/usr/local/bin/custom", label: "MyBrowser" },
        })}
        send={send}
      />,
    );

    expect(screen.getByTestId("browser-custom-row")).toBeTruthy();

    fireEvent.click(screen.getByTestId("browser-clear-custom"));
    expect(send).toHaveBeenCalledWith({
      type: "browser:select",
      payload: { mode: "auto" },
    });
  });

  it("shows the installed bundled-Chromium row + remove button when bundled exists", () => {
    const send = vi.fn();
    const bundledProbe: BrowserInfo = {
      found: true,
      channel: "chromium",
      executablePath: "/home/user/.vscode/globalStorage/.../chrome",
      label: "Bundled Chromium",
      downloaded: true,
    };
    render(
      <BrowserSettings
        auth={makeAuth({
          browser: chromeProbe,
          availableBrowsers: [chromeProbe, bundledProbe],
        })}
        send={send}
      />,
    );

    expect(screen.getByTestId("bundled-installed")).toBeTruthy();
    expect(screen.queryByTestId("bundled-install")).toBeNull();
    expect(screen.getByTestId("bundled-remove")).toBeTruthy();
  });

  it("fires browser:refresh-detection when the Refresh button is clicked", () => {
    const send = vi.fn();
    render(<BrowserSettings auth={makeAuth({ availableBrowsers: [chromeProbe] })} send={send} />);

    fireEvent.click(screen.getByTestId("browser-refresh"));
    const call = send.mock.calls.find((c) => (c[0] as WebviewMessage).type === "browser:refresh-detection");
    expect(call).toBeTruthy();
  });

  it("fires browser:pick-custom when the Browse button is clicked", () => {
    const send = vi.fn();
    render(<BrowserSettings auth={makeAuth({ availableBrowsers: [chromeProbe] })} send={send} />);

    fireEvent.click(screen.getByTestId("browser-pick-custom"));
    const call = send.mock.calls.find((c) => (c[0] as WebviewMessage).type === "browser:pick-custom");
    expect(call).toBeTruthy();
  });
});
