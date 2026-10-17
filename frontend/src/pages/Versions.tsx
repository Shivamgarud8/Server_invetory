import { useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { PageHead } from "../components/Layout";
import { Empty, EnvBadge, Field, Modal, fmtDate, timeAgo, useUi } from "../components/ui";
import { api, download } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useDebounced, useLoad, useLookups } from "../lib/hooks";
import type { Application, Dependency, Deployment, History, Server } from "../lib/types";
import { SERVICE_STYLE } from "../components/Architecture";

interface Matrix {
  environments: { id: number; name: string; color: string }[];
  rows: { application: string; component: string; latest: string; drift: boolean; cells: Record<string, { version: string; servers: string[]; outdated: boolean }[]> }[];
}

type Tab = "deployments" | "matrix" | "history" | "applications";

export function Versions() {
  const [sp, setSp] = useSearchParams();
  const tab = (sp.get("tab") as Tab) || "deployments";
  const setTab = (t: Tab) => setSp(t === "deployments" ? {} : { tab: t });
  return (
    <>
      <PageHead title="Version Management" sub="What is deployed where — with full change history" />
      <div className="tabs">
        {(["deployments", "matrix", "history", "applications"] as Tab[]).map((t) => (
          <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
            {{ deployments: "Deployments", matrix: "Environment comparison", history: "Version history", applications: "Applications" }[t]}
          </button>
        ))}
      </div>
      {tab === "deployments" && <Deployments />}
      {tab === "matrix" && <MatrixView />}
      {tab === "history" && <HistoryView />}
      {tab === "applications" && <Applications />}
    </>
  );
}

