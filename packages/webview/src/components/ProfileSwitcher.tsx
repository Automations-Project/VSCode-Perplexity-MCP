import { useState } from "react";
import { ChevronDown, Plus, LogOut, RefreshCw } from "lucide-react";
import { useDashboardStore } from "../store";
import type { SendFn } from "../views";
import { StatusDot, type DotVariant } from "./StatusDot";

export function ProfileSwitcher({ send }: { send: SendFn }) {
  const [open, setOpen] = useState(false);
  const auth = useDashboardStore((s) => s.authState);
  const profiles = useDashboardStore((s) => s.profiles);
  const active = useDashboardStore((s) => s.activeProfile);
  const status = auth?.status ?? "unknown";
  const tier = auth?.tier ?? "Anonymous";
  const label = active ?? "default";

  const dotVariant: DotVariant =
    status === "valid" ? "ok" : status === "expired" || status === "error" ? "err" : "warn";

  function switchTo(name: string) {
    send({ type: "profile:switch", id: crypto.randomUUID(), payload: { name } });
    setOpen(false);
  }
  function addProfile() {
    const name = prompt("New profile name (a-z 0-9 _ -, max 32 chars):");
    if (!name) return;
    send({ type: "profile:add", id: crypto.randomUUID(), payload: { name, loginMode: "manual" } });
    setOpen(false);
  }
  function logout() {
    if (!active) return;
    send({ type: "auth:logout", id: crypto.randomUUID(), payload: { profile: active, purge: false } });
    setOpen(false);
  }
  function relogin() {
    if (!active) return;
    send({ type: "auth:login-start", id: crypto.randomUUID(), payload: { profile: active, mode: "manual" } });
    setOpen(false);
  }

  return (
    <div className="profile-switcher">
      <button className="profile-pill" onClick={() => setOpen(!open)} aria-expanded={open}>
        <StatusDot variant={dotVariant} />
        <span className="profile-pill-name">{label}</span>
        <span className="profile-pill-tier">{tier}</span>
        <ChevronDown size={14} />
      </button>
      {open && (
        <div className="profile-menu" role="menu">
          {profiles.length > 0 && <div className="profile-menu-group">Profiles</div>}
          {profiles.map((p) => (
            <button key={p.name} className={`profile-menu-item ${p.name === active ? "is-active" : ""}`} onClick={() => switchTo(p.name)}>
              {p.displayName ?? p.name} <span className="profile-menu-item-tier">{p.tier ?? "?"}</span>
            </button>
          ))}
          <hr />
          <button className="profile-menu-item" onClick={relogin}><RefreshCw size={14} /> Re-login</button>
          <button className="profile-menu-item" onClick={addProfile}><Plus size={14} /> Add account…</button>
          <button className="profile-menu-item profile-menu-item-danger" onClick={logout}><LogOut size={14} /> Logout</button>
        </div>
      )}
    </div>
  );
}
