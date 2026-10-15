import { useEffect, useRef, useState, type ReactNode } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { Footer, ThemeSwitcher, useTheme } from "../lib/theme";
import { GeneratorModal } from "./PasswordGenerator";
import { EnvBadge } from "./ui";

interface Item { to: string; label: string; icon: string; perm?: string }

const SECTIONS: { title: string; items: Item[] }[] = [
  { title: "Overview", items: [{ to: "/", label: "Dashboard", icon: "◧", perm: "dashboard.view" }] },
  {
    title: "Infrastructure",
    items: [
      { to: "/credentials", label: "Password Management", icon: "🔐", perm: "credentials.view" },
      { to: "/servers", label: "Server Inventory", icon: "🖥", perm: "servers.view" },
      { to: "/versions", label: "Version Management", icon: "📦", perm: "versions.view" },
      { to: "/generator", label: "Password Generator", icon: "🔑" },
    ],
  },
  {
    title: "Administration",
    items: [
      { to: "/users", label: "User Management", icon: "👥", perm: "users.view" },
      { to: "/roles", label: "Roles & Permissions", icon: "🛡", perm: "users.view" },
      { to: "/audit", label: "Audit Logs", icon: "📋", perm: "audit.view" },
      { to: "/import", label: "Excel Import", icon: "⇪", perm: "import.run" },
      { to: "/settings", label: "Settings", icon: "⚙", perm: "settings.manage" },
    ],
  },
];

export function Layout() {
  const { me, can, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const [gen, setGen] = useState(false);
  const { config } = useTheme();
  const clicks = useRef<number[]>([]);
  const loc = useLocation();

  useEffect(() => setOpen(false), [loc.pathname]);

  // Keyboard shortcut: Ctrl/Cmd + Shift + G opens the generator
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "g") {
        e.preventDefault();
        setGen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Triple-click (within 600ms) on the key icon opens the generator
  const keyClick = () => {
    const now = Date.now();
    clicks.current = [...clicks.current.filter((t) => now - t < 600), now];
    if (clicks.current.length >= 3) {
      clicks.current = [];
      setGen(true);
    }
  };

  if (!me) return null;
  const initials = (me.full_name || me.username).split(/\s+/).map((s) => s[0]).join("").slice(0, 2).toUpperCase();

  return (
    <div className="app">
      <aside className={`sidebar ${open ? "open" : ""}`}>
        <div className="brand">
          <div className="brand-logo">T</div>
          <div><b>TAGID INFRA</b><span>Infrastructure Portal</span></div>
        </div>
        <nav className="nav">
          {SECTIONS.map((s) => {
            const items = s.items.filter((i) => !i.perm || can(i.perm));
            if (!items.length) return null;
            return (
              <div key={s.title}>
                <div className="nav-section">{s.title}</div>
                {items.map((i) => (
                  <NavLink key={i.to} to={i.to} end={i.to === "/"}>
                    <span className="ico">{i.icon}</span>{i.label}
                  </NavLink>
                ))}
              </div>
            );
          })}
        </nav>
        <div className="sidebar-foot">
          <NavLink to="/profile" className="userchip" style={{ textDecoration: "none" }}>
            <div className="avatar">{initials}</div>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis" }}>{me.full_name || me.username}</div>
              <div style={{ color: "#94a3b8", fontSize: 11 }}>{me.roles.join(", ") || "No role"}</div>
            </div>
          </NavLink>
          <button className="navbtn" style={{ color: "#94a3b8", background: "none", border: 0, cursor: "pointer", padding: "6px 8px", font: "inherit" }}
            onClick={() => logout()}>⎋ Sign out</button>
        </div>
      </aside>
      <main className="main">
        <div className="topbar">
          <button className="btn ghost menu-toggle" onClick={() => setOpen(!open)}>☰</button>
          {config.server_label && <span className="badge primary" title="This deployment">🖥 {config.server_label}</span>}
          <span className="muted small">Access:</span>
          {me.all_environments ? <span className="badge gray">All environments</span> : me.environments.map((e) => <EnvBadge key={e.id} env={e} />)}
          {!me.totp_enabled && <NavLink to="/profile" className="badge warn" title="Enable two-factor authentication">2FA off</NavLink>}
          <span className="spacer" />
          <button className="icon-btn" onClick={keyClick} title="Triple-click (or Ctrl+Shift+G) to open the password generator" style={{ fontSize: 18 }}>🔑</button>
          <button className="btn sm" onClick={() => setGen(true)}>Generate Password</button>
          <ThemeSwitcher />
        </div>
        <div className="content">
          <Outlet />
        </div>
        <Footer />
      </main>
      {gen && <GeneratorModal onClose={() => setGen(false)} />}
    </div>
  );
}

export function PageHead({ title, sub, children }: { title: string; sub?: ReactNode; children?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {sub && <p>{sub}</p>}
      </div>
      <span className="spacer" />
      {children}
    </div>
  );
}

export function Forbidden() {
  return <div className="card card-pad empty">🔒 You don't have permission to view this page.</div>;
}
