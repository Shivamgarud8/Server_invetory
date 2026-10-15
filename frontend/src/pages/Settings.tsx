import { useState } from "react";
import { PageHead } from "../components/Layout";
import { Field, Modal, useUi } from "../components/ui";
import { api } from "../lib/api";
import { invalidateLookups, useLoad } from "../lib/hooks";
import type { CredentialType, Environment, Tag } from "../lib/types";

type Kind = "environments" | "tags" | "credential-types";

export function SettingsPage() {
  return (
    <>
      <PageHead title="Settings" sub="Lookup lists used across the portal" />
      <div className="grid grid-3">
        <LookupCard<Environment> kind="environments" title="Environments" blank={{ name: "", color: "#64748b", sort_order: 100, is_production: false }}
          render={(e) => <><span className="badge env" style={{ background: e.color }}>{e.name}</span>{e.is_production && <span className="badge danger">production</span>}<span className="small muted">order {e.sort_order}</span></>} />
        <LookupCard<Tag> kind="tags" title="Tags" blank={{ name: "", color: "#6366f1" }}
          render={(t) => <span className="badge tag" style={{ color: t.color, borderColor: t.color }}>{t.name}</span>} />
        <LookupCard<CredentialType> kind="credential-types" title="Credential types" blank={{ name: "", default_port: null }}
          render={(t) => <><b>{t.name}</b>{t.default_port && <span className="small muted mono">:{t.default_port}</span>}</>} />
      </div>
    </>
  );
}

function LookupCard<T extends { id: number; name: string }>({ kind, title, blank, render }: {
  kind: Kind; title: string; blank: Omit<T, "id">; render: (x: T) => React.ReactNode;
}) {
  const { toast, confirm } = useUi();
  const { data, reload } = useLoad(() => api.get<T[]>(`/${kind}`));
  const [editing, setEditing] = useState<(Partial<T> & { id?: number }) | null>(null);

  const save = async () => {
    if (!editing) return;
    const { id, ...body } = editing as Record<string, unknown> & { id?: number };
    try {
      if (id) await api.put(`/${kind}/${id}`, body);
      else await api.post(`/${kind}`, body);
      setEditing(null);
      invalidateLookups();
      reload();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  const remove = async (x: T) => {
    if (!(await confirm(`Delete ${x.name}?`))) return;
    await api.del(`/${kind}/${x.id}`).then(() => (invalidateLookups(), reload())).catch((e) => toast(e.message, true));
  };
  const e = editing as Record<string, unknown> | null;
  const setE = (k: string, v: unknown) => setEditing({ ...(editing as object), [k]: v } as Partial<T>);

  return (
    <div className="card">
      <div className="card-head"><h2>{title}</h2><span className="spacer" /><button className="btn sm" onClick={() => setEditing({ ...blank } as Partial<T>)}>+ Add</button></div>
      <ul className="feed">
        {data?.map((x) => (
          <li key={x.id} style={{ alignItems: "center" }}>
            <span className="row" style={{ flex: 1 }}>{render(x)}</span>
            <button className="icon-btn" onClick={() => setEditing({ ...x })}>✎</button>
            <button className="icon-btn" onClick={() => remove(x)}>🗑</button>
          </li>
        ))}
      </ul>
      {e && (
        <Modal title={`${e.id ? "Edit" : "Add"} ${title.toLowerCase().replace(/s$/, "")}`} onClose={() => setEditing(null)}
          footer={<><button className="btn" onClick={() => setEditing(null)}>Cancel</button><button className="btn primary" onClick={save}>Save</button></>}>
          <div className="form-grid">
            <Field label="Name" required><input value={String(e.name ?? "")} onChange={(ev) => setE("name", ev.target.value)} autoFocus /></Field>
            {"color" in e && <Field label="Colour"><input type="color" value={String(e.color)} onChange={(ev) => setE("color", ev.target.value)} style={{ height: 38, padding: 2 }} /></Field>}
            {"sort_order" in e && <Field label="Sort order"><input type="number" value={Number(e.sort_order)} onChange={(ev) => setE("sort_order", +ev.target.value)} /></Field>}
            {"is_production" in e && <label className="check" style={{ alignSelf: "end" }}><input type="checkbox" checked={!!e.is_production} onChange={(ev) => setE("is_production", ev.target.checked)} /> Production environment</label>}
            {"default_port" in e && <Field label="Default port"><input type="number" value={e.default_port == null ? "" : Number(e.default_port)} onChange={(ev) => setE("default_port", ev.target.value ? +ev.target.value : null)} /></Field>}
          </div>
        </Modal>
      )}
    </div>
  );
}
