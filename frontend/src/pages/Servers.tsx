import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { PageHead } from "../components/Layout";
import { copyText } from "../components/PasswordGenerator";
import { Empty, EnvBadge, Field, Modal, StatusBadge, TagChips, TagPicker, useUi } from "../components/ui";
import { api, download } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useDebounced, useLoad, useLookups } from "../lib/hooks";
import type { Network, Server } from "../lib/types";

export const SERVER_STATUSES = ["Active", "Maintenance", "Inactive", "Decommissioned"];
const SERVER_TYPES = ["Application Server", "Database Server", "Docker Host", "Registry", "Load Balancer", "Monitoring", "Storage", "Bastion", "Other"];

export function ipOf(s: Server, type: Network["ip_type"]) {
  return s.networks.filter((n) => n.ip_type === type).map((n) => n.ip_address.split("/")[0]).join(", ");
}

export function Servers() {
  const { can } = useAuth();
  const { toast } = useUi();
  const lk = useLookups();
  const nav = useNavigate();
  const [sp] = useSearchParams();
  const [q, setQ] = useState("");
  const [env, setEnv] = useState(sp.get("environment_id") || "");
  const [status, setStatus] = useState("");
  const [tag, setTag] = useState("");
  const dq = useDebounced(q);
  const params = { q: dq, environment_id: env, status, tag_id: tag };
  const { data, reload } = useLoad(() => api.get<Server[]>("/servers", params), [dq, env, status, tag]);
  const [editing, setEditing] = useState<Server | "new" | null>(null);

  return (
    <>
      <PageHead title="Server Inventory" sub="All TagID servers across environments">
        <button className="btn" onClick={() => download("/servers/export", params).catch((e) => toast(e.message, true))}>⇩ Export CSV</button>
        {can("servers.create") && <button className="btn primary" onClick={() => setEditing("new")}>+ Add Server</button>}
      </PageHead>
      <div className="card">
        <div className="filters">
          <input type="search" placeholder="Search name, IP, hostname, purpose, owner…" value={q} onChange={(e) => setQ(e.target.value)} />
          <select value={env} onChange={(e) => setEnv(e.target.value)}><option value="">All environments</option>{lk.environments.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select>
          <select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Any status</option>{SERVER_STATUSES.map((s) => <option key={s}>{s}</option>)}</select>
          <select value={tag} onChange={(e) => setTag(e.target.value)}><option value="">All tags</option>{lk.tags.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
          <span className="spacer" />
          <span className="muted small" style={{ alignSelf: "center" }}>{data?.length ?? 0} servers</span>
        </div>
        <div className="table-wrap">
          <table className="tbl">
            <thead><tr><th>Server</th><th>Env</th><th>Type</th><th>Private IP</th><th>Public IP</th><th>CPU / RAM / Disk</th><th>OS</th><th>Docker</th><th>Purpose</th><th>Status</th></tr></thead>
            <tbody>
              {data?.map((s) => (
                <tr key={s.id} className="clickable" onClick={() => nav(`/servers/${s.id}`)}>
                  <td><b>{s.name}</b>{s.tags.length > 0 && <div style={{ marginTop: 3 }}><TagChips tags={s.tags} /></div>}</td>
                  <td><EnvBadge env={s.environment} /></td>
                  <td className="small">{s.server_type}</td>
                  <td className="mono">{ipOf(s, "private") || <span className="muted">—</span>}</td>
                  <td className="mono">{ipOf(s, "public") || <span className="muted">—</span>}</td>
                  <td className="small nowrap">
                    {s.spec?.cpu_cores ?? "–"} vCPU · {s.spec?.ram_gb != null ? `${+s.spec.ram_gb} GB` : "–"} · {s.spec?.disk_gb != null ? `${+s.spec.disk_gb} GB` : "–"}
                    {s.spec?.disk_usage_pct != null && <div className="bar" style={{ marginTop: 4, width: 120 }} title={`Disk ${+s.spec.disk_usage_pct}% used`}>
                      <div style={{ width: `${s.spec.disk_usage_pct}%`, background: +s.spec.disk_usage_pct > 85 ? "var(--danger)" : +s.spec.disk_usage_pct > 70 ? "var(--warn)" : "var(--ok)" }} /></div>}
                  </td>
                  <td className="small">{[s.os_name, s.os_version].filter(Boolean).join(" ") || "—"}</td>
                  <td className="mono small">{s.docker_version || "—"}</td>
                  <td className="small" style={{ maxWidth: 260 }}>{s.purpose}</td>
                  <td><StatusBadge status={s.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          {data && !data.length && <Empty>No servers found.</Empty>}
        </div>
      </div>
      {editing && <ServerForm initial={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={(s) => { setEditing(null); reload(); nav(`/servers/${s.id}`); }} />}
    </>
  );
}

const FACTS_CMD = `. /etc/os-release; echo "hostname=$(hostname -f)"; echo "os_name=$NAME"; echo "os_version=$VERSION_ID"; echo "kernel=$(uname -r)"; echo "arch=$(uname -m)"; echo "cpu=$(nproc)"; echo "ram_gb=$(awk '/MemTotal/{printf "%.0f",$2/1048576}' /proc/meminfo)"; echo "disk_gb=$(df -BG --output=size / | tail -1 | tr -dc 0-9)"; echo "disk_pct=$(df --output=pcent / | tail -1 | tr -dc 0-9)"; echo "docker=$(docker version --format '{{.Server.Version}}' 2>/dev/null)"; echo "compose=$(docker compose version --short 2>/dev/null)"; echo "ips=$(hostname -I)"`;

interface SF {
  name: string; hostname: string; environment_id: string; server_type: string; provider: string; location: string;
  os_name: string; os_version: string; kernel_version: string; architecture: string; docker_version: string;
  compose_version: string; status: string; owner: string; purpose: string; notes: string;
  cpu_cores: string; ram_gb: string; disk_gb: string; disk_usage_pct: string;
  networks: { ip_type: Network["ip_type"]; ip_address: string; label: string }[]; tag_ids: number[];
}

export function ServerForm({ initial, onClose, onSaved }: { initial: Server | null; onClose: () => void; onSaved: (s: Server) => void }) {
  const lk = useLookups();
  const { toast } = useUi();
  const [busy, setBusy] = useState(false);
  const [facts, setFacts] = useState(false);
  const [factsText, setFactsText] = useState("");
  const [f, setF] = useState<SF>(() => ({
    name: initial?.name || "", hostname: initial?.hostname || "", environment_id: String(initial?.environment.id || ""),
    server_type: initial?.server_type || "", provider: initial?.provider || "", location: initial?.location || "",
    os_name: initial?.os_name || "", os_version: initial?.os_version || "", kernel_version: initial?.kernel_version || "",
    architecture: initial?.architecture || "", docker_version: initial?.docker_version || "", compose_version: initial?.compose_version || "",
    status: initial?.status || "Active", owner: initial?.owner || "", purpose: initial?.purpose || "", notes: initial?.notes || "",
    cpu_cores: initial?.spec?.cpu_cores != null ? String(initial.spec.cpu_cores) : "", ram_gb: initial?.spec?.ram_gb != null ? String(+initial.spec.ram_gb) : "",
    disk_gb: initial?.spec?.disk_gb != null ? String(+initial.spec.disk_gb) : "",
    disk_usage_pct: initial?.spec?.disk_usage_pct != null ? String(+initial.spec.disk_usage_pct) : "",
    networks: initial?.networks.map((n) => ({ ip_type: n.ip_type, ip_address: n.ip_address.replace(/\/(32|128)$/, ""), label: n.label || "" })) || [{ ip_type: "private", ip_address: "", label: "" }],
    tag_ids: initial?.tags.map((t) => t.id) || [],
  }));
  const set = (k: keyof SF, v: SF[keyof SF]) => setF((p) => ({ ...p, [k]: v }));

  useEffect(() => {
    if (!initial && !f.environment_id && lk.environments.length === 1) set("environment_id", String(lk.environments[0].id));
  }, [lk.environments]); // eslint-disable-line react-hooks/exhaustive-deps

  const applyFacts = () => {
    const kv = Object.fromEntries(factsText.split("\n").map((l) => l.split(/=(.*)/s).map((x) => x?.trim())).filter((p) => p[0] && p[1]));
    const ips: string[] = (kv.ips || "").split(/\s+/).filter((ip: string) => ip && !ip.startsWith("172.17.") && !ip.includes(":"));
    setF((p) => ({
      ...p,
      hostname: kv.hostname || p.hostname, os_name: kv.os_name || p.os_name, os_version: kv.os_version || p.os_version,
      kernel_version: kv.kernel || p.kernel_version, architecture: kv.arch || p.architecture, cpu_cores: kv.cpu || p.cpu_cores,
      ram_gb: kv.ram_gb || p.ram_gb, disk_gb: kv.disk_gb || p.disk_gb, disk_usage_pct: kv.disk_pct || p.disk_usage_pct,
      docker_version: kv.docker || p.docker_version, compose_version: kv.compose || p.compose_version,
      networks: ips.length && !p.networks.some((n) => n.ip_address) ? ips.map((ip) => ({ ip_type: "private" as const, ip_address: ip, label: "" })) : p.networks,
    }));
    setFacts(false);
    toast("Server facts applied — review before saving");
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const num = (v: string) => (v === "" ? null : +v);
    const body = {
      ...f, environment_id: +f.environment_id,
      spec: { cpu_cores: num(f.cpu_cores), ram_gb: num(f.ram_gb), disk_gb: num(f.disk_gb), disk_usage_pct: num(f.disk_usage_pct) },
      networks: f.networks.filter((n) => n.ip_address.trim()).map((n) => ({ ...n, label: n.label || null })),
    };
    try {
      const s = initial ? await api.put<Server>(`/servers/${initial.id}`, body) : await api.post<Server>("/servers", body);
      toast(initial ? "Server updated" : "Server added");
      onSaved(s);
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };

  const netSet = (i: number, k: "ip_type" | "ip_address" | "label", v: string) =>
    set("networks", f.networks.map((n, j) => (j === i ? { ...n, [k]: v } : n)));

  return (
    <Modal wide title={initial ? `Edit ${initial.name}` : "Add server"} onClose={onClose}
      footer={<>
        <button type="button" className="btn" onClick={() => setFacts(true)}>⚡ Paste server facts</button>
        <span className="spacer" />
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" form="srv-form" disabled={busy}>{busy ? "Saving…" : "Save"}</button>
      </>}>
      <form id="srv-form" className="form-grid" onSubmit={submit}>
        <div className="form-section" style={{ borderTop: 0, marginTop: 0, paddingTop: 0 }}>Server details</div>
        <Field label="Server name" required><input required value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="srv-p-03-db" /></Field>
        <Field label="Hostname"><input value={f.hostname} onChange={(e) => set("hostname", e.target.value)} /></Field>
        <Field label="Environment" required>
          <select required value={f.environment_id} onChange={(e) => set("environment_id", e.target.value)}>
            <option value="">Select…</option>{lk.environments.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        </Field>
        <Field label="Server type" required>
          <input required list="server-types" value={f.server_type} onChange={(e) => set("server_type", e.target.value)} />
          <datalist id="server-types">{SERVER_TYPES.map((t) => <option key={t} value={t} />)}</datalist>
        </Field>
        <Field label="Provider"><input value={f.provider} onChange={(e) => set("provider", e.target.value)} placeholder="AWS, Azure, Hetzner, On-prem…" /></Field>
        <Field label="Location"><input value={f.location} onChange={(e) => set("location", e.target.value)} placeholder="ap-south-1 / Mumbai DC" /></Field>
        <Field label="Status"><select value={f.status} onChange={(e) => set("status", e.target.value)}>{SERVER_STATUSES.map((s) => <option key={s}>{s}</option>)}</select></Field>
        <Field label="Owner"><input value={f.owner} onChange={(e) => set("owner", e.target.value)} /></Field>

        <div className="form-section">Network</div>
        <div className="full grid" style={{ gap: 8 }}>
          {f.networks.map((n, i) => (
            <div key={i} className="row">
              <select value={n.ip_type} onChange={(e) => netSet(i, "ip_type", e.target.value)} style={{ width: 150 }}>
                <option value="private">Private IP</option><option value="public">Public IP</option><option value="network">Network IP</option><option value="management">Management</option>
              </select>
              <input className="mono" placeholder="10.80.0.13" value={n.ip_address} onChange={(e) => netSet(i, "ip_address", e.target.value)} />
              <input placeholder="Label (eth0, VPN…)" value={n.label} onChange={(e) => netSet(i, "label", e.target.value)} style={{ maxWidth: 200 }} />
              <button type="button" className="icon-btn" onClick={() => set("networks", f.networks.filter((_, j) => j !== i))}>✕</button>
            </div>
          ))}
          <div><button type="button" className="btn sm" onClick={() => set("networks", [...f.networks, { ip_type: "private", ip_address: "", label: "" }])}>+ Add IP</button></div>
        </div>

        <div className="form-section">CPU / RAM / Disk</div>
        <Field label="CPU cores"><input type="number" min={0} value={f.cpu_cores} onChange={(e) => set("cpu_cores", e.target.value)} /></Field>
        <Field label="RAM (GB)"><input type="number" min={0} step="0.5" value={f.ram_gb} onChange={(e) => set("ram_gb", e.target.value)} /></Field>
        <Field label="Disk (GB)"><input type="number" min={0} value={f.disk_gb} onChange={(e) => set("disk_gb", e.target.value)} /></Field>
        <Field label="Disk usage (%)"><input type="number" min={0} max={100} value={f.disk_usage_pct} onChange={(e) => set("disk_usage_pct", e.target.value)} /></Field>

        <div className="form-section">OS / Docker</div>
        <Field label="Operating system"><input value={f.os_name} onChange={(e) => set("os_name", e.target.value)} placeholder="Ubuntu" /></Field>
        <Field label="OS version"><input value={f.os_version} onChange={(e) => set("os_version", e.target.value)} placeholder="24.04" /></Field>
        <Field label="Kernel"><input className="mono" value={f.kernel_version} onChange={(e) => set("kernel_version", e.target.value)} /></Field>
        <Field label="Architecture"><input value={f.architecture} onChange={(e) => set("architecture", e.target.value)} placeholder="x86_64" /></Field>
        <Field label="Docker version"><input className="mono" value={f.docker_version} onChange={(e) => set("docker_version", e.target.value)} /></Field>
        <Field label="Compose version"><input className="mono" value={f.compose_version} onChange={(e) => set("compose_version", e.target.value)} /></Field>

        <div className="form-section">Purpose</div>
        <Field label="Purpose" full><input value={f.purpose} onChange={(e) => set("purpose", e.target.value)} placeholder="PostgreSQL / Redis / RabbitMQ / MinIO" /></Field>
        <Field label="Notes" full><textarea value={f.notes} onChange={(e) => set("notes", e.target.value)} /></Field>
        <Field label="Tags" full><TagPicker all={lk.tags} value={f.tag_ids} onChange={(v) => set("tag_ids", v)} /></Field>
      </form>

      {facts && (
        <Modal title="Paste server facts" onClose={() => setFacts(false)}
          footer={<><button className="btn" onClick={() => setFacts(false)}>Cancel</button><button className="btn primary" onClick={applyFacts}>Apply</button></>}>
          <p className="muted" style={{ marginTop: 0 }}>1. Run this on the server (read-only, no sudo needed):</p>
          <div className="row" style={{ alignItems: "flex-start" }}>
            <pre className="mono small" style={{ whiteSpace: "pre-wrap", wordBreak: "break-all", background: "var(--panel-2)", padding: 10, borderRadius: 8, margin: 0, flex: 1 }}>{FACTS_CMD}</pre>
            <button className="btn sm" onClick={() => copyText(FACTS_CMD, 0).then(() => toast("Command copied"))}>Copy</button>
          </div>
          <p className="muted">2. Paste the output here:</p>
          <textarea className="mono" rows={9} value={factsText} onChange={(e) => setFactsText(e.target.value)} placeholder={"hostname=srv-p-03-db\nos_name=Ubuntu\n…"} />
        </Modal>
      )}
    </Modal>
  );
}
