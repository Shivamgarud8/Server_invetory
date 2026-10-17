import { useState, type FormEvent } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ArchitectureEditor, SERVICE_STYLE } from "../components/Architecture";
import { PageHead } from "../components/Layout";
import { Empty, EnvBadge, Field, HealthBadge, Modal, fmtDate, useUi } from "../components/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useDebounced, useLoad, useLookups } from "../lib/hooks";
import type { Client, Deployment, Server } from "../lib/types";
import { Credentials } from "./Credentials";
import { DomainsTable } from "./Domains";
import { Servers, ipOf } from "./Servers";

export const ARCH_LABEL: Record<string, string> = {
  single: "Single server", three_tier: "Three-tier", shared_db: "Shared database", custom: "Custom",
};

// ---------------------------------------------------------------- list

export function Clients() {
  const { can } = useAuth();
  const nav = useNavigate();
  const [q, setQ] = useState("");
  const dq = useDebounced(q);
  const { data, reload } = useLoad(() => api.get<Client[]>("/clients", { q: dq }), [dq]);
  const [editing, setEditing] = useState<Client | "new" | null>(null);

  return (
    <>
      <PageHead title="Clients & Architecture" sub="One workspace per client: servers, services, domains, credentials and a live architecture diagram">
        {can("clients.create") && <button className="btn primary" onClick={() => setEditing("new")}>+ Add client</button>}
      </PageHead>
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filters"><input type="search" placeholder="Search clients…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      </div>
      <div className="grid grid-3">
        {data?.map((c) => (
          <button key={c.id} className="card card-pad client-card" onClick={() => nav(`/clients/${c.id}`)} style={{ borderTop: `4px solid ${c.color}` }}>
            <div className="row">
              <h2 style={{ margin: 0 }}>{c.name}</h2>
              {c.code && <span className="badge gray">{c.code}</span>}
              <span className="spacer" />
              <span className="badge primary">{ARCH_LABEL[c.architecture_type]}</span>
            </div>
            {c.description && <p className="muted small" style={{ margin: "6px 0 0" }}>{c.description}</p>}
            <div className="row wrap" style={{ marginTop: 12, gap: 14 }}>
              <span>🖧 <b>{c.server_count}</b> servers</span>
              <span>📦 <b>{c.service_count}</b> services</span>
              <span>🌐 <b>{c.domain_count}</b> domains</span>
              <span>🔐 <b>{c.credential_count}</b></span>
            </div>
            <div className="row wrap" style={{ marginTop: 10, gap: 6 }}>
              {c.environments.map((e) => <span key={e} className="badge gray">{e}</span>)}
              <span className="spacer" />
              {Object.entries(c.health).map(([k, v]) => <HealthBadge key={k} status={k} detail={`${v} server(s)`} />)}
            </div>
          </button>
        ))}
      </div>
      {data && !data.length && <div className="card"><Empty>No clients yet. Add your first client (e.g. Snitch) to start mapping its infrastructure.</Empty></div>}
      {editing && <ClientForm initial={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={(c) => { setEditing(null); reload(); nav(`/clients/${c.id}?tab=${editing === "new" ? "template" : "overview"}`); }} />}
    </>
  );
}

export function ClientForm({ initial, onClose, onSaved }: { initial: Client | null; onClose: () => void; onSaved: (c: Client) => void }) {
  const { toast } = useUi();
  const [f, setF] = useState({
    name: initial?.name || "", code: initial?.code || "", description: initial?.description || "",
    architecture_type: initial?.architecture_type || "three_tier", color: initial?.color || "#6366f1",
    contact: initial?.contact || "", notes: initial?.notes || "", runbook: initial?.runbook || "",
    backup_policy: initial?.backup_policy || "", recovery_plan: initial?.recovery_plan || "",
  });
  const set = (k: keyof typeof f, v: string) => setF((p) => ({ ...p, [k]: v }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const c = initial ? await api.put<Client>(`/clients/${initial.id}`, f) : await api.post<Client>("/clients", f);
      toast(initial ? "Client updated" : "Client created");
      onSaved(c);
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  return (
    <Modal wide title={initial ? `Edit ${initial.name}` : "Add client"} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" form="cf">Save</button></>}>
      <form id="cf" className="form-grid" onSubmit={submit}>
        <Field label="Client name" required><input required value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="Snitch" /></Field>
        <Field label="Short code"><input value={f.code} onChange={(e) => set("code", e.target.value)} placeholder="SNT" /></Field>
        <Field label="Architecture type">
          <select value={f.architecture_type} onChange={(e) => set("architecture_type", e.target.value)}>
            {Object.entries(ARCH_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </Field>
        <Field label="Colour"><input type="color" value={f.color} onChange={(e) => set("color", e.target.value)} style={{ height: 38, padding: 2 }} /></Field>
        <Field label="Description" full><input value={f.description} onChange={(e) => set("description", e.target.value)} placeholder="E-commerce platform, 3-tier on AWS" /></Field>
        <Field label="Contact" full><input value={f.contact} onChange={(e) => set("contact", e.target.value)} placeholder="Client tech contact / escalation" /></Field>
        <div className="form-section">Operations</div>
        <Field label="Runbook / maintenance notes" full><textarea rows={4} value={f.runbook} onChange={(e) => set("runbook", e.target.value)} placeholder="Deploy steps, restart order, known issues…" /></Field>
        <Field label="Backup policy" full><textarea value={f.backup_policy} onChange={(e) => set("backup_policy", e.target.value)} placeholder="pg_dump nightly 02:00 → MinIO, 30 days retention…" /></Field>
        <Field label="Disaster recovery plan" full><textarea rows={4} value={f.recovery_plan} onChange={(e) => set("recovery_plan", e.target.value)} placeholder="1. Provision new DB server… 2. Restore latest dump… 3. Update DNS…" /></Field>
        <Field label="Notes" full><textarea value={f.notes} onChange={(e) => set("notes", e.target.value)} /></Field>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- workspace

type Tab = "overview" | "architecture" | "servers" | "services" | "domains" | "credentials" | "runbook" | "template";

export function ClientWorkspace() {
  const { id } = useParams();
  const cid = Number(id);
  const { can } = useAuth();
  const nav = useNavigate();
  const { toast, confirm } = useUi();
  const [sp, setSp] = useSearchParams();
  const tab = (sp.get("tab") as Tab) || "architecture";
  const setTab = (t: Tab) => setSp({ tab: t });
  const { data: c, reload } = useLoad(() => api.get<Client>(`/clients/${cid}`), [cid]);
  const [editing, setEditing] = useState(false);

  if (!c) return null;
  const remove = async () => {
    if (!(await confirm(`Delete client ${c.name}?`, <p>Servers, domains and credentials are kept but unlinked from this client.</p>))) return;
    await api.del(`/clients/${c.id}`).then(() => (toast("Client deleted"), nav("/clients"))).catch((e) => toast(e.message, true));
  };

  const tabs: [Tab, string, boolean][] = [
    ["architecture", "🗺 Architecture", true], ["overview", "Overview", true], ["servers", `🖧 Servers (${c.server_count})`, can("servers.view")],
    ["services", `📦 Services (${c.service_count})`, can("versions.view")], ["domains", `🌐 Domains (${c.domain_count})`, true],
    ["credentials", `🔐 Credentials (${c.credential_count})`, can("credentials.view")], ["runbook", "🛟 Runbook & DR", true],
    ["template", "✨ Template wizard", can("clients.update") && can("servers.create")],
  ];

  return (
    <>
      <PageHead title={c.name} sub={<span className="row wrap"><span className="badge primary">{ARCH_LABEL[c.architecture_type]}</span>{c.environments.map((e) => <span key={e} className="badge gray">{e}</span>)}<span>{c.description}</span></span>}>
        <Link to="/clients" className="btn">← Clients</Link>
        {can("clients.delete") && <button className="btn danger" onClick={remove}>Delete</button>}
        {can("clients.update") && <button className="btn primary" onClick={() => setEditing(true)}>Edit client</button>}
      </PageHead>
      <div className="tabs">{tabs.filter((t) => t[2]).map(([k, label]) => <button key={k} className={tab === k ? "active" : ""} onClick={() => setTab(k)}>{label}</button>)}</div>

      {tab === "architecture" && (c.server_count || c.domain_count ? <ArchitectureEditor clientId={c.id} clientName={c.name} /> : (
        <div className="card"><Empty>No servers yet for {c.name}. {can("servers.create") ? <>Use the <a href="#" onClick={(e) => { e.preventDefault(); setTab("template"); }}>template wizard</a> or add servers to generate the diagram.</> : null}</Empty></div>
      ))}
      {tab === "overview" && <Overview c={c} />}
      {tab === "servers" && <Servers clientId={c.id} embedded />}
      {tab === "services" && <ClientServices clientId={c.id} />}
      {tab === "domains" && <DomainsTable clientId={c.id} />}
      {tab === "credentials" && <Credentials clientId={c.id} embedded />}
      {tab === "runbook" && (
        <div className="grid grid-2">
          {([["Runbook / maintenance", c.runbook], ["Backup policy", c.backup_policy], ["Disaster recovery plan", c.recovery_plan], ["Notes", c.notes]] as const).map(([t, v]) => (
            <div key={t} className="card card-pad"><h2>{t}</h2><div style={{ whiteSpace: "pre-wrap" }}>{v || <span className="muted">Not written yet — click “Edit client”.</span>}</div></div>
          ))}
        </div>
      )}
      {tab === "template" && <TemplateWizard client={c} onDone={() => { reload(); setTab("architecture"); }} />}
      {editing && <ClientForm initial={c} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); reload(); }} />}
    </>
  );
}

function Overview({ c }: { c: Client }) {
  const { data: servers } = useLoad(() => api.get<Server[]>("/servers", { client_id: c.id }), [c.id]);
  return (
    <div className="grid grid-2">
      <div className="card card-pad">
        <h2>Client</h2>
        <dl className="kv">
          <dt>Code</dt><dd>{c.code || "—"}</dd>
          <dt>Architecture</dt><dd>{ARCH_LABEL[c.architecture_type]}</dd>
          <dt>Contact</dt><dd>{c.contact || "—"}</dd>
          <dt>Environments</dt><dd className="row wrap">{c.environments.map((e) => <span key={e} className="badge gray">{e}</span>)}</dd>
          <dt>Created</dt><dd>{fmtDate(c.created_at)}</dd>
          <dt>Updated</dt><dd>{fmtDate(c.updated_at, true)}</dd>
        </dl>
      </div>
      <div className="card">
        <div className="card-head"><h2>Servers</h2></div>
        <table className="tbl">
          <thead><tr><th>Server</th><th>Role</th><th>Env</th><th>Private / VPN / Public</th><th>Status</th></tr></thead>
          <tbody>{servers?.map((s) => (
            <tr key={s.id}><td><Link to={`/servers/${s.id}`}><b>{s.name}</b></Link></td><td><span className="badge gray">{s.role}</span></td>
              <td><EnvBadge env={s.environment} /></td>
              <td className="mono small">{[ipOf(s, "private"), ipOf(s, "vpn"), ipOf(s, "public")].map((x) => x || "—").join(" / ")}</td>
              <td><HealthBadge status={s.health_status} detail={s.health_detail} at={s.health_checked_at} /></td></tr>
          ))}</tbody>
        </table>
        {servers && !servers.length && <Empty>No servers linked.</Empty>}
      </div>
    </div>
  );
}

function ClientServices({ clientId }: { clientId: number }) {
  const { data } = useLoad(() => api.get<Deployment[]>("/deployments", { client_id: clientId }), [clientId]);
  return (
    <div className="card table-wrap">
      <table className="tbl">
        <thead><tr><th>Service</th><th>Type</th><th>Application</th><th>Server</th><th>Port</th><th>Version</th><th>Env</th></tr></thead>
        <tbody>{data?.map((d) => {
          const s = SERVICE_STYLE[d.service_type] || SERVICE_STYLE.other;
          return (
            <tr key={d.id}><td><b>{s.icon} {d.component}</b></td><td><span className="badge" style={{ background: s.color + "22", color: s.color }}>{s.label}</span></td>
              <td>{d.application.name}</td><td>{d.server?.name || "—"}</td><td className="mono">{d.port ?? "—"}</td>
              <td className="mono">{d.current_version}</td><td><EnvBadge env={d.environment} /></td></tr>
          );
        })}</tbody>
      </table>
      {data && !data.length && <Empty>No services yet. Add them under Applications & Services, or use the template wizard.</Empty>}
      <div className="filters" style={{ borderTop: "1px solid var(--border)", borderBottom: 0 }}>
        <span className="small muted">Manage services, versions and connections in <Link to="/versions">Applications & Services</Link>.</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- template wizard

interface WServer { name: string; role: string; private_ip: string; public_ip: string; vpn_ip: string; ssh_user: string }
interface WService { on: boolean; server_index: number; application: string; component: string; service_type: string; port: string }

const ROLES = ["proxy", "application", "database", "combined", "storage", "monitoring", "other"];

function preset(t: string, code: string): { servers: WServer[]; services: WService[] } {
  const srv = (suffix: string, role: string): WServer => ({ name: `${code}-${suffix}`, role, private_ip: "", public_ip: "", vpn_ip: "", ssh_user: "ubuntu" });
  const svc = (i: number, application: string, component: string, service_type: string, port: number | ""): WService =>
    ({ on: true, server_index: i, application, component, service_type, port: String(port) });
  if (t === "single") return {
    servers: [srv("srv-01", "combined")],
    services: [svc(0, "Nginx", "Nginx", "proxy", 443), svc(0, `${code} UI`, "UI", "ui", 3000), svc(0, `${code} API`, "API", "api", 8080),
      svc(0, "PostgreSQL", "PostgreSQL", "database", 5432), svc(0, "Redis", "Redis", "cache", 6379)],
  };
  if (t === "three_tier") return {
    servers: [srv("web-01", "proxy"), srv("app-01", "application"), srv("db-01", "database")],
    services: [svc(0, "Nginx", "Nginx", "proxy", 443), svc(1, `${code} UI`, "UI", "ui", 3000), svc(1, `${code} API`, "API", "api", 8080),
      svc(1, "Redis", "Redis", "cache", 6379), svc(1, "RabbitMQ", "RabbitMQ", "queue", 5672), svc(1, "MinIO", "MinIO", "storage", 9000),
      svc(1, "Portainer", "Portainer", "monitoring", 9443), svc(2, "PostgreSQL", "PostgreSQL", "database", 5432)],
  };
  if (t === "shared_db") return {
    servers: [srv("web-01", "proxy"), srv("app-01", "application"), srv("app-02", "application"), srv("db-shared", "database")],
    services: [svc(0, "Nginx", "Nginx", "proxy", 443), svc(1, `${code} API`, "API (node 1)", "api", 8080), svc(2, `${code} API`, "API (node 2)", "api", 8080),
      svc(3, "PostgreSQL", "PostgreSQL (shared)", "database", 5432)],
  };
  return { servers: [srv("srv-01", "combined")], services: [] };
}

/** proxy → ui/api; ui → api; api/worker → database/cache/queue/storage (same environment group) */
function autoDeps(services: WService[]) {
  const deps: { from_index: number; to_index: number }[] = [];
  services.forEach((a, i) => services.forEach((b, j) => {
    if (i === j) return;
    const link = (a.service_type === "proxy" && ["ui", "api"].includes(b.service_type)) ||
      (a.service_type === "ui" && b.service_type === "api" && a.server_index === b.server_index) ||
      (["api", "worker"].includes(a.service_type) && ["database", "cache", "queue", "storage"].includes(b.service_type));
    if (link) deps.push({ from_index: i, to_index: j });
  }));
  return deps;
}

function TemplateWizard({ client, onDone }: { client: Client; onDone: () => void }) {
  const { toast } = useUi();
  const lk = useLookups();
  const code = (client.code || client.name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "client";
  const [tpl, setTpl] = useState<string>(client.architecture_type === "custom" ? "three_tier" : client.architecture_type);
  const [env, setEnv] = useState("");
  const [{ servers, services }, setPlan] = useState(() => preset(tpl, code));
  const [busy, setBusy] = useState(false);

  const choose = (t: string) => { setTpl(t); setPlan(preset(t, code)); };
  const setSrv = (i: number, k: keyof WServer, v: string) => setPlan((p) => ({ ...p, servers: p.servers.map((s, j) => (j === i ? { ...s, [k]: v } : s)) }));
  const setSvc = (i: number, k: keyof WService, v: string | boolean | number) => setPlan((p) => ({ ...p, services: p.services.map((s, j) => (j === i ? { ...s, [k]: v } : s)) }));

  const submit = async () => {
    const envId = Number(env || lk.environments[0]?.id);
    if (!envId) return toast("Pick an environment", true);
    const active = services.filter((s) => s.on && s.application && s.component);
    setBusy(true);
    try {
      const r = await api.post<{ servers: number; services: number }>(`/clients/${client.id}/apply-template`, {
        template: tpl,
        servers: servers.map((s) => ({ ...s, environment_id: envId, private_ip: s.private_ip || null, public_ip: s.public_ip || null, vpn_ip: s.vpn_ip || null, ssh_user: s.ssh_user || null })),
        services: active.map((s) => ({ ...s, port: s.port ? Number(s.port) : null })),
        dependencies: autoDeps(active),
      });
      toast(`Created ${r.servers} servers and ${r.services} services`);
      onDone();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };

  const tiles: [string, string, string][] = [
    ["single", "A · Single server", "Nginx, UI, API, PostgreSQL, Redis on one box"],
    ["three_tier", "B · Three-tier", "Separate web/proxy, application and database servers"],
    ["shared_db", "C · Shared database", "Several app servers sharing one database server"],
    ["custom", "D · Custom", "Start empty and add what you need"],
  ];

  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="grid grid-4">
        {tiles.map(([k, t, d]) => (
          <button key={k} className="card card-pad client-card" onClick={() => choose(k)} style={{ outline: tpl === k ? "2px solid var(--primary)" : undefined }}>
            <b>{t}</b><div className="small muted" style={{ marginTop: 4 }}>{d}</div>
          </button>
        ))}
      </div>
      <div className="card card-pad grid" style={{ gap: 12 }}>
        <div className="row wrap">
          <h2 style={{ margin: 0 }}>1. Servers</h2><span className="spacer" />
          <label className="field" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>Environment
            <select value={env} onChange={(e) => setEnv(e.target.value)} style={{ width: 160 }}>{lk.environments.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select>
          </label>
          <button className="btn sm" onClick={() => setPlan((p) => ({ ...p, servers: [...p.servers, { name: `${code}-srv-${p.servers.length + 1}`, role: "application", private_ip: "", public_ip: "", vpn_ip: "", ssh_user: "ubuntu" }] }))}>+ Server</button>
        </div>
        <div className="table-wrap"><table className="tbl">
          <thead><tr><th>#</th><th>Name</th><th>Role</th><th>Private IP</th><th>Public IP</th><th>VPN / NetBird IP</th><th>SSH user</th><th /></tr></thead>
          <tbody>{servers.map((s, i) => (
            <tr key={i}><td>{i + 1}</td>
              <td><input value={s.name} onChange={(e) => setSrv(i, "name", e.target.value)} /></td>
              <td><select value={s.role} onChange={(e) => setSrv(i, "role", e.target.value)}>{ROLES.map((r) => <option key={r}>{r}</option>)}</select></td>
              <td><input className="mono" placeholder="10.0.0.10" value={s.private_ip} onChange={(e) => setSrv(i, "private_ip", e.target.value)} /></td>
              <td><input className="mono" value={s.public_ip} onChange={(e) => setSrv(i, "public_ip", e.target.value)} /></td>
              <td><input className="mono" placeholder="100.x.x.x" value={s.vpn_ip} onChange={(e) => setSrv(i, "vpn_ip", e.target.value)} /></td>
              <td><input value={s.ssh_user} onChange={(e) => setSrv(i, "ssh_user", e.target.value)} style={{ width: 100 }} /></td>
              <td>{servers.length > 1 && <button className="icon-btn" onClick={() => setPlan((p) => ({ servers: p.servers.filter((_, j) => j !== i), services: p.services.filter((x) => x.server_index !== i).map((x) => ({ ...x, server_index: x.server_index > i ? x.server_index - 1 : x.server_index })) }))}>✕</button>}</td>
            </tr>
          ))}</tbody>
        </table></div>

        <div className="row"><h2 style={{ margin: 0 }}>2. Services</h2><span className="spacer" />
          <button className="btn sm" onClick={() => setPlan((p) => ({ ...p, services: [...p.services, { on: true, server_index: 0, application: "", component: "", service_type: "other", port: "" }] }))}>+ Service</button></div>
        <div className="table-wrap"><table className="tbl">
          <thead><tr><th /><th>On server</th><th>Application</th><th>Component</th><th>Type</th><th>Port</th></tr></thead>
          <tbody>{services.map((s, i) => (
            <tr key={i} style={{ opacity: s.on ? 1 : 0.45 }}>
              <td><input type="checkbox" checked={s.on} onChange={(e) => setSvc(i, "on", e.target.checked)} /></td>
              <td><select value={s.server_index} onChange={(e) => setSvc(i, "server_index", Number(e.target.value))}>{servers.map((x, j) => <option key={j} value={j}>{x.name}</option>)}</select></td>
              <td><input value={s.application} onChange={(e) => setSvc(i, "application", e.target.value)} /></td>
              <td><input value={s.component} onChange={(e) => setSvc(i, "component", e.target.value)} /></td>
              <td><select value={s.service_type} onChange={(e) => setSvc(i, "service_type", e.target.value)}>{Object.entries(SERVICE_STYLE).map(([k, v]) => <option key={k} value={k}>{v.icon} {v.label}</option>)}</select></td>
              <td><input className="mono" value={s.port} onChange={(e) => setSvc(i, "port", e.target.value)} style={{ width: 90 }} /></td>
            </tr>
          ))}</tbody>
        </table></div>
        <p className="small muted" style={{ margin: 0 }}>
          Nothing is assumed: only checked services are created, all values stay editable afterwards. Connections are suggested automatically
          (proxy → UI/API, API → database/cache/queue/storage) and can be changed in the diagram. Nothing is installed or changed on real servers.
        </p>
        <div className="row"><span className="spacer" /><button className="btn primary" disabled={busy} onClick={submit}>{busy ? "Creating…" : `Create ${servers.length} servers & ${services.filter((s) => s.on).length} services`}</button></div>
      </div>
    </div>
  );
}
