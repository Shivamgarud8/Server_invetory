import { Link } from "react-router-dom";
import { PageHead } from "../components/Layout";
import { EnvBadge, timeAgo } from "../components/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useLoad } from "../lib/hooks";

interface Dash {
  environments: { id: number; name: string; color: string }[];
  cards: Record<string, number>;
  servers_by_env?: Record<string, number>;
  recent_servers?: { id: number; name: string; environment: string; color: string; created_at: string }[];
  expiring?: { id: number; name: string; environment: string; color: string; expires_at: string; days_left: number }[];
  recent_password_changes?: { id: number; name: string; environment: string; color: string; changed_at: string }[];
  recent_versions?: { application: string; component: string; server: string | null; environment: string; old: string | null; new: string; by: string; at: string }[];
  recent_activity?: { id: number; at: string; user: string; action: string; label: string | null; ip: string | null }[];
  health?: Record<string, number>;
  rotations?: { id: number; name: string; client: string | null; due: string; days_left: number }[];
  last_backup_at?: string | null;
  next_report_at?: string | null;
  report_schedule?: string;
}

function Stat({ label, value, sub, tone, to }: { label: string; value?: number; sub?: string; tone?: "warn" | "danger"; to?: string }) {
  if (value === undefined) return null;
  const body = (
    <div className={`card stat ${value > 0 && tone ? tone : ""}`}>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
  return to ? <Link to={to} style={{ textDecoration: "none", color: "inherit" }}>{body}</Link> : body;
}

const ACTION_TONE: Record<string, string> = {
  PASSWORD_VIEWED: "warn", PASSWORD_COPIED: "warn", LOGIN_FAILED: "danger", ACCOUNT_LOCKED: "danger",
  USER_DELETED: "danger", SERVER_DELETED: "danger", CREDENTIAL_DELETED: "danger",
};

export function ActionBadge({ action }: { action: string }) {
  const tone = ACTION_TONE[action] || (action.endsWith("_CREATED") ? "ok" : action === "LOGIN" ? "primary" : "gray");
  return <span className={`badge ${tone}`}>{action}</span>;
}

export function Dashboard() {
  const { me } = useAuth();
  const { data: d } = useLoad(() => api.get<Dash>("/dashboard"));
  if (!d) return null;
  const c = d.cards;
  const maxEnv = Math.max(1, ...Object.values(d.servers_by_env || {}));

  return (
    <>
      <PageHead title={`Welcome back, ${me?.full_name?.split(" ")[0] || me?.username}`} sub="TagID infrastructure at a glance" />

      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Stat label="Clients" value={c.clients} to="/clients" />
        <Stat label="Servers" value={c.servers} to="/servers"
          sub={d.health ? `${d.health.healthy || 0} healthy · ${(d.health.critical || 0) + (d.health.offline || 0)} offline · ${d.health.unknown || 0} unknown` : undefined} />
        <Stat label="Credentials" value={c.credentials} to="/credentials" />
        <Stat label="Applications" value={c.applications} sub={c.versions !== undefined ? `${c.deployments} deployments · ${c.versions} versions` : undefined} to="/versions" />
        <Stat label="Active users" value={c.users} sub={c.users_without_mfa ? `${c.users_without_mfa} without 2FA` : undefined} to="/users" />
        <Stat label="Expiring ≤ 30 days" value={c.credentials_expiring} tone="warn" to="/credentials?expiring=1" />
        <Stat label="Expired credentials" value={c.credentials_expired} tone="danger" to="/credentials?expiring=1" />
        <Stat label="Passwords > 90 days old" value={c.credentials_stale} tone="warn" sub="Consider rotating" />
        <Stat label="Rotations overdue" value={c.rotations_overdue} tone="danger" to="/credentials?rotation=due" />
        <Stat label="Rotations due ≤ 30 days" value={c.rotations_upcoming} tone="warn" to="/credentials?rotation=due" />
        <Stat label="Changes to verify" value={c.pending_verification} tone="warn" sub="Changed in portal, confirm on server" to="/credentials?rotation=pending" />
        <Stat label="Failed logins (24h)" value={c.failed_logins_24h} tone="danger" to="/audit?action=LOGIN_FAILED" />
        <Stat label="Password views (24h)" value={c.password_views_24h} to="/audit?action=PASSWORD_VIEWED" />
      </div>

      <div className="grid grid-2" style={{ marginBottom: 16 }}>
        <div className="card card-pad row wrap" style={{ gap: 10 }}>
          <span style={{ fontSize: 22 }}>🛟</span>
          <div><div className="small muted">Last configuration backup</div><b>{d.last_backup_at ? `${timeAgo(d.last_backup_at)}` : "none yet"}</b></div>
          <span className="spacer" /><Link to="/backup" className="btn sm">Backup & recovery</Link>
        </div>
        <div className="card card-pad row wrap" style={{ gap: 10 }}>
          <span style={{ fontSize: 22 }}>✉</span>
          <div><div className="small muted">Next email report</div><b>{d.next_report_at ? new Date(d.next_report_at).toLocaleString() : "not scheduled"}</b>
            {d.report_schedule && <div className="small muted">{d.report_schedule}</div>}</div>
          <span className="spacer" /><Link to="/reports" className="btn sm">Email & reports</Link>
        </div>
      </div>

      <div className="grid grid-2">
        {d.rotations && d.rotations.length > 0 && (
          <div className="card">
            <div className="card-head"><h2>Credential rotations</h2><span className="spacer" /><Link to="/credentials?rotation=due" className="small">View all</Link></div>
            <ul className="feed">
              {d.rotations.map((r) => (
                <li key={r.id}>
                  <span style={{ flex: 1 }}>{r.name}{r.client && <span className="muted"> · {r.client}</span>}</span>
                  <span className={`badge ${r.days_left < 0 ? "danger" : "warn"}`}>{r.days_left < 0 ? `overdue ${-r.days_left}d` : `in ${r.days_left}d`}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {d.servers_by_env && (
          <div className="card">
            <div className="card-head"><h2>Servers by environment</h2></div>
            <div className="card-pad grid" style={{ gap: 12 }}>
              {d.environments.map((e) => {
                const n = d.servers_by_env![String(e.id)] || 0;
                return (
                  <Link key={e.id} to={`/servers?environment_id=${e.id}`} className="row" style={{ color: "inherit", textDecoration: "none" }}>
                    <span style={{ width: 90 }}><EnvBadge env={e} /></span>
                    <div className="bar" style={{ flex: 1 }}><div style={{ width: `${(n / maxEnv) * 100}%`, background: e.color }} /></div>
                    <b style={{ width: 32, textAlign: "right" }}>{n}</b>
                  </Link>
                );
              })}
            </div>
          </div>
        )}

        {d.expiring && (
          <div className="card">
            <div className="card-head"><h2>Credentials expiring soon</h2><span className="spacer" /><Link to="/credentials?expiring=1" className="small">View all</Link></div>
            <ul className="feed">
              {d.expiring.map((x) => (
                <li key={x.id}>
                  <EnvBadge env={{ name: x.environment, color: x.color }} />
                  <span style={{ flex: 1 }}>{x.name}</span>
                  <span className={`badge ${x.days_left < 0 ? "danger" : "warn"}`}>{x.days_left < 0 ? `expired ${-x.days_left}d ago` : `${x.days_left}d left`}</span>
                </li>
              ))}
              {!d.expiring.length && <li className="muted">Nothing expiring in the next 30 days ✓</li>}
            </ul>
          </div>
        )}

        {d.recent_versions && (
          <div className="card">
            <div className="card-head"><h2>Recent version updates</h2><span className="spacer" /><Link to="/versions?tab=history" className="small">History</Link></div>
            <ul className="feed">
              {d.recent_versions.map((v, i) => (
                <li key={i}>
                  <span className="badge gray">{v.environment}</span>
                  <span style={{ flex: 1 }}><b>{v.application}</b> / {v.component}{v.server && <span className="muted"> @ {v.server}</span>}</span>
                  <span className="mono small">{v.old ? `${v.old} → ` : ""}<b>{v.new}</b></span>
                  <span className="muted small nowrap">{timeAgo(v.at)}</span>
                </li>
              ))}
              {!d.recent_versions.length && <li className="muted">No version changes yet</li>}
            </ul>
          </div>
        )}

        {d.recent_password_changes && (
          <div className="card">
            <div className="card-head"><h2>Recently changed passwords</h2></div>
            <ul className="feed">
              {d.recent_password_changes.map((x) => (
                <li key={x.id}><EnvBadge env={{ name: x.environment, color: x.color }} /><span style={{ flex: 1 }}>{x.name}</span><span className="muted small">{timeAgo(x.changed_at)}</span></li>
              ))}
              {!d.recent_password_changes.length && <li className="muted">No passwords stored yet</li>}
            </ul>
          </div>
        )}

        {d.recent_servers && (
          <div className="card">
            <div className="card-head"><h2>Recently added servers</h2></div>
            <ul className="feed">
              {d.recent_servers.map((s) => (
                <li key={s.id}><EnvBadge env={{ name: s.environment, color: s.color }} /><Link to={`/servers/${s.id}`} style={{ flex: 1 }}>{s.name}</Link><span className="muted small">{timeAgo(s.created_at)}</span></li>
              ))}
              {!d.recent_servers.length && <li className="muted">No servers yet — <Link to="/servers">add one</Link></li>}
            </ul>
          </div>
        )}

        {d.recent_activity && (
          <div className="card">
            <div className="card-head"><h2>Security & audit events</h2><span className="spacer" /><Link to="/audit" className="small">Audit log</Link></div>
            <ul className="feed">
              {d.recent_activity.map((a) => (
                <li key={a.id}>
                  <ActionBadge action={a.action} />
                  <span style={{ flex: 1 }}><b>{a.user || "—"}</b> {a.label && <span className="muted">· {a.label}</span>}</span>
                  <span className="muted small nowrap">{timeAgo(a.at)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </>
  );
}
