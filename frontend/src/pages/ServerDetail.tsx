import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { PageHead } from "../components/Layout";
import { SecretCell } from "../components/SecretCell";
import { Empty, EnvBadge, StatusBadge, TagChips, fmtDate, timeAgo, useUi } from "../components/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useLoad } from "../lib/hooks";
import type { AuditEntry, Credential, Deployment, Server } from "../lib/types";
import { ServerForm, ipOf } from "./Servers";

export function ServerDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const { can } = useAuth();
  const { toast, confirm } = useUi();
  const { data: s, error, reload } = useLoad(() => api.get<Server>(`/servers/${id}`), [id]);
  const { data: creds } = useLoad(() => (can("credentials.view") ? api.get<Credential[]>("/credentials", { server_id: id }) : Promise.resolve([])), [id]);
  const { data: deps } = useLoad(() => (can("versions.view") ? api.get<Deployment[]>("/deployments", { server_id: id }) : Promise.resolve([])), [id]);
  const { data: history } = useLoad(
    () => (can("audit.view") ? api.get<{ items: AuditEntry[] }>("/audit-logs", { entity_type: "server", entity_id: id, page_size: 20 }).then((r) => r.items) : Promise.resolve([])),
    [id],
  );
  const [editing, setEditing] = useState(false);

  if (error) return <div className="card card-pad empty">{error}</div>;
  if (!s) return null;

  const remove = async () => {
    if (!(await confirm(`Delete server ${s.name}?`, <p>Linked credentials and deployments are kept but unlinked from this server.</p>))) return;
    try {
      await api.del(`/servers/${s.id}`);
      toast("Server deleted");
      nav("/servers");
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  const spec = s.spec;
  return (
    <>
      <PageHead title={s.name} sub={<span className="row wrap"><EnvBadge env={s.environment} /> <StatusBadge status={s.status} /> <span>{s.server_type}</span> <TagChips tags={s.tags} /></span>}>
        <Link to="/servers" className="btn">← Back</Link>
        {can("servers.delete") && <button className="btn danger" onClick={remove}>Delete</button>}
        {can("servers.update") && <button className="btn primary" onClick={() => setEditing(true)}>Edit</button>}
      </PageHead>

      <div className="grid grid-3" style={{ marginBottom: 16 }}>
        <div className="card stat"><div className="label">CPU</div><div className="value">{spec?.cpu_cores ?? "–"}</div><div className="sub">cores</div></div>
        <div className="card stat"><div className="label">RAM</div><div className="value">{spec?.ram_gb != null ? +spec.ram_gb : "–"}</div><div className="sub">GB</div></div>
        <div className="card stat">
          <div className="label">Disk</div><div className="value">{spec?.disk_gb != null ? +spec.disk_gb : "–"}</div>
          <div className="sub">GB{spec?.disk_usage_pct != null && ` · ${+spec.disk_usage_pct}% used`}</div>
          {spec?.disk_usage_pct != null && <div className="bar" style={{ marginTop: 6 }}><div style={{ width: `${spec.disk_usage_pct}%`, background: +spec.disk_usage_pct > 85 ? "var(--danger)" : +spec.disk_usage_pct > 70 ? "var(--warn)" : "var(--ok)" }} /></div>}
        </div>
      </div>

      <div className="grid grid-2">
        <div className="card card-pad">
          <h2>Server information</h2>
          <dl className="kv">
            <dt>Hostname</dt><dd className="mono">{s.hostname || "—"}</dd>
            <dt>Private IP</dt><dd className="mono">{ipOf(s, "private") || "—"}</dd>
            <dt>Public IP</dt><dd className="mono">{ipOf(s, "public") || "—"}</dd>
            <dt>Network IP</dt><dd className="mono">{ipOf(s, "network") || "—"}</dd>
            {ipOf(s, "management") && <><dt>Management</dt><dd className="mono">{ipOf(s, "management")}</dd></>}
            <dt>Provider</dt><dd>{s.provider || "—"}</dd>
            <dt>Location</dt><dd>{s.location || "—"}</dd>
            <dt>Owner</dt><dd>{s.owner || "—"}</dd>
            <dt>Purpose</dt><dd>{s.purpose || "—"}</dd>
            <dt>Notes</dt><dd style={{ whiteSpace: "pre-wrap" }}>{s.notes || "—"}</dd>
          </dl>
        </div>
        <div className="card card-pad">
          <h2>Operating system & runtime</h2>
          <dl className="kv">
            <dt>OS</dt><dd>{[s.os_name, s.os_version].filter(Boolean).join(" ") || "—"}</dd>
            <dt>Kernel</dt><dd className="mono">{s.kernel_version || "—"}</dd>
            <dt>Architecture</dt><dd>{s.architecture || "—"}</dd>
            <dt>Docker</dt><dd className="mono">{s.docker_version || "—"}</dd>
            <dt>Docker Compose</dt><dd className="mono">{s.compose_version || "—"}</dd>
            <dt>Added</dt><dd>{fmtDate(s.created_at, true)}</dd>
            <dt>Last updated</dt><dd>{fmtDate(s.updated_at, true)}</dd>
          </dl>
        </div>

        {can("credentials.view") && (
          <div className="card" style={{ gridColumn: "1 / -1" }}>
            <div className="card-head"><h2>Credentials on this server</h2><span className="spacer" /><Link to={`/credentials`} className="small">All credentials</Link></div>
            <div className="table-wrap">
              <table className="tbl">
                <thead><tr><th>Name</th><th>Type</th><th>Username</th><th>Port</th><th>Password</th><th>Changed</th></tr></thead>
                <tbody>{creds?.map((c) => (
                  <tr key={c.id}><td><b>{c.name}</b></td><td><span className="badge gray">{c.credential_type.name}</span></td><td className="mono">{c.username}</td><td className="mono">{c.port}</td>
                    <td><SecretCell credentialId={c.id} hasSecret={c.has_secret} /></td><td className="small muted">{timeAgo(c.password_changed_at)}</td></tr>
                ))}</tbody>
              </table>
              {creds && !creds.length && <Empty>No credentials linked to this server.</Empty>}
            </div>
          </div>
        )}

        {can("versions.view") && (
          <div className="card" style={{ gridColumn: "1 / -1" }}>
            <div className="card-head"><h2>Deployed applications</h2><span className="spacer" /><Link to="/versions" className="small">Version management</Link></div>
            <div className="table-wrap">
              <table className="tbl">
                <thead><tr><th>Application</th><th>Component</th><th>Version</th><th>Previous</th><th>Image</th><th>Deployed</th><th>By</th></tr></thead>
                <tbody>{deps?.map((d) => (
                  <tr key={d.id}><td><b>{d.application.name}</b></td><td>{d.component}</td><td className="mono"><b>{d.current_version}</b></td>
                    <td className="mono muted">{d.previous_version || "—"}</td><td className="mono small">{d.image || "—"}</td><td className="small">{fmtDate(d.deployed_at)}</td><td className="small">{d.updated_by_name}</td></tr>
                ))}</tbody>
              </table>
              {deps && !deps.length && <Empty>No applications tracked on this server.</Empty>}
            </div>
          </div>
        )}

        {can("audit.view") && history && history.length > 0 && (
          <div className="card" style={{ gridColumn: "1 / -1" }}>
            <div className="card-head"><h2>Change history</h2></div>
            <ul className="feed">
              {history.map((a) => (
                <li key={a.id}>
                  <span className="badge gray">{a.action}</span><b>{a.username}</b>
                  <span className="muted small" style={{ flex: 1 }}>{a.details && a.action === "SERVER_UPDATED" ? Object.keys(a.details).join(", ") : ""}</span>
                  <span className="muted small">{fmtDate(a.created_at, true)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      {editing && <ServerForm initial={s} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); reload(); }} />}
    </>
  );
}
