import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { PageHead } from "../components/Layout";
import { copyText } from "../components/PasswordGenerator";
import { ClientChip, Empty, EnvBadge, Field, HealthBadge, Modal, StatusBadge, TagChips, TagPicker, useUi } from "../components/ui";
import { api, download } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useDebounced, useLoad, useLookups } from "../lib/hooks";
import type { Client, Network, Server } from "../lib/types";

export const SERVER_STATUSES = ["Active", "Maintenance", "Inactive", "Decommissioned"];
const SERVER_TYPES = ["Application Server", "Database Server", "Docker Host", "Registry", "Load Balancer", "Monitoring", "Storage", "Bastion", "Other"];

export function ipOf(s: Server, type: Network["ip_type"]) {
  return s.networks.filter((n) => n.ip_type === type).map((n) => n.ip_address.split("/")[0]).join(", ");
}

export const SERVER_ROLES = ["application", "database", "proxy", "combined", "storage", "monitoring", "other"];

export function Servers({ clientId, embedded }: { clientId?: number; embedded?: boolean } = {}) {
  const { can } = useAuth();
  const { toast } = useUi();
  const lk = useLookups();
  const nav = useNavigate();
  const [sp] = useSearchParams();
  const [q, setQ] = useState("");
  const [env, setEnv] = useState(sp.get("environment_id") || "");
  const [status, setStatus] = useState("");
  const [tag, setTag] = useState("");
  const [client, setClient] = useState(clientId ? String(clientId) : sp.get("client_id") || "");
  const dq = useDebounced(q);
  const params = { q: dq, environment_id: env, status, tag_id: tag, client_id: client };
  const { data, reload } = useLoad(() => api.get<Server[]>("/servers", params), [dq, env, status, tag, client]);
  const { data: clients } = useLoad(() => (embedded ? Promise.resolve([] as Client[]) : api.get<Client[]>("/clients").catch(() => [])));
  const [editing, setEditing] = useState<Server | "new" | null>(null);
  const [checking, setChecking] = useState(false);

  const checkNow = async () => {
    setChecking(true);
    try {
      await api.post("/monitoring/check", { server_ids: (data || []).map((s) => s.id), domain_ids: [] });
      toast("Status checked");
      reload();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setChecking(false);
    }
  };

  const actions = (
    <>
      <button className="btn" disabled={checking || !data?.length} onClick={checkNow}>{checking ? "Checking…" : "📡 Check status"}</button>
      <button className="btn" onClick={() => download("/servers/export", params).catch((e) => toast(e.message, true))}>⇩ Export CSV</button>
      {can("servers.create") && <button className="btn primary" onClick={() => setEditing("new")}>+ Add Server</button>}
    </>
  );

  return (
    <>
      {!embedded && <PageHead title="Server Inventory" sub="All servers across clients and environments">{actions}</PageHead>}
      <div className="card">
        <div className="filters">
          {embedded && <div className="row" style={{ width: "100%" }}><span className="spacer" />{actions}</div>}
          {!embedded && <select value={client} onChange={(e) => setClient(e.target.value)}><option value="">All clients</option>{clients?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>}
          <input type="search" placeholder="Search name, IP, hostname, purpose, owner…" value={q} onChange={(e) => setQ(e.target.value)} />
          <select value={env} onChange={(e) => setEnv(e.target.value)}><option value="">All environments</option>{lk.environments.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select>
          <select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Any status</option>{SERVER_STATUSES.map((s) => <option key={s}>{s}</option>)}</select>
          <select value={tag} onChange={(e) => setTag(e.target.value)}><option value="">All tags</option>{lk.tags.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
          <span className="spacer" />
          <span className="muted small" style={{ alignSelf: "center" }}>{data?.length ?? 0} servers</span>
        </div>
        <div className="table-wrap">
          <table className="tbl">
            <thead><tr><th>Server</th>{!embedded && <th>Client</th>}<th>Env</th><th>Role</th><th>Private IP</th><th>VPN / Public</th><th>CPU / RAM / Disk</th><th>OS</th><th>Docker</th><th>Reachability</th><th>Status</th></tr></thead>
            <tbody>
              {data?.map((s) => (
                <tr key={s.id} className="clickable" onClick={() => nav(`/servers/${s.id}`)}>
                  <td><b>{s.name}</b>{s.tags.length > 0 && <div style={{ marginTop: 3 }}><TagChips tags={s.tags} /></div>}</td>
                  {!embedded && <td><ClientChip client={s.client} /></td>}
                  <td><EnvBadge env={s.environment} /></td>
                  <td className="small"><span className="badge gray">{s.role}</span><div className="muted">{s.server_type}</div></td>
                  <td className="mono">{ipOf(s, "private") || <span className="muted">—</span>}</td>
                  <td className="mono small">{ipOf(s, "vpn") || "—"}<div>{ipOf(s, "public") || "—"}</div></td>
                  <td className="small nowrap">
                    {s.spec?.cpu_cores ?? "–"} vCPU · {s.spec?.ram_gb != null ? `${+s.spec.ram_gb} GB` : "–"} · {s.spec?.disk_gb != null ? `${+s.spec.disk_gb} GB` : "–"}
                    {s.spec?.disk_usage_pct != null && <div className="bar" style={{ marginTop: 4, width: 120 }} title={`Disk ${+s.spec.disk_usage_pct}% used`}>
                      <div style={{ width: `${s.spec.disk_usage_pct}%`, background: +s.spec.disk_usage_pct > 85 ? "var(--danger)" : +s.spec.disk_usage_pct > 70 ? "var(--warn)" : "var(--ok)" }} /></div>}
                  </td>
                  <td className="small">{[s.os_name, s.os_version].filter(Boolean).join(" ") || "—"}</td>
                  <td className="mono small">{s.docker_version || "—"}</td>
                  <td><HealthBadge status={s.health_status} detail={s.health_detail} at={s.health_checked_at} /></td>
                  <td><StatusBadge status={s.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          {data && !data.length && <Empty>No servers found.</Empty>}
        </div>
      </div>
      {editing && <ServerForm initial={editing === "new" ? null : editing} defaultClientId={clientId} onClose={() => setEditing(null)} onSaved={(s) => { setEditing(null); reload(); if (!embedded) nav(`/servers/${s.id}`); }} />}
    </>
  );
}

const FACTS_CMD = `. /etc/os-release; echo "hostname=$(hostname -f)"; echo "os_name=$NAME"; echo "os_version=$VERSION_ID"; echo "kernel=$(uname -r)"; echo "arch=$(uname -m)"; echo "cpu=$(nproc)"; echo "ram_gb=$(awk '/MemTotal/{printf "%.0f",$2/1048576}' /proc/meminfo)"; echo "disk_gb=$(df -BG --output=size / | tail -1 | tr -dc 0-9)"; echo "disk_pct=$(df --output=pcent / | tail -1 | tr -dc 0-9)"; echo "docker=$(docker version --format '{{.Server.Version}}' 2>/dev/null)"; echo "compose=$(docker compose version --short 2>/dev/null)"; echo "ips=$(hostname -I)"`;

interface SF {
  name: string; hostname: string; environment_id: string; client_id: string; role: string; server_type: string; provider: string; location: string;
  ssh_user: string; ssh_port: string; ssh_auth_method: string; ssh_key_ref: string; mount_points: string; exposed_ports: string;
  firewall_notes: string; backup_policy: string; recovery_instructions: string;
  os_name: string; os_version: string; kernel_version: string; architecture: string; docker_version: string;
  compose_version: string; status: string; owner: string; purpose: string; notes: string;
  cpu_cores: string; ram_gb: string; disk_gb: string; disk_usage_pct: string;
  networks: { ip_type: Network["ip_type"]; ip_address: string; label: string }[]; tag_ids: number[];
}

const TEXT_FIELDS = ["name", "hostname", "server_type", "role", "provider", "location", "os_name", "os_version", "kernel_version", "architecture",
  "docker_version", "compose_version", "status", "owner", "purpose", "notes", "ssh_user", "ssh_auth_method", "ssh_key_ref", "mount_points",
  "exposed_ports", "firewall_notes", "backup_policy", "recovery_instructions"] as const;

export function ServerForm({ initial, defaultClientId, onClose, onSaved }: { initial: Server | null; defaultClientId?: number; onClose: () => void; onSaved: (s: Server) => void }) {
  const { data: clients } = useLoad(() => api.get<Client[]>("/clients").catch(() => [] as Client[]));
  const [jsonOpen, setJsonOpen] = useState(false);
  const [jsonText, setJsonText] = useState("");
  const lk = useLookups();
  const { toast } = useUi();
  const [busy, setBusy] = useState(false);
  const [facts, setFacts] = useState(false);
  const [factsText, setFactsText] = useState("");
  const [f, setF] = useState<SF>(() => ({
    name: initial?.name || "", hostname: initial?.hostname || "", environment_id: String(initial?.environment.id || ""),
    client_id: String(initial?.client?.id || defaultClientId || ""), role: initial?.role || "combined",
    ssh_user: initial?.ssh_user || "", ssh_port: initial?.ssh_port ? String(initial.ssh_port) : "22", ssh_auth_method: initial?.ssh_auth_method || "",
    ssh_key_ref: initial?.ssh_key_ref || "", mount_points: initial?.mount_points || "", exposed_ports: initial?.exposed_ports || "",
    firewall_notes: initial?.firewall_notes || "", backup_policy: initial?.backup_policy || "", recovery_instructions: initial?.recovery_instructions || "",
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
      ...f, environment_id: +f.environment_id, client_id: f.client_id ? +f.client_id : null, ssh_port: f.ssh_port ? +f.ssh_port : null,
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
        <button type="button" className="btn" onClick={() => setJsonOpen(true)}>{"{ }"} Import JSON</button>
        <span className="spacer" />
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" form="srv-form" disabled={busy}>{busy ? "Saving…" : "Save"}</button>
      </>}>
      <form id="srv-form" className="form-grid" onSubmit={submit}>
        <div className="form-section" style={{ borderTop: 0, marginTop: 0, paddingTop: 0 }}>Server details</div>
        <Field label="Server name" required><input required value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="srv-p-03-db" /></Field>
        <Field label="Hostname"><input value={f.hostname} onChange={(e) => set("hostname", e.target.value)} /></Field>
        <Field label="Client">
          <select value={f.client_id} onChange={(e) => set("client_id", e.target.value)}>
            <option value="">— None —</option>{clients?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
        <Field label="Environment" required>
          <select required value={f.environment_id} onChange={(e) => set("environment_id", e.target.value)}>
            <option value="">Select…</option>{lk.environments.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        </Field>
        <Field label="Role" required>
          <select value={f.role} onChange={(e) => set("role", e.target.value)}>{SERVER_ROLES.map((r) => <option key={r}>{r}</option>)}</select>
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
                <option value="private">Private IP</option><option value="public">Public IP</option><option value="vpn">VPN / NetBird IP</option><option value="network">Network IP</option><option value="management">Management</option>
              </select>
              <input className="mono" placeholder="10.80.0.13" value={n.ip_address} onChange={(e) => netSet(i, "ip_address", e.target.value)} />
              <input placeholder="Label (eth0, VPN…)" value={n.label} onChange={(e) => netSet(i, "label", e.target.value)} style={{ maxWidth: 200 }} />
              <button type="button" className="icon-btn" onClick={() => set("networks", f.networks.filter((_, j) => j !== i))}>✕</button>
            </div>
          ))}
          <div><button type="button" className="btn sm" onClick={() => set("networks", [...f.networks, { ip_type: "private", ip_address: "", label: "" }])}>+ Add IP</button></div>
        </div>

        <div className="form-section">SSH access</div>
        <Field label="SSH user"><input className="mono" value={f.ssh_user} onChange={(e) => set("ssh_user", e.target.value)} placeholder="ubuntu" /></Field>
        <Field label="SSH port"><input type="number" min={1} max={65535} value={f.ssh_port} onChange={(e) => set("ssh_port", e.target.value)} /></Field>
        <Field label="Auth method"><select value={f.ssh_auth_method} onChange={(e) => set("ssh_auth_method", e.target.value)}><option value="">—</option><option value="key">SSH key</option><option value="password">Password</option><option value="key+password">Key + password</option></select></Field>
        <Field label="Private key reference"><input value={f.ssh_key_ref} onChange={(e) => set("ssh_key_ref", e.target.value)} placeholder="1Password: Snitch prod key / ~/.ssh/snitch.pem" /></Field>
        <p className="full small muted" style={{ margin: 0 }}>Store only where the key lives — never paste a private key here. SSH passwords go in Password Management.</p>

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

        <div className="form-section">Firewall, ports & storage</div>
        <Field label="Exposed ports" full><textarea rows={2} className="mono" value={f.exposed_ports} onChange={(e) => set("exposed_ports", e.target.value)} placeholder="22/tcp (VPN only), 80,443/tcp (public), 5432/tcp (app server only)" /></Field>
        <Field label="Firewall / network notes" full><textarea rows={2} value={f.firewall_notes} onChange={(e) => set("firewall_notes", e.target.value)} placeholder="UFW enabled, SG sg-0abc…, only NetBird for SSH" /></Field>
        <Field label="Mount points" full><textarea rows={2} className="mono" value={f.mount_points} onChange={(e) => set("mount_points", e.target.value)} placeholder="/ 100G, /data 500G (EBS gp3)" /></Field>

        <div className="form-section">Backup & recovery</div>
        <Field label="Backup policy" full><textarea rows={2} value={f.backup_policy} onChange={(e) => set("backup_policy", e.target.value)} placeholder="Daily snapshot 02:00, 14 days" /></Field>
        <Field label="Recovery instructions" full><textarea rows={3} value={f.recovery_instructions} onChange={(e) => set("recovery_instructions", e.target.value)} placeholder="1. Launch from latest AMI… 2. Attach /data volume… 3. docker compose up -d" /></Field>

        <div className="form-section">Purpose</div>
        <Field label="Purpose" full><input value={f.purpose} onChange={(e) => set("purpose", e.target.value)} placeholder="PostgreSQL / Redis / RabbitMQ / MinIO" /></Field>
        <Field label="Notes" full><textarea value={f.notes} onChange={(e) => set("notes", e.target.value)} /></Field>
        <Field label="Tags" full><TagPicker all={lk.tags} value={f.tag_ids} onChange={(v) => set("tag_ids", v)} /></Field>
      </form>

      {jsonOpen && (
        <Modal title="Import server from JSON" onClose={() => setJsonOpen(false)}
          footer={<><button className="btn" onClick={() => setJsonOpen(false)}>Cancel</button><button className="btn primary" onClick={() => {
            try {
              const j = JSON.parse(jsonText);
              setF((p) => {
                const n = { ...p } as SF & Record<string, unknown>;
                for (const k of TEXT_FIELDS) if (j[k] != null) n[k] = String(j[k]);
                if (j.ssh_port != null) n.ssh_port = String(j.ssh_port);
                const sp = j.spec || {};
                for (const k of ["cpu_cores", "ram_gb", "disk_gb", "disk_usage_pct"] as const) if (sp[k] != null) n[k] = String(sp[k]);
                if (Array.isArray(j.networks)) n.networks = j.networks.map((x: { ip_type?: string; ip_address: string; label?: string }) => ({ ip_type: (x.ip_type || "private") as Network["ip_type"], ip_address: String(x.ip_address), label: x.label || "" }));
                const env = lk.environments.find((e) => e.name === (j.environment?.name || j.environment));
                if (env) n.environment_id = String(env.id);
                return n;
              });
              setJsonOpen(false);
              toast("Fields filled from JSON — review before saving");
            } catch {
              toast("Invalid JSON", true);
            }
          }}>Apply</button></>}>
          <p className="muted small" style={{ marginTop: 0 }}>Paste a server exported from this portal (server page → Export JSON) or an inventory entry. Fields are only filled into the form; nothing is saved until you click Save.</p>
          <textarea className="mono" rows={14} value={jsonText} onChange={(e) => setJsonText(e.target.value)} placeholder={'{"name": "snitch-app", "role": "application", "networks": [{"ip_type": "private", "ip_address": "10.10.0.11"}]}'} />
        </Modal>
      )}

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
