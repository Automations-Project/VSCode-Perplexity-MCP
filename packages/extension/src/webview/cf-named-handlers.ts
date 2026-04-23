/**
 * Pure handler functions for the cf-named dashboard messages (Phase 8.4.3).
 *
 * The dispatch arms in DashboardProvider.ts delegate here so unit tests can
 * exercise the modal-confirm + runtime-helper wiring without standing up a
 * full VS Code webview host. All VS Code / runtime dependencies arrive via
 * `deps` — tests inject fakes; production passes real `vscode.window` etc.
 *
 * Contract (matches docs/superpowers/plans/2026-04-22-phase-8-completeness.md §8.4.3):
 *   - Login + Create: modal-confirm first; "Cancel" short-circuits with
 *     { ok: false, error: "cancelled" } and the runtime helper is NOT called.
 *   - List: read-only; no modal; runtime helper always called.
 *   - Errors: truncate to ~200 chars and post as { ok: false, error }.
 */

import type { ExtensionMessage, WebviewMessage } from "@perplexity-user-mcp/shared";

export interface CfNamedDeps {
  /** Runtime wrappers — thin facades over perplexity-user-mcp/daemon/tunnel-providers. */
  runCfNamedLogin: () => Promise<{ ok: boolean; certPath: string; stderr?: string }>;
  createCfNamedTunnel: (params: {
    mode: "create" | "bind-existing";
    name?: string;
    hostname: string;
    uuid?: string;
  }) => Promise<{ uuid: string; name?: string; credentialsPath?: string } | { uuid: string; hostname: string; configPath: string }>;
  listCfNamedTunnels: () => Promise<Array<{ uuid: string; name: string; connections?: number }>>;
  readCfNamedConfig: () => Promise<{ uuid: string; configPath: string; hostname: string } | null>;
  clearCfNamedConfig: () => Promise<boolean> | boolean;
  deleteCfNamedTunnel: (uuid: string) => Promise<{ uuid: string }>;
  disableActiveTunnelIfNeeded: () => Promise<void>;
  /**
   * vscode.window.showWarningMessage shim. Returns the clicked-button label
   * OR undefined when the user cancelled / dismissed the modal. The modal's
   * "Cancel" button in VS Code always resolves to undefined, so tests model
   * that with a vi.fn(() => Promise.resolve(undefined)).
   */
  showWarningMessage: (
    message: string,
    options: { modal?: boolean; detail?: string },
    ...items: string[]
  ) => Promise<string | undefined>;
  post: (message: ExtensionMessage) => void | Promise<void>;
  /**
   * Optional debug trace sink. Production wires this to the extension's
   * `debug()` output channel so each step of the cf-named flow is visible in
   * the Perplexity Internal MCP log — critical for diagnosing why a login
   * call stalls (pre-modal vs mid-modal vs mid-spawn). Tests omit this.
   */
  log?: (message: string) => void;
}

const ERROR_MAX = 200;

function truncate(value: string, max: number = ERROR_MAX): string {
  if (!value) return value;
  if (value.length <= max) return value;
  return value.slice(0, max - 1) + "…";
}

function errorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return truncate(msg || "unknown error");
}

/**
 * daemon:cf-named-login → modal-confirm → spawn `cloudflared tunnel login`.
 * Posts `daemon:cf-named-login:result` back in all branches (cancel, ok,
 * error) so the webview can clear its pending state deterministically.
 */
export async function handleCfNamedLogin(
  id: string,
  deps: CfNamedDeps,
): Promise<"cancelled" | "ok" | "error"> {
  deps.log?.(`cf-named-login id=${id}: before modal`);
  const confirm = await deps.showWarningMessage(
    "Run cloudflared login?",
    {
      modal: true,
      detail:
        "This opens your default browser and asks you to authorize Cloudflare access to one of your zones. A cert file will be written to ~/.cloudflared/cert.pem on success. Continue?",
    },
    "Continue",
  );
  deps.log?.(`cf-named-login id=${id}: modal result=${confirm === "Continue" ? "Continue" : "cancelled-or-dismissed"}`);
  if (confirm !== "Continue") {
    await deps.post({
      type: "daemon:cf-named-login:result",
      id,
      payload: { ok: false, error: "cancelled" },
    });
    return "cancelled";
  }
  try {
    deps.log?.(`cf-named-login id=${id}: calling runCfNamedLogin`);
    const result = await deps.runCfNamedLogin();
    deps.log?.(`cf-named-login id=${id}: runCfNamedLogin ok certPath=${result.certPath}`);
    await deps.post({
      type: "daemon:cf-named-login:result",
      id,
      payload: { ok: true, certPath: result.certPath },
    });
    return "ok";
  } catch (err) {
    deps.log?.(`cf-named-login id=${id}: runCfNamedLogin error=${errorMessage(err)}`);
    await deps.post({
      type: "daemon:cf-named-login:result",
      id,
      payload: { ok: false, error: errorMessage(err) },
    });
    return "error";
  }
}

/**
 * daemon:cf-named-create → modal-confirm (copy varies by mode) → either
 * `cloudflared tunnel create` + DNS route (create) OR `writeTunnelConfig`
 * with the user-provided UUID (bind-existing). Reads the post-write config
 * back to canonicalize the result payload.
 */
