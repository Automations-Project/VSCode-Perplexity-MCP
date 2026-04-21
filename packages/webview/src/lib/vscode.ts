import type { DashboardState, WebviewMessage } from "@perplexity-user-mcp/shared";

declare global {
  interface Window {
    __PERPLEXITY_INITIAL_STATE__?: DashboardState;
    acquireVsCodeApi?: () => {
      postMessage(message: unknown): void;
      getState<T>(): T | undefined;
      setState(state: unknown): void;
    };
  }
}

const fallbackApi = {
  postMessage(message: unknown) {
    console.info("VS Code API unavailable, dropping message:", message);
  },
  getState<T>() {
    return undefined as T | undefined;
  },
  setState(_state: unknown) {}
};

const cachedApi = window.acquireVsCodeApi?.() ?? fallbackApi;

export function getVsCodeApi() {
  return cachedApi;
}

export function postMessage(message: WebviewMessage): void {
  try {
    if (message.type !== "log:webview") {
      const payload: WebviewMessage = {
        type: "log:webview",
        payload: {
          level: "log",
          args: ["[trace] postMessage", { type: message.type, ...("id" in message ? { id: (message as { id?: unknown }).id } : {}) }],
          ts: new Date().toISOString(),
        },
      };
      getVsCodeApi().postMessage(payload);
    }
  } catch {
    // best-effort
  }
  getVsCodeApi().postMessage(message);
}

let consoleHooked = false;
export function installWebviewConsoleForwarder(): void {
  if (consoleHooked) return;
  consoleHooked = true;
  const levels: Array<"log" | "warn" | "error" | "info" | "debug"> = ["log", "warn", "error", "info", "debug"];
  for (const level of levels) {
    const original = console[level].bind(console);
    (console as unknown as Record<string, (...args: unknown[]) => void>)[level] = (...args: unknown[]) => {
      original(...args);
      try {
        const safeArgs = args.map((a) => {
          if (a instanceof Error) return { name: a.name, message: a.message, stack: a.stack };
          if (typeof a === "object" && a !== null) {
            try { JSON.stringify(a); return a; } catch { return String(a); }
          }
          return a;
        });
        getVsCodeApi().postMessage({
          type: "log:webview",
          payload: { level, args: safeArgs, ts: new Date().toISOString() },
        } satisfies WebviewMessage);
      } catch {
        // best-effort
      }
    };
  }
  window.addEventListener("error", (event) => {
    try {
      getVsCodeApi().postMessage({
        type: "log:webview",
        payload: {
          level: "error",
          args: ["[trace] window.onerror", { message: event.message, filename: event.filename, lineno: event.lineno, colno: event.colno, stack: (event.error as Error | undefined)?.stack }],
          ts: new Date().toISOString(),
        },
      } satisfies WebviewMessage);
    } catch {
      // best-effort
    }
  });
  window.addEventListener("unhandledrejection", (event) => {
    try {
      const reason = event.reason;
      getVsCodeApi().postMessage({
        type: "log:webview",
        payload: {
          level: "error",
          args: ["[trace] unhandledrejection", reason instanceof Error ? { name: reason.name, message: reason.message, stack: reason.stack } : reason],
          ts: new Date().toISOString(),
        },
      } satisfies WebviewMessage);
    } catch {
      // best-effort
    }
  });
}
