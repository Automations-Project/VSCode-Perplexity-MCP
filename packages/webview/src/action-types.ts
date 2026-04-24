/**
 * Message types that `send()` in App.tsx treats as "actions" — auto-generates
 * an `id` for, registers in the pending-actions store slice, and correlates
 * back through the `action:result` ExtensionMessage.
 *
 * Extracted to its own module so the test suite can assert bearer copy /
 * reveal are present without bootstrapping the full App component tree.
 */
export const ACTION_TYPES: ReadonlySet<string> = new Set<string>([
  "auth:login",
  "configs:generate",
  "configs:remove",
  "rules:sync",
  "rules:remove",
  "models:refresh",
  "speed-boost:install",
  "speed-boost:uninstall",
  "doctor:run",
  "doctor:probe",
  "doctor:export",
  "doctor:report-issue",
  "doctor:action",
  "daemon:status",
  "daemon:rotate-token",
  "daemon:enable-tunnel",
  "daemon:disable-tunnel",
  // UX Pass #2 — these were previously untracked so clicks showed no
  // visual feedback during the extension-host round-trip. Each handler in
  // DashboardProvider.ts must emit `postActionResult(message.id, ok)` for
  // the pending-action slice to clear.
  "daemon:restart",
  "daemon:kill",
  "daemon:set-tunnel-provider",
  "daemon:set-ngrok-authtoken",
  "daemon:set-ngrok-domain",
  "daemon:clear-ngrok-settings",
  // H0 — bearer copy / reveal actions. Both MUST carry a generated id so
  // the extension-host handler can route the modal result back through
  // `action:result` / `daemon:bearer:reveal:response` without id=undefined.
  "daemon:bearer:copy",
  "daemon:bearer:reveal",
  // Phase 8.4 cf-named dashboard actions. Each must carry a generated id so
  // `daemon:cf-named-*:result` correlates with the pending-action slice.
  // Missing these here caused `id=undefined` breadcrumbs during the 8.4
  // dashboard smoke — the extension-host handlers emitted results with
  // `id: undefined` and the webview's pending-state never cleared.
  "daemon:install-cloudflared",
  "daemon:cf-named-login",
  "daemon:cf-named-create",
  "daemon:cf-named-list",
  "daemon:cf-named-unbind-local",
  "daemon:cf-named-delete-remote",
  "daemon:tunnel-probe",
  "history:request-entry",
  "history:open-preview",
  "history:open-rich",
  "history:open-with",
  "history:export",
  "history:pin",
  "history:tag",
  "history:delete",
  "history:rebuild-index",
  "history:cloud-sync",
  "history:cloud-hydrate",
  "viewers:configure",
  // Phase 8.5.2 — diagnostics bundle capture. Pending-action tracking gives
  // the dashboard button a spinner while the extension host runs the save
  // dialog + doctor probe + zip write round-trip.
  "diagnostics:capture",
  // v0.8.4 — TransportPicker per-IDE dropdown. Each select round-trips
  // through the extension host so `Perplexity.mcpTransportByIde` updates via
  // vscode.workspace.getConfiguration().update, then the fresh settings
  // snapshot comes back to the webview.
  "transport:select",
  // v0.8.4 — "Regenerate stale" button in the IDEs tab. Delegates to the
  // Perplexity.generateConfigs command so user-facing modals + staleness
  // recomputation land through a single path.
  "transport:regenerate-stale",
]);