export async function handleCfNamedCreate(
  id: string,
  payload: Extract<WebviewMessage, { type: "daemon:cf-named-create" }>["payload"],
  deps: CfNamedDeps,
): Promise<"cancelled" | "ok" | "error"> {
  const detail =
    payload.mode === "create"
      ? `This creates a Cloudflare tunnel named "${payload.name}" and routes DNS ${payload.hostname} to it. Continue?`
      : `This binds the managed config to the existing tunnel UUID ${payload.uuid} and routes ${payload.hostname} to it locally. Continue?`;
  const confirmLabel = payload.mode === "create" ? "Create tunnel" : "Bind tunnel";
  const confirm = await deps.showWarningMessage(
    payload.mode === "create"
      ? "Create a new Cloudflare named tunnel?"
      : "Bind existing Cloudflare named tunnel?",
    { modal: true, detail },
    confirmLabel,
  );
  if (confirm !== confirmLabel) {
    await deps.post({
      type: "daemon:cf-named-create:result",
      id,
      payload: { ok: false, error: "cancelled" },
    });
    return "cancelled";
  }
  try {
    const created = await deps.createCfNamedTunnel(
      payload.mode === "create"
        ? { mode: "create", name: payload.name, hostname: payload.hostname }
        : { mode: "bind-existing", uuid: payload.uuid, hostname: payload.hostname },
    );
    const config = await deps.readCfNamedConfig();
    const uuid = "uuid" in created ? created.uuid : config?.uuid ?? "";
    const configPath = config?.configPath ?? "";
    await deps.post({
      type: "daemon:cf-named-create:result",
      id,
      payload: { ok: true, hostname: payload.hostname, uuid, configPath },
    });
    return "ok";
  } catch (err) {
    await deps.post({
      type: "daemon:cf-named-create:result",
      id,
      payload: { ok: false, error: errorMessage(err) },
    });
    return "error";
  }
}

/**
 * daemon:cf-named-list → `cloudflared tunnel list`. Read-only, no modal.
 */
export async function handleCfNamedList(
  id: string,
  deps: CfNamedDeps,
): Promise<"ok" | "error"> {
  try {
    const tunnels = await deps.listCfNamedTunnels();
    await deps.post({
      type: "daemon:cf-named-list:result",
      id,
      payload: {
        ok: true,
        tunnels: tunnels.map((t) => ({
          uuid: t.uuid,
          name: t.name,
          ...(typeof t.connections === "number" ? { connections: t.connections } : {}),
        })),
      },
    });
    return "ok";
  } catch (err) {
    await deps.post({
      type: "daemon:cf-named-list:result",
      id,
      payload: { ok: false, error: errorMessage(err) },
    });
    return "error";
  }
}

export async function handleCfNamedUnbindLocal(
  id: string,
  payload: Extract<WebviewMessage, { type: "daemon:cf-named-unbind-local" }>["payload"],
  deps: CfNamedDeps,
): Promise<"cancelled" | "ok" | "error"> {
  const confirm = await deps.showWarningMessage(
    "Unbind local Cloudflare named tunnel config?",
    {
      modal: true,
      detail:
        `This removes only the local managed config for tunnel UUID ${payload.uuid}. The remote Cloudflare tunnel and DNS records are left untouched. Continue?`,
    },
    "Unbind local config",
  );
  if (confirm !== "Unbind local config") {
    await deps.post({
      type: "daemon:cf-named-unbind-local:result",
      id,
      payload: { ok: false, error: "cancelled" },
    });
    return "cancelled";
  }
  try {
    await deps.disableActiveTunnelIfNeeded();
    const configCleared = await deps.clearCfNamedConfig();
    await deps.post({
      type: "daemon:cf-named-unbind-local:result",
      id,
      payload: { ok: true, uuid: payload.uuid, configCleared },
    });
    return "ok";
  } catch (err) {
    await deps.post({
      type: "daemon:cf-named-unbind-local:result",
      id,
      payload: { ok: false, error: errorMessage(err) },
    });
    return "error";
  }
}

export async function handleCfNamedDeleteRemote(
  id: string,
  payload: Extract<WebviewMessage, { type: "daemon:cf-named-delete-remote" }>["payload"],
  deps: CfNamedDeps,
): Promise<"cancelled" | "ok" | "error"> {
  const confirm = await deps.showWarningMessage(
    "Delete remote Cloudflare named tunnel?",
    {
      modal: true,
      detail:
        `This deletes the remote Cloudflare tunnel "${payload.name}" (${payload.uuid}). The tunnel will stay disabled even if deletion fails. You may still need to remove the DNS CNAME for ${payload.hostname ?? "the hostname"} afterwards.`,
    },
    "Delete remote tunnel",
  );
  if (confirm !== "Delete remote tunnel") {
    await deps.post({
      type: "daemon:cf-named-delete-remote:result",
      id,
      payload: { ok: false, error: "cancelled", reason: "unknown" },
    });
    return "cancelled";
  }
  try {
    await deps.disableActiveTunnelIfNeeded();
    const before = await deps.readCfNamedConfig();
    await deps.deleteCfNamedTunnel(payload.uuid);
    const localConfigCleared = before?.uuid === payload.uuid ? await deps.clearCfNamedConfig() : false;
    await deps.post({
      type: "daemon:cf-named-delete-remote:result",
      id,
      payload: {
        ok: true,
        uuid: payload.uuid,
        ...(payload.hostname ? { hostname: payload.hostname } : {}),
        localConfigCleared,
        dnsCleanupUrl: "https://dash.cloudflare.com/?to=/:account/:zone/dns",
      },
    });
    return "ok";
  } catch (err) {
    const reason = typeof err === "object" && err !== null && "reason" in err
      ? (err as { reason?: "active-connections" | "unknown" }).reason
      : undefined;
    await deps.post({
      type: "daemon:cf-named-delete-remote:result",
      id,
      payload: {
        ok: false,
        error: errorMessage(err),
        reason: reason === "active-connections" ? "active-connections" : "unknown",
      },
    });
    return "error";
  }
}
