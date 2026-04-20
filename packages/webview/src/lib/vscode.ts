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
  getVsCodeApi().postMessage(message);
}
