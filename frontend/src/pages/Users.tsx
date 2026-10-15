import { useMemo, useState, type FormEvent } from "react";
import { PageHead } from "../components/Layout";
import { GeneratorModal, StrengthMeter } from "../components/PasswordGenerator";
import { Empty, EnvBadge, Field, Modal, fmtDate, timeAgo, useUi } from "../components/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useLoad, useLookups } from "../lib/hooks";
import type { Override, Permission, Role, SessionInfo, User } from "../lib/types";

export const MODULE_LABELS: Record<string, string> = {
  dashboard: "Dashboard", credentials: "Password Management", servers: "Server Inventory", versions: "Version Management",
  users: "User Management", roles: "Roles", audit: "Audit Logs", settings: "Settings", import: "Excel Import",
};
export const ACTIONS = ["view", "view_password", "create", "update", "delete", "export", "manage", "run"];
export const ACTION_LABELS: Record<string, string> = {
  view: "View", view_password: "View Password", create: "Add", update: "Edit", delete: "Delete", export: "Export", manage: "Manage", run: "Run",
};

export function groupPerms(perms: Permission[]) {
  const modules: string[] = [];
  const byKey = new Map<string, Permission>();
  for (const p of perms) {
    if (!modules.includes(p.module)) modules.push(p.module);
    byKey.set(`${p.module}.${p.action}`, p);
  }
  const actions = ACTIONS.filter((a) => perms.some((p) => p.action === a));
  return { modules, actions, byKey };
}

