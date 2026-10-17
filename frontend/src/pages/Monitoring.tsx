import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { PageHead } from "../components/Layout";
import { ClientChip, Empty, EnvBadge, HealthBadge, timeAgo, useUi } from "../components/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useLoad } from "../lib/hooks";
import type { Domain, Server } from "../lib/types";
import { ipOf } from "./Servers";

interface MonitorCfg { enabled: boolean; interval_minutes: number; snapshot_hour: number; last_check_at: string | null }
const ORDER: Record<string, number> = { critical: 0, offline: 1, warning: 2, unknown: 3, healthy: 4 };

export function Monitoring() {
  const { can } = useAuth();
  const { toast } = useUi();
  const { data: servers, reload: rs } = useLoad(() => api.get<Server[]>("/servers"));
  const { data: domains, reload: rd } = useLoad(() => (can("clients.view") ? api.get<Domain[]>("/domains") : Promise.resolve([] as Domain[])));
  const { data: cfg, reload: rc } = useLoad(() => api.get<MonitorCfg>("/monitoring/settings"));
  const [f, setF] = useState<MonitorCfg | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setF(cfg), [cfg]);

  const checkAll = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ servers: number; domains: number }>("/monitoring/check", {});
      toast(`Checked ${r.servers} servers and ${r.domains} domains`);
      rs(); rd(); rc();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  const saveCfg = async () => {
    if (!f) return;
    await api.put("/monitoring/settings", { enabled: f.enabled, interval_minutes: f.interval_minutes, snapshot_hour: f.snapshot_hour })
      .then(() => (toast("Monitoring settings saved"), rc())).catch((e) => toast(e.message, true));
  };

  const counts = (servers || []).reduce<Record<string, number>>((a, s) => ({ ...a, [s.health_status]: (a[s.health_status] || 0) + 1 }), {});
  const sorted = [...(servers || [])].sort((a, b) => (ORDER[a.health_status] ?? 9) - (ORDER[b.health_status] ?? 9) || a.name.localeCompare(b.name));

  return (
    <>
      <PageHead title="Monitoring" sub="Lightweight reachability checks from this portal — no agents installed, nothing changed on servers">
        <button className="btn primary" disabled={busy} onClick={checkAll}>{busy ? "Checking…" : "📡 Check everything now"}</button>
      </PageHead>
      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        {(["healthy", "warning", "critical", "unknown"] as const).map((k) => (
          <div key={k} className={`card stat ${k === "critical" ? "danger" : k === "warning" ? "warn" : ""}`}>
            <div className="label">{k}</div><div className="value">{(counts[k] || 0) + (k === "critical" ? counts.offline || 0 : 0)}</div>
          </div>
        ))}
      </div>
      <div className="alert info" style={{ marginBottom: 16 }}>
        <b>How to read this:</b> servers are checked by opening a TCP connection to their SSH port (private → VPN → public IP); domains by an HTTPS request.
        <b> unknown</b> = no answer (firewall, VPN or really down — not proof of an outage). <b>warning</b> = host answers but the port is closed.
        For CPU/RAM/containers keep using your existing tools (Grafana, Uptime Kuma, Portainer).
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head"><h2>Servers</h2><span className="spacer" /><span className="small muted">{cfg?.last_check_at ? `Last automatic check ${timeAgo(cfg.last_check_at)}` : "Not checked yet"}</span></div>
        <div className="table-wrap">
          <table className="tbl">
            <thead><tr><th>Status</th><th>Server</th><th>Client</th><th>Env</th><th>Checked address</th><th>Detail</th><th>Checked</th></tr></thead>
            <tbody>{sorted.map((s) => (
              <tr key={s.id}>
                <td><HealthBadge status={s.health_status} /></td>
                <td><Link to={`/servers/${s.id}`}><b>{s.name}</b></Link><div className="small muted">{s.role}</div></td>
                <td><ClientChip client={s.client} /></td>
                <td><EnvBadge env={s.environment} /></td>
                <td className="mono small">{(ipOf(s, "private") || ipOf(s, "vpn") || ipOf(s, "public") || s.hostname || "—").split(",")[0]}:{s.ssh_port || 22}</td>
                <td className="small">{s.health_detail || "—"}</td>
                <td className="small muted">{timeAgo(s.health_checked_at)}</td>
              </tr>
            ))}</tbody>
          </table>
          {servers && !servers.length && <Empty>No servers.</Empty>}
        </div>
      </div>

      {domains && domains.length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-head"><h2>Domains</h2></div>
          <table className="tbl">
            <thead><tr><th>Status</th><th>Domain</th><th>Client</th><th>Detail</th><th>Checked</th></tr></thead>
            <tbody>{domains.map((d) => (
              <tr key={d.id}><td><HealthBadge status={d.health_status} /></td><td className="mono">{d.name}</td><td><ClientChip client={d.client} /></td>
                <td className="small">{d.health_detail || "—"}</td><td className="small muted">{timeAgo(d.health_checked_at)}</td></tr>
            ))}</tbody>
          </table>
        </div>
      )}

      {f && can("reports.manage") && (
        <div className="card card-pad row wrap" style={{ gap: 18 }}>
          <b>Automatic checks</b>
          <label className="check"><input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} /> enabled</label>
          <label className="check">every <input type="number" min={1} max={1440} value={f.interval_minutes} onChange={(e) => setF({ ...f, interval_minutes: +e.target.value })} style={{ width: 80 }} /> minutes</label>
          <label className="check">daily config snapshot at <input type="number" min={0} max={23} value={f.snapshot_hour} onChange={(e) => setF({ ...f, snapshot_hour: +e.target.value })} style={{ width: 70 }} />:00</label>
          <span className="spacer" />
          <button className="btn" onClick={saveCfg}>Save</button>
        </div>
      )}
    </>
  );
}
