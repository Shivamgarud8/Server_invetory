import { Fragment, useState } from "react";
import { PageHead } from "../components/Layout";
import { Field, Modal, useUi } from "../components/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useLoad } from "../lib/hooks";
import type { Permission, Role } from "../lib/types";
import { ACTION_LABELS, MODULE_LABELS, groupPerms } from "./Users";

export function Roles() {
  const { can } = useAuth();
  const { toast, confirm } = useUi();
  const { data: roles, reload } = useLoad(() => api.get<Role[]>("/roles"));
  const { data: perms } = useLoad(() => api.get<Permission[]>("/permissions"));
  const [editing, setEditing] = useState<Role | "new" | null>(null);
  const manage = can("roles.manage");
  if (!roles || !perms) return null;
  const g = groupPerms(perms);

  const remove = async (r: Role) => {
    if (!(await confirm(`Delete role ${r.name}?`, <p>{r.user_count} user(s) will lose the permissions from this role.</p>))) return;
    await api.del(`/roles/${r.id}`).then(() => (toast("Role deleted"), reload())).catch((e) => toast(e.message, true));
  };

  return (
    <>
      <PageHead title="Roles & Permissions" sub="Roles bundle permissions; individual users can still get custom allow/deny overrides.">
        {manage && <button className="btn primary" onClick={() => setEditing("new")}>+ New role</button>}
      </PageHead>
      <div className="card table-wrap">
        <table className="tbl perm-grid">
          <thead>
            <tr><th>Permission</th>{roles.map((r) => (
              <th key={r.id} style={{ minWidth: 110 }}>
                <div>{r.name}</div>
                <div className="small muted" style={{ textTransform: "none", fontWeight: 400 }}>{r.user_count} user{r.user_count === 1 ? "" : "s"}</div>
                {manage && r.name !== "Super Admin" && <div><button className="icon-btn" onClick={() => setEditing(r)}>✎</button>{!r.is_system && <button className="icon-btn" onClick={() => remove(r)}>🗑</button>}</div>}
              </th>
            ))}</tr>
          </thead>
          <tbody>
            {g.modules.map((m) => (
              <Fragment key={m}>
                <tr><td colSpan={roles.length + 1} style={{ background: "var(--panel-2)", fontWeight: 700, fontSize: 12, textTransform: "uppercase", letterSpacing: "0.05em" }}>{MODULE_LABELS[m] || m}</td></tr>
                {perms.filter((p) => p.module === m).map((p) => (
                  <tr key={p.code}>
                    <td><span>{ACTION_LABELS[p.action] || p.action}</span> <span className="small muted">— {p.description}</span></td>
                    {roles.map((r) => <td key={r.id}>{r.permissions.includes(p.code) ? <span style={{ color: "var(--ok)", fontWeight: 700 }}>✓</span> : <span className="muted">·</span>}</td>)}
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      {editing && <RoleForm initial={editing === "new" ? null : editing} perms={perms} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />}
    </>
  );
}

function RoleForm({ initial, perms, onClose, onSaved }: { initial: Role | null; perms: Permission[]; onClose: () => void; onSaved: () => void }) {
  const { toast } = useUi();
  const [name, setName] = useState(initial?.name || "");
  const [desc, setDesc] = useState(initial?.description || "");
  const [sel, setSel] = useState<string[]>(initial?.permissions || []);
  const g = groupPerms(perms);
  const toggle = (c: string) => setSel(sel.includes(c) ? sel.filter((x) => x !== c) : [...sel, c]);
  const save = async () => {
    try {
      if (initial) await api.put(`/roles/${initial.id}`, { name, description: desc, permissions: sel });
      else await api.post("/roles", { name, description: desc, permissions: sel });
      toast("Role saved");
      onSaved();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  return (
    <Modal wide title={initial ? `Edit role ${initial.name}` : "New role"} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save}>Save</button></>}>
      <div className="form-grid">
        <Field label="Name" required><input value={name} disabled={initial?.is_system} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Description"><input value={desc} onChange={(e) => setDesc(e.target.value)} /></Field>
        <div className="full card table-wrap">
          <table className="tbl perm-grid">
            <thead><tr><th>Module</th>{g.actions.map((a) => <th key={a}>{ACTION_LABELS[a]}</th>)}</tr></thead>
            <tbody>
              {g.modules.map((m) => (
                <tr key={m}><td><b>{MODULE_LABELS[m] || m}</b></td>
                  {g.actions.map((a) => {
                    const code = `${m}.${a}`;
                    return <td key={a}>{g.byKey.has(code) && <input type="checkbox" checked={sel.includes(code)} onChange={() => toggle(code)} title={g.byKey.get(code)!.description} />}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Modal>
  );
}
