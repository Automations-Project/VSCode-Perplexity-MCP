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
  const activeMeta = profiles.find((profile) => profile.name === active);
  const status = auth?.status ?? "unknown";
  const tier = active ? auth?.tier ?? activeMeta?.tier ?? activeMeta?.loginMode ?? "Anonymous" : "Add account";
  const label = active ?? "No profile";

  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const close = () => setOpen(false);

  useDisclosureMenu({ triggerRef, menuRef: containerRef, isOpen: open, onClose: close });

  const dotVariant: DotVariant =
    status === "valid" ? "ok" : status === "expired" || status === "error" ? "err" : "warn";

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
          {profiles.map((p) => (
            <button key={p.name} role="menuitem" className={`profile-menu-item ${p.name === active ? "is-active" : ""}`} onClick={() => switchTo(p.name)}>
              {p.displayName ?? p.name} <span className="profile-menu-item-tier">{p.tier ?? p.loginMode}</span>
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