export function Users() {
  const { can, me } = useAuth();
  const { toast, confirm } = useUi();
  const lk = useLookups();
  const [tab, setTab] = useState<"users" | "sessions">("users");
  const { data: users, reload } = useLoad(() => api.get<User[]>("/users"));
  const [editing, setEditing] = useState<User | "new" | null>(null);
  const [resetting, setResetting] = useState<User | null>(null);

  const act = async (u: User, what: "unlock" | "reset-mfa" | "delete") => {
    const msgs = { unlock: `Unlock ${u.username}?`, "reset-mfa": `Reset 2FA for ${u.username}?`, delete: `Delete user ${u.username}?` };
    if (!(await confirm(msgs[what], what === "delete" ? <p>Their audit history is kept.</p> : undefined, what !== "unlock"))) return;
    try {
      if (what === "delete") await api.del(`/users/${u.id}`);
      else await api.post(`/users/${u.id}/${what}`);
      toast("Done");
      reload();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  return (
    <>
      <PageHead title="User Management" sub="Logins, roles, custom permissions and environment access">
        {can("users.create") && tab === "users" && <button className="btn primary" onClick={() => setEditing("new")}>+ Add User</button>}
      </PageHead>
      <div className="tabs">
        <button className={tab === "users" ? "active" : ""} onClick={() => setTab("users")}>Users</button>
        <button className={tab === "sessions" ? "active" : ""} onClick={() => setTab("sessions")}>Active sessions</button>
      </div>
      {tab === "sessions" ? <Sessions /> : (
        <div className="card">
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>User</th><th>Roles</th><th>Environments</th><th>Custom</th><th>2FA</th><th>Status</th><th>Last login</th><th /></tr></thead>
              <tbody>
                {users?.map((u) => (
                  <tr key={u.id}>
                    <td><b>{u.full_name || u.username}</b><div className="small muted">{u.username}{u.email ? ` · ${u.email}` : ""}</div></td>
                    <td>{u.roles.map((r) => <span key={r.id} className="badge primary" style={{ marginRight: 4 }}>{r.name}</span>)}{!u.roles.length && <span className="muted small">none</span>}</td>
                    <td>{u.all_environments ? <span className="badge gray">All</span> : <span className="row wrap" style={{ gap: 4 }}>{lk.environments.filter((e) => u.environment_ids.includes(e.id)).map((e) => <EnvBadge key={e.id} env={e} />)}</span>}</td>
                    <td className="small">
                      {u.overrides.map((o) => <span key={o.code} className={`badge ${o.granted ? "ok" : "danger"}`} style={{ marginRight: 4 }}>{o.granted ? "+" : "−"}{o.code}</span>)}
                    </td>
                    <td>{u.totp_enabled ? <span className="badge ok">On</span> : <span className="badge gray">Off</span>}</td>
                    <td>
                      {!u.is_active ? <span className="badge danger">Disabled</span> : u.locked ? <span className="badge warn">Locked</span> : <span className="badge ok">Active</span>}
                      {u.must_change_password && <div className="small muted">must change pw</div>}
                    </td>
                    <td className="small" title={u.last_login_ip || ""}>{timeAgo(u.last_login_at)}</td>
                    <td className="right nowrap">
                      {can("users.update") && <>
                        <button className="icon-btn" title="Edit access" onClick={() => setEditing(u)}>✎</button>
                        <button className="icon-btn" title="Reset password" onClick={() => setResetting(u)}>🔑</button>
                        {u.locked && <button className="icon-btn" title="Unlock" onClick={() => act(u, "unlock")}>🔓</button>}
                        {u.totp_enabled && <button className="icon-btn" title="Reset 2FA" onClick={() => act(u, "reset-mfa")}>📵</button>}
                      </>}
                      {can("users.delete") && u.id !== me?.id && <button className="icon-btn" title="Delete" onClick={() => act(u, "delete")}>🗑</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {editing && <UserForm initial={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />}
      {resetting && <ResetPassword user={resetting} onClose={() => setResetting(null)} />}
    </>
  );
}

function Sessions() {
  const { can } = useAuth();
  const { toast } = useUi();
  const { data, reload } = useLoad(() => api.get<SessionInfo[]>("/sessions"));
  const revoke = (s: SessionInfo) => api.del(`/sessions/${s.id}`).then(() => (toast("Session revoked"), reload())).catch((e) => toast(e.message, true));
  return (
    <div className="card table-wrap">
      <table className="tbl">
        <thead><tr><th>User</th><th>IP</th><th>Browser</th><th>Signed in</th><th>Last active</th><th>Expires</th><th /></tr></thead>
        <tbody>
          {data?.map((s) => (
            <tr key={s.id}>
              <td><b>{s.username}</b> {s.current && <span className="badge primary">this session</span>}</td>
              <td className="mono">{s.ip_address}</td>
              <td className="small muted" style={{ maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={s.user_agent || ""}>{s.user_agent}</td>
              <td className="small">{fmtDate(s.created_at, true)}</td>
              <td className="small">{timeAgo(s.last_seen_at)}</td>
              <td className="small">{fmtDate(s.expires_at, true)}</td>
              <td className="right">{can("users.update") && !s.current && <button className="btn sm danger" onClick={() => revoke(s)}>Revoke</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {data && !data.length && <Empty>No active sessions.</Empty>}
    </div>
  );
}

function ResetPassword({ user, onClose }: { user: User; onClose: () => void }) {
  const { toast } = useUi();
  const [pw, setPw] = useState("");
  const [force, setForce] = useState(true);
  const [gen, setGen] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.post(`/users/${user.id}/reset-password`, { new_password: pw, must_change_password: force });
      toast("Password reset — share it with the user over a secure channel");
      onClose();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  return (
    <Modal title={`Reset password — ${user.username}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" form="rp">Reset</button></>}>
      <form id="rp" className="grid" style={{ gap: 12 }} onSubmit={submit}>
        <Field label="New password" required>
          <div className="input-group"><input className="mono" required value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" /><button type="button" className="btn" onClick={() => setGen(true)}>🔑 Generate</button></div>
          <StrengthMeter value={pw} />
        </Field>
        <label className="check"><input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} /> Require change at next login</label>
        <p className="small muted" style={{ margin: 0 }}>All of this user's sessions will be signed out.</p>
      </form>
      {gen && <GeneratorModal onClose={() => setGen(false)} onUse={setPw} />}
    </Modal>
  );
}

function UserForm({ initial, onClose, onSaved }: { initial: User | null; onClose: () => void; onSaved: () => void }) {
  const { toast } = useUi();
  const lk = useLookups();
  const { data: roles } = useLoad(() => api.get<Role[]>("/roles"));
  const { data: perms } = useLoad(() => api.get<Permission[]>("/permissions"));
  const [gen, setGen] = useState(false);
  const [f, setF] = useState({
    username: initial?.username || "", email: initial?.email || "", full_name: initial?.full_name || "", password: "",
    is_active: initial?.is_active ?? true, must_change_password: true, role_ids: initial?.role_ids || [],
    overrides: initial?.overrides || ([] as Override[]), all_environments: initial?.all_environments ?? true,
    environment_ids: initial?.environment_ids || ([] as number[]),
  });

  const fromRoles = useMemo(() => new Set((roles || []).filter((r) => f.role_ids.includes(r.id)).flatMap((r) => r.permissions)), [roles, f.role_ids]);
  const effective = (code: string) => {
    const o = f.overrides.find((x) => x.code === code);
    return o ? o.granted : fromRoles.has(code);
  };
  const cycle = (code: string) => {
    // inherit → allow → deny → inherit
    const o = f.overrides.find((x) => x.code === code);
    const rest = f.overrides.filter((x) => x.code !== code);
    const next = !o ? [...rest, { code, granted: true }] : o.granted ? [...rest, { code, granted: false }] : rest;
    setF({ ...f, overrides: next });
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      if (initial) await api.put(`/users/${initial.id}`, { ...f, password: undefined, username: undefined });
      else await api.post("/users", f);
      toast(initial ? "User updated" : "User created");
      onSaved();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  const g = perms ? groupPerms(perms) : null;

  return (
    <Modal wide title={initial ? `Edit ${initial.username}` : "Add user"} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" form="uf">Save</button></>}>
      <form id="uf" className="form-grid" onSubmit={submit} autoComplete="off">
        <Field label="Full name"><input value={f.full_name} onChange={(e) => setF({ ...f, full_name: e.target.value })} /></Field>
        <Field label="Email"><input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <Field label="Username" required><input required disabled={!!initial} value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} pattern="[a-zA-Z0-9._\-]+" autoComplete="off" /></Field>
        {!initial ? (
          <Field label="Initial password" required>
            <div className="input-group"><input className="mono" required value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="new-password" /><button type="button" className="btn" onClick={() => setGen(true)}>🔑</button></div>
            <StrengthMeter value={f.password} />
          </Field>
        ) : <div />}
        <div className="full row wrap" style={{ gap: 20 }}>
          <label className="check"><input type="checkbox" checked={f.is_active} onChange={(e) => setF({ ...f, is_active: e.target.checked })} /> Account active</label>
          {!initial && <label className="check"><input type="checkbox" checked={f.must_change_password} onChange={(e) => setF({ ...f, must_change_password: e.target.checked })} /> Must change password on first login</label>}
        </div>

        <div className="form-section">Roles</div>
        <div className="full grid grid-3" style={{ gap: 8 }}>
          {roles?.map((r) => (
            <label key={r.id} className="check card" style={{ padding: "8px 12px", alignItems: "flex-start" }}>
              <input type="checkbox" checked={f.role_ids.includes(r.id)} style={{ marginTop: 3 }}
                onChange={(e) => setF({ ...f, role_ids: e.target.checked ? [...f.role_ids, r.id] : f.role_ids.filter((x) => x !== r.id) })} />
              <span><b>{r.name}</b><div className="small muted">{r.description}</div></span>
            </label>
          ))}
        </div>

        <div className="form-section">Environment access — what this user can see</div>
        <div className="full grid" style={{ gap: 8 }}>
          <div className="row wrap" style={{ gap: 18 }}>
            <label className="check"><input type="radio" checked={f.all_environments} onChange={() => setF({ ...f, all_environments: true })} /> All environments</label>
            <label className="check"><input type="radio" checked={!f.all_environments} onChange={() => setF({ ...f, all_environments: false })} /> Only selected environments</label>
          </div>
          {!f.all_environments && (
            <div className="row wrap" style={{ gap: 14 }}>
              {lk.environments.map((e) => (
                <label key={e.id} className="check">
                  <input type="checkbox" checked={f.environment_ids.includes(e.id)} onChange={(ev) => setF({ ...f, environment_ids: ev.target.checked ? [...f.environment_ids, e.id] : f.environment_ids.filter((x) => x !== e.id) })} />
                  <EnvBadge env={e} />
                </label>
              ))}
            </div>
          )}
          <p className="small muted" style={{ margin: 0 }}>Servers, credentials and deployments outside these environments are completely hidden from the user.</p>
        </div>

        <div className="form-section">Permissions — click a cell to cycle: inherited from role → ✓ allow → ✗ deny</div>
        {g && (
          <div className="full table-wrap card">
            <table className="tbl perm-grid">
              <thead><tr><th>Module</th>{g.actions.map((a) => <th key={a}>{ACTION_LABELS[a]}</th>)}</tr></thead>
              <tbody>
                {g.modules.map((m) => (
                  <tr key={m}>
                    <td><b>{MODULE_LABELS[m] || m}</b></td>
                    {g.actions.map((a) => {
                      const code = `${m}.${a}`;
                      if (!g.byKey.has(code)) return <td key={a} />;
                      const o = f.overrides.find((x) => x.code === code);
                      const on = effective(code);
                      return (
                        <td key={a}>
                          <button type="button" onClick={() => cycle(code)} title={g.byKey.get(code)!.description + (o ? (o.granted ? " — custom allow" : " — custom deny") : " — from role")}
                            className={`badge ${o ? (o.granted ? "ok" : "danger") : on ? "primary" : "gray"}`} style={{ cursor: "pointer", minWidth: 34, justifyContent: "center", outline: o ? "2px solid currentColor" : undefined }}>
                            {on ? "✓" : "✗"}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="full small muted" style={{ margin: 0 }}>
          <span className="badge primary">✓</span> from role · <span className="badge ok" style={{ outline: "2px solid currentColor" }}>✓</span> custom allow · <span className="badge danger" style={{ outline: "2px solid currentColor" }}>✗</span> custom deny. "View Password" is separate from "View" — users can list credentials without ever seeing a password.
        </p>
      </form>
      {gen && <GeneratorModal onClose={() => setGen(false)} onUse={(pw) => setF((p) => ({ ...p, password: pw }))} />}
    </Modal>
  );
}
