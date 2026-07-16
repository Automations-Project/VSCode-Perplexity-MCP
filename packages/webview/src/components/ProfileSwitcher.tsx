import { useRef, useState } from "react";
import { ChevronDown, Plus, LogOut, RefreshCw, Trash2 } from "lucide-react";
import { useDashboardStore } from "../store";
import type { SendFn } from "../views";
import { StatusDot, type DotVariant } from "./StatusDot";
import { useDisclosureMenu } from "../lib/useDisclosureMenu";

export function ProfileSwitcher({ send }: { send: SendFn }) {
  const [open, setOpen] = useState(false);
  const auth = useDashboardStore((s) => s.authState);
  const profiles = useDashboardStore((s) => s.profiles);
  const active = useDashboardStore((s) => s.activeProfile);
  // Dashboard snapshot is authoritative after models refresh / daemon reinit;
  // authState can lag as "unknown" until a login runner runs.
  const snapshot = useDashboardStore((s) => s.state?.snapshot);
  const activeMeta = profiles.find((profile) => profile.name === active);
  const status = auth?.status ?? "unknown";
  // Prefer auth tier, then live snapshot tier, then profile meta. Never show
  // loginMode ("auto"/"manual") as the tier label — that looked like a broken
  // account chip.
  const tier = !active
    ? "Add account"
    : auth?.tier && auth.tier !== "Anonymous"
      ? auth.tier
      : snapshot?.tier && snapshot.tier !== "Anonymous"
        ? snapshot.tier
        : activeMeta?.tier && activeMeta.tier !== "Anonymous"
          ? activeMeta.tier
          : snapshot?.loggedIn
            ? "Authenticated"
            : "Anonymous";
  const label = active ?? "No profile";

  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const close = () => setOpen(false);

  useDisclosureMenu({ triggerRef, menuRef: containerRef, isOpen: open, onClose: close });

  // Green when auth is valid OR the dashboard already knows we have a live
  // session (models-cache / lastLogin / daemon). Yellow only when truly unknown
  // and not logged in — avoids "yellow while working" after refresh.
  const sessionLive =
    status === "valid" ||
    (!!snapshot?.loggedIn && status !== "expired" && status !== "error") ||
    (!!snapshot?.daemonAuth?.authenticated && status !== "expired" && status !== "error");
  const dotVariant: DotVariant =
    status === "expired" || status === "error"
      ? "err"
      : sessionLive
        ? "ok"
        : "warn";

  function switchTo(name: string) {
    send({ type: "profile:switch", id: crypto.randomUUID(), payload: { name } });
    setOpen(false);
  }
  function addProfile() {
    send({ type: "profile:add-prompt" });
    setOpen(false);
  }
  function logout() {
    if (!active) return;
    send({ type: "auth:logout", id: crypto.randomUUID(), payload: { profile: active, purge: false } });
    setOpen(false);
  }
  function relogin() {
    if (!active) return;
    send({ type: "auth:login" });
    setOpen(false);
  }
  function deleteActiveProfile() {
    if (!active) return;
    send({ type: "profile:delete", id: crypto.randomUUID(), payload: { name: active } });
    setOpen(false);
  }

  return (
    <div className="profile-switcher" ref={containerRef}>
      <button ref={triggerRef} className="profile-pill" onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="menu">
        <StatusDot variant={dotVariant} decorative />
        <span className="profile-pill-name">{label}</span>
        <span className="profile-pill-tier">{tier}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open && (
        <div className="profile-menu" role="menu">
          {profiles.length > 0 && <div className="profile-menu-group">Profiles</div>}
          {profiles.length === 0 && <div className="profile-menu-group">No profiles yet</div>}
          {profiles.length > 1 && (
            // Pre-click honesty. The host also shows a modal confirm (which is
            // the enforcement point and covers ExpiredBanner too) — this just
            // means the consequence isn't a surprise at the moment of clicking.
            <div className="profile-menu-hint" data-testid="profile-switch-scope-hint">
              Switching rebinds the shared daemon — all windows &amp; IDE clients follow.
            </div>
          )}
          {profiles.map((p) => (
            <button key={p.name} role="menuitem" className={`profile-menu-item ${p.name === active ? "is-active" : ""}`} onClick={() => switchTo(p.name)}>
              {p.displayName ?? p.name}
              {p.tier && p.tier !== "Anonymous" ? (
                <span className="profile-menu-item-tier">{p.tier}</span>
              ) : null}
            </button>
          ))}
          <hr />
          <button role="menuitem" className="profile-menu-item" onClick={addProfile}><Plus size={14} /> Add account…</button>
          {active ? <button role="menuitem" className="profile-menu-item" onClick={relogin}><RefreshCw size={14} /> Re-login</button> : null}
          {active ? <button role="menuitem" className="profile-menu-item profile-menu-item-danger" onClick={logout}><LogOut size={14} /> Logout</button> : null}
          {active ? <button role="menuitem" className="profile-menu-item profile-menu-item-danger" onClick={deleteActiveProfile}><Trash2 size={14} /> Delete profile…</button> : null}
        </div>
      )}
    </div>
  );
}