function Deployments() {
  const { can } = useAuth();
  const { toast, confirm } = useUi();
  const lk = useLookups();
  const [q, setQ] = useState("");
  const [env, setEnv] = useState("");
  const [app, setApp] = useState("");
  const dq = useDebounced(q);
  const params = { q: dq, environment_id: env, application_id: app };
  const { data: apps } = useLoad(() => api.get<Application[]>("/applications"));
  const { data, reload } = useLoad(() => api.get<Deployment[]>("/deployments", params), [dq, env, app]);
  const [adding, setAdding] = useState<Deployment | "new" | null>(null);
  const [updating, setUpdating] = useState<Deployment | null>(null);
  const [hist, setHist] = useState<Deployment | null>(null);
  const [links, setLinks] = useState<Deployment | null>(null);

  const rollback = async (d: Deployment) => {
    if (!(await confirm(`Roll back ${d.component}?`, <p>Record <b className="mono">{d.current_version}</b> → <b className="mono">{d.previous_version}</b> on {d.server?.name || d.environment.name}.</p>, false))) return;
    try {
      await api.post(`/deployments/${d.id}/rollback`);
      toast("Rollback recorded");
      reload();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  const remove = async (d: Deployment) => {
    if (!(await confirm(`Stop tracking ${d.application.name} / ${d.component}?`, <p>History is kept.</p>))) return;
    await api.del(`/deployments/${d.id}`).then(() => (toast("Removed"), reload())).catch((e) => toast(e.message, true));
  };

  return (
    <div className="card">
      <div className="filters">
        <input type="search" placeholder="Search application, component, version, server, image…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={env} onChange={(e) => setEnv(e.target.value)}><option value="">All environments</option>{lk.environments.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select>
        <select value={app} onChange={(e) => setApp(e.target.value)}><option value="">All applications</option>{apps?.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
        <span className="spacer" />
        <button className="btn" onClick={() => download("/deployments/export", params).catch((e) => toast(e.message, true))}>⇩ Export</button>
        {can("versions.create") && <button className="btn primary" onClick={() => setAdding("new")}>+ Track deployment</button>}
      </div>
      <div className="table-wrap">
        <table className="tbl">
          <thead><tr><th>Server</th><th>Application</th><th>Component</th><th>Type / port</th><th>Version</th><th>Previous</th><th>Env</th><th>Deployed</th><th>By</th><th /></tr></thead>
          <tbody>
            {data?.map((d) => (
              <tr key={d.id}>
                <td>{d.server?.name || <span className="muted">—</span>}</td>
                <td><b>{d.application.name}</b></td>
                <td>{d.component}{d.image && <div className="mono small muted">{d.image}</div>}</td>
                <td className="nowrap"><span className="badge" style={{ background: (SERVICE_STYLE[d.service_type] || SERVICE_STYLE.other).color + "22", color: (SERVICE_STYLE[d.service_type] || SERVICE_STYLE.other).color }}>{(SERVICE_STYLE[d.service_type] || SERVICE_STYLE.other).icon} {d.service_type}</span>{d.port && <span className="mono small"> :{d.port}</span>}</td>
                <td className="mono"><b>{d.current_version}</b></td>
                <td className="mono muted">{d.previous_version || "—"}</td>
                <td><EnvBadge env={d.environment} /></td>
                <td className="small nowrap" title={fmtDate(d.deployed_at, true)}>{fmtDate(d.deployed_at)}</td>
                <td className="small">{d.updated_by_name || "—"}</td>
                <td className="right nowrap">
                  {can("versions.update") && <button className="btn sm primary" onClick={() => setUpdating(d)}>Update version</button>}{" "}
                  <button className="icon-btn" title="History" onClick={() => setHist(d)}>🕘</button>
                  <button className="icon-btn" title="Connections to other services" onClick={() => setLinks(d)}>🔗</button>
                  {can("versions.update") && d.previous_version && <button className="icon-btn" title="Roll back to previous" onClick={() => rollback(d)}>↶</button>}
                  {can("versions.update") && <button className="icon-btn" title="Edit" onClick={() => setAdding(d)}>✎</button>}
                  {can("versions.delete") && <button className="icon-btn" title="Remove" onClick={() => remove(d)}>🗑</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {data && !data.length && <Empty>No deployments tracked yet.</Empty>}
      </div>
      {adding && <DeploymentForm initial={adding === "new" ? null : adding} apps={apps || []} onClose={() => setAdding(null)} onSaved={() => { setAdding(null); reload(); }} />}
      {updating && <UpdateVersion d={updating} onClose={() => setUpdating(null)} onSaved={() => { setUpdating(null); reload(); }} />}
      {links && <Connections d={links} all={data || []} onClose={() => setLinks(null)} />}
      {hist && (
        <Modal title={`${hist.application.name} / ${hist.component} — history`} onClose={() => setHist(null)} wide>
          <HistoryTable deploymentId={hist.id} />
        </Modal>
      )}
    </div>
  );
}

function UpdateVersion({ d, onClose, onSaved }: { d: Deployment; onClose: () => void; onSaved: () => void }) {
  const { toast } = useUi();
  const [v, setV] = useState("");
  const [image, setImage] = useState(d.image || "");
  const [notes, setNotes] = useState("");
  const [when, setWhen] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.post(`/deployments/${d.id}/version`, { new_version: v, image, notes: notes || null, deployed_at: when ? new Date(when).toISOString() : null });
      toast(`${d.component} → ${v}`);
      onSaved();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  return (
    <Modal title="Update version" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" form="uv">Save</button></>}>
      <form id="uv" className="form-grid" onSubmit={submit}>
        <dl className="kv full">
          <dt>Application</dt><dd><b>{d.application.name}</b> / {d.component}</dd>
          <dt>Server</dt><dd>{d.server?.name || "—"} <EnvBadge env={d.environment} /></dd>
          <dt>Current version</dt><dd className="mono"><b>{d.current_version}</b></dd>
        </dl>
        <Field label="New version" required><input className="mono" required autoFocus value={v} onChange={(e) => setV(e.target.value)} placeholder="v3.33.5" /></Field>
        <Field label="Deployed at"><input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} /></Field>
        <Field label="Image" full><input className="mono" value={image} onChange={(e) => setImage(e.target.value)} placeholder="harbor.internal/tagid/admin-api:v3.33.5" /></Field>
        <Field label="Notes / change reference" full><textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Release notes, ticket, MR link…" /></Field>
      </form>
    </Modal>
  );
}

function DeploymentForm({ initial, apps, onClose, onSaved }: { initial: Deployment | null; apps: Application[]; onClose: () => void; onSaved: () => void }) {
  const { toast } = useUi();
  const lk = useLookups();
  const { data: servers } = useLoad(() => api.get<Server[]>("/servers"));
  const [f, setF] = useState({
    application_id: String(initial?.application.id || ""), component: initial?.component || "", server_id: String(initial?.server?.id || ""),
    environment_id: String(initial?.environment.id || ""), current_version: initial?.current_version || "", image: initial?.image || "", notes: initial?.notes || "",
    service_type: initial?.service_type || "other", port: initial?.port ? String(initial.port) : "", protocol: initial?.protocol || "", health_url: initial?.health_url || "",
  });
  const set = (k: keyof typeof f, v: string) => setF((p) => ({ ...p, [k]: v }));
  const pickServer = (id: string) => {
    const s = servers?.find((x) => String(x.id) === id);
    setF((p) => ({ ...p, server_id: id, environment_id: s ? String(s.environment.id) : p.environment_id }));
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body = { ...f, application_id: +f.application_id, environment_id: +f.environment_id, server_id: f.server_id ? +f.server_id : null, port: f.port ? +f.port : null };
    try {
      if (initial) await api.put(`/deployments/${initial.id}`, body);
      else await api.post("/deployments", body);
      toast("Saved");
      onSaved();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  return (
    <Modal title={initial ? "Edit deployment record" : "Track a deployment"} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" form="dep">Save</button></>}>
      <form id="dep" className="form-grid" onSubmit={submit}>
        <Field label="Application" required>
          <select required value={f.application_id} onChange={(e) => set("application_id", e.target.value)}><option value="">Select…</option>{apps.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
        </Field>
        <Field label="Component" required><input required value={f.component} onChange={(e) => set("component", e.target.value)} placeholder="Admin API" /></Field>
        <Field label="Server">
          <select value={f.server_id} onChange={(e) => pickServer(e.target.value)}><option value="">—</option>{servers?.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.environment.name})</option>)}</select>
        </Field>
        <Field label="Environment" required>
          <select required value={f.environment_id} onChange={(e) => set("environment_id", e.target.value)}><option value="">Select…</option>{lk.environments.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select>
        </Field>
        <Field label="Current version (or -)" required><input className="mono" required value={f.current_version} onChange={(e) => set("current_version", e.target.value)} placeholder="v3.33.4" /></Field>
        <Field label="Image"><input className="mono" value={f.image} onChange={(e) => set("image", e.target.value)} /></Field>
        <Field label="Service type">
          <select value={f.service_type} onChange={(e) => set("service_type", e.target.value)}>{Object.entries(SERVICE_STYLE).map(([k, v]) => <option key={k} value={k}>{v.icon} {v.label}</option>)}</select>
        </Field>
        <Field label="Port"><input type="number" min={1} max={65535} value={f.port} onChange={(e) => set("port", e.target.value)} /></Field>
        <Field label="Protocol"><input value={f.protocol} onChange={(e) => set("protocol", e.target.value)} placeholder="HTTP, TCP, AMQP…" /></Field>
        <Field label="Health URL"><input value={f.health_url} onChange={(e) => set("health_url", e.target.value)} placeholder="https://api.example.com/health" /></Field>
        <Field label="Notes" full><textarea value={f.notes} onChange={(e) => set("notes", e.target.value)} /></Field>
        {!apps.length && <div className="alert warn full">Create an application in the Applications tab first.</div>}
      </form>
    </Modal>
  );
}

function MatrixView() {
  const { data } = useLoad(() => api.get<Matrix>("/version-matrix"));
  const [onlyDrift, setOnlyDrift] = useState(false);
  if (!data) return null;
  const rows = onlyDrift ? data.rows.filter((r) => r.drift) : data.rows;
  return (
    <div className="card">
      <div className="filters">
        <label className="check"><input type="checkbox" checked={onlyDrift} onChange={(e) => setOnlyDrift(e.target.checked)} /> Show only components with version drift</label>
        <span className="spacer" />
        <span className="small muted"><span className="ver" style={{ padding: "1px 6px", borderRadius: 4, background: "var(--ok-soft)", color: "var(--ok)" }}>latest</span> <span style={{ padding: "1px 6px", borderRadius: 4, background: "var(--warn-soft)", color: "var(--warn)" }}>older</span></span>
      </div>
      <div className="table-wrap">
        <table className="tbl matrix">
          <thead><tr><th>Application</th><th>Component</th>{data.environments.map((e) => <th key={e.id}><EnvBadge env={e} /></th>)}</tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.application + r.component}>
                <td><b>{r.application}</b></td>
                <td>{r.component} {r.drift && <span className="badge warn" title="Different versions across servers/environments">drift</span>}</td>
                {data.environments.map((e) => (
                  <td key={e.id}>
                    {(r.cells[String(e.id)] || []).map((c) => (
                      <span key={c.version} className={`ver ${c.outdated ? "old" : ""}`} title={c.servers.join(", ")}>{c.version}{c.servers.length > 1 && <span className="muted"> ×{c.servers.length}</span>}</span>
                    ))}
                    {!r.cells[String(e.id)] && <span className="muted">—</span>}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && <Empty>{onlyDrift ? "No drift — every component runs the same version everywhere ✓" : "No deployments tracked yet."}</Empty>}
      </div>
    </div>
  );
}

function HistoryTable({ deploymentId, q }: { deploymentId?: number; q?: string }) {
  const { data } = useLoad(() => api.get<History[]>("/version-history", { deployment_id: deploymentId, q }), [deploymentId, q]);
  return (
    <div className="table-wrap">
      <table className="tbl">
        <thead><tr><th>When</th><th>Application</th><th>Component</th><th>Server</th><th>Env</th><th>Change</th><th>By</th><th>Notes</th></tr></thead>
        <tbody>
          {data?.map((h) => (
            <tr key={h.id}>
              <td className="small nowrap" title={fmtDate(h.changed_at, true)}>{timeAgo(h.changed_at)}</td>
              <td><b>{h.application_name}</b></td><td>{h.component}</td><td>{h.server_name || "—"}</td>
              <td><span className="badge gray">{h.environment_name}</span></td>
              <td className="mono nowrap">{h.old_version ? <><span className="muted">{h.old_version}</span> → </> : <span className="badge ok">new</span>} <b>{h.new_version}</b></td>
              <td className="small">{h.changed_by}</td>
              <td className="small muted" style={{ maxWidth: 260 }}>{h.notes}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {data && !data.length && <Empty>No history.</Empty>}
    </div>
  );
}

function HistoryView() {
  const [q, setQ] = useState("");
  const dq = useDebounced(q);
  return (
    <div className="card">
      <div className="filters"><input type="search" placeholder="Search application, component, server, version…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      <HistoryTable q={dq} />
    </div>
  );
}

function Applications() {
  const { can } = useAuth();
  const { toast, confirm } = useUi();
  const { data, reload } = useLoad(() => api.get<Application[]>("/applications"));
  const [editing, setEditing] = useState<Application | "new" | null>(null);
  const [f, setF] = useState({ name: "", category: "", description: "", repository_url: "" });

  const open = (a: Application | "new") => {
    setEditing(a);
    setF(a === "new" ? { name: "", category: "", description: "", repository_url: "" } : { name: a.name, category: a.category || "", description: a.description || "", repository_url: a.repository_url || "" });
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      if (editing === "new") await api.post("/applications", f);
      else if (editing) await api.put(`/applications/${editing.id}`, f);
      setEditing(null);
      reload();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  const remove = async (a: Application) => {
    if (!(await confirm(`Delete application ${a.name}?`, <p>This removes its {a.deployment_count} tracked deployment(s). Version history is kept.</p>))) return;
    await api.del(`/applications/${a.id}`).then(reload).catch((e) => toast(e.message, true));
  };

  return (
    <div className="card">
      <div className="filters"><span className="spacer" />{can("versions.create") && <button className="btn primary" onClick={() => open("new")}>+ Add application</button>}</div>
      <table className="tbl">
        <thead><tr><th>Application</th><th>Category</th><th>Description</th><th>Repository</th><th>Deployments</th><th /></tr></thead>
        <tbody>
          {data?.map((a) => (
            <tr key={a.id}>
              <td><b>{a.name}</b></td><td>{a.category}</td><td className="small">{a.description}</td>
              <td className="small">{a.repository_url && <a href={a.repository_url} target="_blank" rel="noreferrer noopener">{a.repository_url}</a>}</td>
              <td>{a.deployment_count}</td>
              <td className="right">
                {can("versions.update") && <button className="icon-btn" onClick={() => open(a)}>✎</button>}
                {can("versions.delete") && <button className="icon-btn" onClick={() => remove(a)}>🗑</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {data && !data.length && <Empty>No applications yet.</Empty>}
      {editing && (
        <Modal title={editing === "new" ? "Add application" : `Edit ${editing.name}`} onClose={() => setEditing(null)} footer={<><button className="btn" onClick={() => setEditing(null)}>Cancel</button><button className="btn primary" form="appf">Save</button></>}>
          <form id="appf" className="form-grid" onSubmit={submit}>
            <Field label="Name" required><input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="TagID API" /></Field>
            <Field label="Category"><input value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} placeholder="Application, Database, Infra…" /></Field>
            <Field label="Repository URL" full><input value={f.repository_url} onChange={(e) => setF({ ...f, repository_url: e.target.value })} /></Field>
            <Field label="Description" full><textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
          </form>
        </Modal>
      )}
    </div>
  );
}

function Connections({ d, all, onClose }: { d: Deployment; all: Deployment[]; onClose: () => void }) {
  const { can } = useAuth();
  const { toast } = useUi();
  const { data, reload } = useLoad(() => api.get<Dependency[]>("/service-dependencies"));
  const [to, setTo] = useState("");
  const [protocol, setProtocol] = useState("");
  const [port, setPort] = useState("");
  const byId = new Map(all.map((x) => [x.id, x]));
  const label = (id: number) => { const x = byId.get(id); return x ? `${x.application.name} / ${x.component}${x.server ? ` @ ${x.server.name}` : ""}` : `#${id}`; };
  const out = (data || []).filter((x) => x.from_service_id === d.id);
  const inc = (data || []).filter((x) => x.to_service_id === d.id);
  const add = async () => {
    if (!to) return;
    const target = byId.get(+to);
    await api.post("/service-dependencies", { from_service_id: d.id, to_service_id: +to, protocol: protocol || null, port: port ? +port : target?.port ?? null })
      .then(() => { setTo(""); setPort(""); setProtocol(""); reload(); }).catch((e) => toast(e.message, true));
  };
  const del = (id: number) => api.del(`/service-dependencies/${id}`).then(reload).catch((e) => toast(e.message, true));
  return (
    <Modal wide title={`🔗 Connections — ${d.application.name} / ${d.component}`} onClose={onClose}>
      <h3>This service connects to</h3>
      {out.length ? out.map((x) => (
        <div key={x.id} className="row" style={{ marginBottom: 6 }}>→ <b>{label(x.to_service_id)}</b> <span className="mono small muted">{x.protocol} {x.port ? `:${x.port}` : ""}</span><span className="spacer" />
          {can("versions.update") && <button className="icon-btn" onClick={() => del(x.id)}>✕</button>}</div>
      )) : <p className="muted small">Nothing yet.</p>}
      {can("versions.update") && (
        <div className="row wrap" style={{ marginTop: 8 }}>
          <select value={to} onChange={(e) => setTo(e.target.value)} style={{ maxWidth: 360 }}>
            <option value="">Add connection to…</option>
            {all.filter((x) => x.id !== d.id).map((x) => <option key={x.id} value={x.id}>{label(x.id)}</option>)}
          </select>
          <input placeholder="Protocol" value={protocol} onChange={(e) => setProtocol(e.target.value)} style={{ width: 110 }} />
          <input placeholder="Port" type="number" value={port} onChange={(e) => setPort(e.target.value)} style={{ width: 90 }} />
          <button className="btn primary" disabled={!to} onClick={add}>Add</button>
        </div>
      )}
      <h3 style={{ marginTop: 18 }}>Used by</h3>
      {inc.length ? inc.map((x) => <div key={x.id} className="small" style={{ marginBottom: 4 }}>← <b>{label(x.from_service_id)}</b> <span className="mono muted">{x.protocol} {x.port ? `:${x.port}` : ""}</span></div>) : <p className="muted small">No other service depends on this one.</p>}
      <p className="small muted">Connections appear as animated arrows in the client's architecture diagram.</p>
    </Modal>
  );
}
