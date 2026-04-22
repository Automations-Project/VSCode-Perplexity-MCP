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
  // H0 — bearer copy / reveal actions. Both MUST carry a generated id so
  // the extension-host handler can route the modal result back through
  // `action:result` / `daemon:bearer:reveal:response` without id=undefined.
  "daemon:bearer:copy",
  "daemon:bearer:reveal",
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
]);
