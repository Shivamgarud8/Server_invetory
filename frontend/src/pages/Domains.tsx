import { useState, type FormEvent } from "react";
import { PageHead } from "../components/Layout";
import { ClientChip, Empty, EnvBadge, Field, HealthBadge, Modal, fmtDate, useUi } from "../components/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useDebounced, useLoad, useLookups } from "../lib/hooks";
import type { Client, Domain, Server } from "../lib/types";

export function Domains() {
  return (
    <>
      <PageHead title="Domains & DNS" sub="Which domain points where — mapped to clients and servers" />
      <DomainsTable />
    </>
  );
}

export function DomainsTable({ clientId }: { clientId?: number }) {
  const { can } = useAuth();
  const { toast, confirm } = useUi();
  const [q, setQ] = useState("");
  const dq = useDebounced(q);
  const { data, reload } = useLoad(() => api.get<Domain[]>("/domains", { client_id: clientId, q: dq }), [clientId, dq]);
  const [editing, setEditing] = useState<Domain | "new" | null>(null);

  const remove = async (d: Domain) => {
    if (!(await confirm(`Delete domain ${d.name}?`))) return;
    await api.del(`/domains/${d.id}`).then(reload).catch((e) => toast(e.message, true));
  };
  const check = async () => {
    await api.post("/monitoring/check", { server_ids: [], domain_ids: (data || []).map((d) => d.id) }).then(() => (toast("Domains checked"), reload())).catch((e) => toast(e.message, true));
  };

  return (
    <div className="card">
      <div className="filters">
        <input type="search" placeholder="Search domains…" value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="spacer" />
        <button className="btn" onClick={check} disabled={!data?.length}>📡 Check HTTPS now</button>
        {can("clients.create") && <button className="btn primary" onClick={() => setEditing("new")}>+ Add domain</button>}
      </div>
      <div className="table-wrap">
        <table className="tbl">
          <thead><tr><th>Domain</th>{!clientId && <th>Client</th>}<th>Record</th><th>Server</th><th>Env</th><th>DNS / SSL</th><th>Status</th><th /></tr></thead>
          <tbody>{data?.map((d) => (
            <tr key={d.id}>
              <td><b>🌐 {d.name}</b>{d.purpose && <div className="small muted">{d.purpose}</div>}</td>
              {!clientId && <td><ClientChip client={d.client} /></td>}
              <td className="mono small">{d.record_type} → {d.target || "—"}</td>
              <td>{d.server?.name || "—"}</td>
              <td>{d.environment ? <EnvBadge env={d.environment} /> : "—"}</td>
              <td className="small">{d.dns_provider || "—"} / {d.ssl_provider || "—"}{d.ssl_expires_at && <div className="muted">SSL until {fmtDate(d.ssl_expires_at)}</div>}</td>
              <td><HealthBadge status={d.health_status} detail={d.health_detail} at={d.health_checked_at} /></td>
              <td className="right nowrap">
                {can("clients.update") && <button className="icon-btn" onClick={() => setEditing(d)}>✎</button>}
                {can("clients.delete") && <button className="icon-btn" onClick={() => remove(d)}>🗑</button>}
              </td>
            </tr>
          ))}</tbody>
        </table>
        {data && !data.length && <Empty>No domains recorded.</Empty>}
      </div>
      {editing && <DomainForm initial={editing === "new" ? null : editing} clientId={clientId} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />}
    </div>
  );
}

function DomainForm({ initial, clientId, onClose, onSaved }: { initial: Domain | null; clientId?: number; onClose: () => void; onSaved: () => void }) {
  const { toast } = useUi();
  const lk = useLookups();
  const { data: clients } = useLoad(() => api.get<Client[]>("/clients"));
  const { data: servers } = useLoad(() => api.get<Server[]>("/servers"));
  const [f, setF] = useState({
    name: initial?.name || "", client_id: String(initial?.client?.id || clientId || ""), environment_id: String(initial?.environment?.id || ""),
    server_id: String(initial?.server?.id || ""), record_type: initial?.record_type || "A", target: initial?.target || "",
    dns_provider: initial?.dns_provider || "", ssl_provider: initial?.ssl_provider || "", ssl_expires_at: initial?.ssl_expires_at || "",
    purpose: initial?.purpose || "", notes: initial?.notes || "",
  });
  const set = (k: keyof typeof f, v: string) => setF((p) => ({ ...p, [k]: v }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body = { ...f, client_id: f.client_id ? +f.client_id : null, environment_id: f.environment_id ? +f.environment_id : null,
      server_id: f.server_id ? +f.server_id : null, ssl_expires_at: f.ssl_expires_at || null };
    try {
      if (initial) await api.put(`/domains/${initial.id}`, body);
      else await api.post("/domains", body);
      toast("Domain saved");
      onSaved();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  const visible = servers?.filter((s) => !f.client_id || s.client?.id === +f.client_id) || [];
  return (
    <Modal title={initial ? `Edit ${initial.name}` : "Add domain"} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" form="df">Save</button></>}>
      <form id="df" className="form-grid" onSubmit={submit}>
        <Field label="Domain" required full><input required className="mono" value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="shop.snitch.com" /></Field>
        <Field label="Client"><select value={f.client_id} onChange={(e) => set("client_id", e.target.value)}><option value="">—</option>{clients?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
        <Field label="Points to server"><select value={f.server_id} onChange={(e) => set("server_id", e.target.value)}><option value="">—</option>{visible.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.environment.name})</option>)}</select></Field>
        <Field label="Record type"><select value={f.record_type} onChange={(e) => set("record_type", e.target.value)}>{["A", "AAAA", "CNAME", "ALIAS", "MX", "TXT", "NS", "SRV", "OTHER"].map((r) => <option key={r}>{r}</option>)}</select></Field>
        <Field label="Target (IP / host)"><input className="mono" value={f.target} onChange={(e) => set("target", e.target.value)} placeholder="auto from server's public IP" /></Field>
        <Field label="Environment"><select value={f.environment_id} onChange={(e) => set("environment_id", e.target.value)}><option value="">auto from server</option>{lk.environments.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></Field>
        <Field label="DNS provider"><input value={f.dns_provider} onChange={(e) => set("dns_provider", e.target.value)} placeholder="Cloudflare, Route53, GoDaddy…" /></Field>
        <Field label="SSL provider"><input value={f.ssl_provider} onChange={(e) => set("ssl_provider", e.target.value)} placeholder="Let's Encrypt, Cloudflare…" /></Field>
        <Field label="SSL expires"><input type="date" value={f.ssl_expires_at} onChange={(e) => set("ssl_expires_at", e.target.value)} /></Field>
        <Field label="Purpose" full><input value={f.purpose} onChange={(e) => set("purpose", e.target.value)} placeholder="Customer storefront / admin panel / API" /></Field>
        <Field label="Notes" full><textarea value={f.notes} onChange={(e) => set("notes", e.target.value)} /></Field>
      </form>
    </Modal>
  );
}
