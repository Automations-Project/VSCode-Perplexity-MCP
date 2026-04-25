// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import type { WebviewMessage } from "@perplexity-user-mcp/shared";
import { DoctorTab } from "../src/components/DoctorTab";
import { useDashboardStore } from "../src/store";
import { ACTION_TYPES } from "../src/action-types";

afterEach(() => {
  cleanup();
  useDashboardStore.setState({ pendingActions: new Set() });
});

describe("DoctorTab — Capture diagnostics button", () => {
  it("renders a 'Capture diagnostics' button in the Doctor tab header", () => {
    render(
      <DoctorTab
        report={null}
        phase="idle"
        reportingOptOut={false}
        send={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /capture diagnostics/i })).toBeDefined();
  });

  it("clicking the button calls send() with the diagnostics:capture message type", () => {
    const sent: WebviewMessage[] = [];
    const send = (msg: WebviewMessage) => {
      sent.push(msg);
    };
    render(
      <DoctorTab
        report={null}
        phase="idle"
        reportingOptOut={false}
        send={send as (m: WebviewMessage) => void}
      />,
    );
    const btn = screen.getByRole("button", { name: /capture diagnostics/i });
    fireEvent.click(btn);
    const captureMsgs = sent.filter((m) => m.type === "diagnostics:capture");
    expect(captureMsgs.length).toBe(1);
  });

  it("disables the button while a diagnostics:capture action is pending", () => {
    useDashboardStore.setState({
      pendingActions: new Set(["diagnostics:capture-1-abc"]),
    });
    render(
      <DoctorTab
        report={null}
        phase="idle"
        reportingOptOut={false}
        send={vi.fn()}
      />,
    );
    const btn = screen.getByRole("button", { name: /capturing/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute("aria-busy")).toBe("true");
  });

  it("disables the button while doctor phase is running so actions don't interleave", () => {
    render(
      <DoctorTab
        report={null}
        phase="running"
        reportingOptOut={false}
        send={vi.fn()}
      />,
    );
    const btn = screen.getByRole("button", { name: /capture diagnostics/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("action type is registered in ACTION_TYPES so App.tsx auto-generates a correlation id", () => {
    expect(ACTION_TYPES.has("diagnostics:capture")).toBe(true);
  });
});
