import { useEffect, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { PageHead } from "../components/Layout";
import { GeneratorModal, StrengthMeter, copyText } from "../components/PasswordGenerator";
import { SecretCell } from "../components/SecretCell";
import { Empty, EnvBadge, ExpiryBadge, Field, Modal, StatusBadge, TagChips, TagPicker, fmtDate, timeAgo, useUi } from "../components/ui";
import { api, download } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useDebounced, useLoad, useLookups } from "../lib/hooks";
import type { Credential, Server } from "../lib/types";

const STATUSES = ["Active", "Inactive", "Rotating", "Revoked"];

export function Credentials() {
  const { can } = useAuth();
  const { toast, confirm } = useUi();
  const lk = useLookups();
  const [sp] = useSearchParams();
  const [q, setQ] = useState("");
  const [env, setEnv] = useState(sp.get("environment_id") || "");
  const [type, setType] = useState("");
  const [status, setStatus] = useState("");
  const [tag, setTag] = useState("");
  const [expiring, setExpiring] = useState(sp.get("expiring") === "1");
  const dq = useDebounced(q);
  const params = { q: dq, environment_id: env, credential_type_id: type, status, tag_id: tag, expiring };
  const { data, reload } = useLoad(() => api.get<Credential[]>("/credentials", params), [dq, env, type, status, tag, expiring]);
  const [editing, setEditing] = useState<Credential | "new" | null>(null);
  const [viewing, setViewing] = useState<Credential | null>(null);

  const remove = async (c: Credential) => {
    if (!(await confirm(`Delete "${c.name}"?`, <p>The stored password will be destroyed. This cannot be undone.</p>))) return;
    try {
      await api.del(`/credentials/${c.id}`);
      toast("Credential deleted");
      setViewing(null);
      reload();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  return (
    <>
      <PageHead title="Password Management" sub="Encrypted credentials for servers and services. Every reveal and copy is audited.">
        {can("credentials.export") && <button className="btn" onClick={() => download("/credentials/export", params).catch((e) => toast(e.message, true))}>⇩ Export CSV</button>}
        {can("credentials.create") && <button className="btn primary" onClick={() => setEditing("new")}>+ Add Credential</button>}
      </PageHead>

      <div className="card">
        <div className="filters">
          <input type="search" placeholder="Search name, server, username, host, service…" value={q} onChange={(e) => setQ(e.target.value)} />
          <select value={env} onChange={(e) => setEnv(e.target.value)}><option value="">All environments</option>{lk.environments.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select>
          <select value={type} onChange={(e) => setType(e.target.value)}><option value="">All types</option>{lk.types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
          <select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Any status</option>{STATUSES.map((s) => <option key={s}>{s}</option>)}</select>
          <select value={tag} onChange={(e) => setTag(e.target.value)}><option value="">All tags</option>{lk.tags.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
          <label className="check"><input type="checkbox" checked={expiring} onChange={(e) => setExpiring(e.target.checked)} /> Expiring / expired</label>
          <span className="spacer" />
          <span className="muted small" style={{ alignSelf: "center" }}>{data?.length ?? 0} credentials</span>
        </div>
        <div className="table-wrap">
          <table className="tbl">
            <thead><tr><th>Credential</th><th>Env</th><th>Type</th><th>Server / Host</th><th>Username</th><th>Password</th><th>Changed</th><th>Expiry</th><th>Status</th><th /></tr></thead>
            <tbody>
              {data?.map((c) => (
                <tr key={c.id} className="clickable" onClick={() => setViewing(c)}>
                  <td><b>{c.name}</b>{c.tags.length > 0 && <div style={{ marginTop: 3 }}><TagChips tags={c.tags} /></div>}</td>
                  <td><EnvBadge env={c.environment} /></td>
                  <td><span className="badge gray">{c.credential_type.name}</span></td>
                  <td className="small">{c.server ? <Link to={`/servers/${c.server.id}`} onClick={(e) => e.stopPropagation()}>{c.server.name}</Link> : null}<div className="mono muted">{c.host}{c.port ? `:${c.port}` : ""}</div></td>
                  <td className="mono">{c.username || <span className="muted">—</span>}</td>
                  <td><SecretCell credentialId={c.id} hasSecret={c.has_secret} /></td>
                  <td className="small muted nowrap">{timeAgo(c.password_changed_at)}</td>
                  <td><ExpiryBadge date={c.expires_at} /></td>
                  <td><StatusBadge status={c.status} /></td>
                  <td className="right nowrap" onClick={(e) => e.stopPropagation()}>
                    {can("credentials.update") && <button className="icon-btn" title="Edit" onClick={() => setEditing(c)}>✎</button>}
                    {can("credentials.delete") && <button className="icon-btn" title="Delete" onClick={() => remove(c)}>🗑</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {data && !data.length && <Empty>No credentials match these filters.</Empty>}
        </div>
      </div>

      {viewing && (
        <Modal title={viewing.name} onClose={() => setViewing(null)} footer={<>
          {can("credentials.delete") && <button className="btn danger" onClick={() => remove(viewing)}>Delete</button>}
          <span className="spacer" />
          {can("credentials.update") && <button className="btn primary" onClick={() => { setEditing(viewing); setViewing(null); }}>Edit</button>}
        </>}>
          <CredentialDetail c={viewing} />
        </Modal>
      )}
      {editing && <CredentialForm initial={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />}
    </>
  );
}

function CopyBtn({ value }: { value: string | null }) {
  const { toast } = useUi();
  if (!value) return null;
  return <button className="icon-btn" title="Copy" onClick={() => copyText(value, 0).then(() => toast("Copied"))}>⧉</button>;
}

function CredentialDetail({ c }: { c: Credential }) {
  const sshCmd = c.username && (c.host || c.server) && ["SSH", "Root", "Server User"].includes(c.credential_type.name)
    ? `ssh ${c.port && c.port !== 22 ? `-p ${c.port} ` : ""}${c.username}@${c.host || c.server?.name}` : null;
  return (
    <dl className="kv">
      <dt>Environment</dt><dd><EnvBadge env={c.environment} /></dd>
      <dt>Type</dt><dd>{c.credential_type.name}{c.category ? ` · ${c.category}` : ""}</dd>
      <dt>Server</dt><dd>{c.server ? <Link to={`/servers/${c.server.id}`}>{c.server.name}</Link> : "—"}</dd>
      <dt>Host / IP</dt><dd className="mono">{c.host || "—"} <CopyBtn value={c.host} /></dd>
      <dt>Port</dt><dd className="mono">{c.port ?? "—"}</dd>
      <dt>Username</dt><dd className="mono">{c.username || "—"} <CopyBtn value={c.username} /></dd>
      <dt>Password</dt><dd><SecretCell credentialId={c.id} hasSecret={c.has_secret} /></dd>
      {sshCmd && <><dt>Connect</dt><dd className="mono">{sshCmd} <CopyBtn value={sshCmd} /></dd></>}
      <dt>URL</dt><dd>{c.url ? <a href={/^https?:\/\//.test(c.url) ? c.url : `https://${c.url}`} target="_blank" rel="noreferrer noopener">{c.url}</a> : "—"}</dd>
      <dt>Service</dt><dd>{c.service || "—"}</dd>
      <dt>Owner</dt><dd>{c.owner || "—"}</dd>
      <dt>Status</dt><dd><StatusBadge status={c.status} /></dd>
      <dt>Tags</dt><dd><TagChips tags={c.tags} /></dd>
      <dt>Description</dt><dd style={{ whiteSpace: "pre-wrap" }}>{c.description || "—"}</dd>
      <dt>Notes</dt><dd style={{ whiteSpace: "pre-wrap" }}>{c.notes || "—"}</dd>
      <dt>Password changed</dt><dd>{fmtDate(c.password_changed_at, true)}</dd>
      <dt>Expiry</dt><dd><ExpiryBadge date={c.expires_at} /></dd>
      <dt>Storage</dt><dd className="small muted">{c.secret_provider === "hashicorp" ? "HashiCorp Vault (KV v2)" : "AES-256-GCM encrypted"}</dd>
      <dt>Created / updated</dt><dd className="small muted">{fmtDate(c.created_at, true)} · {fmtDate(c.updated_at, true)}</dd>
    </dl>
  );
}

interface FormState {
  name: string; credential_type_id: string; category: string; server_id: string; environment_id: string; host: string;
  port: string; username: string; password: string; url: string; service: string; description: string; owner: string;
  status: string; expires_at: string; notes: string; tag_ids: number[];
}

function CredentialForm({ initial, onClose, onSaved }: { initial: Credential | null; onClose: () => void; onSaved: () => void }) {
  const lk = useLookups();
  const { toast } = useUi();
  const { data: servers } = useLoad(() => api.get<Server[]>("/servers"));
  const [gen, setGen] = useState(false);
  const [showPw, setShowPw] = useState(false);
  const [changePw, setChangePw] = useState(!initial);
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState<FormState>(() => ({
    name: initial?.name || "", credential_type_id: String(initial?.credential_type.id || ""), category: initial?.category || "",
    server_id: String(initial?.server?.id || ""), environment_id: String(initial?.environment.id || ""), host: initial?.host || "",
    port: initial?.port ? String(initial.port) : "", username: initial?.username || "", password: "", url: initial?.url || "",
    service: initial?.service || "", description: initial?.description || "", owner: initial?.owner || "",
    status: initial?.status || "Active", expires_at: initial?.expires_at || "", notes: initial?.notes || "",
    tag_ids: initial?.tags.map((t) => t.id) || [],
  }));
  const set = (k: keyof FormState, v: string | number[]) => setF((p) => ({ ...p, [k]: v }));

  useEffect(() => {
    if (!initial && !f.environment_id && lk.environments.length === 1) set("environment_id", String(lk.environments[0].id));
  }, [lk.environments]); // eslint-disable-line react-hooks/exhaustive-deps

  // Selecting a server pre-fills environment and IP
  const pickServer = (id: string) => {
    const s = servers?.find((x) => String(x.id) === id);
    setF((p) => ({
      ...p, server_id: id,
      environment_id: s ? String(s.environment.id) : p.environment_id,
      host: p.host || (s?.networks.find((n) => n.ip_type === "private")?.ip_address ?? s?.networks[0]?.ip_address ?? "").split("/")[0],
      name: p.name || (s ? `${s.name} ` : ""),
    }));
  };
  const pickType = (id: string) => {
    const t = lk.types.find((x) => String(x.id) === id);
    setF((p) => ({ ...p, credential_type_id: id, port: p.port || (t?.default_port ? String(t.default_port) : "") }));
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const body = {
      ...f,
      credential_type_id: +f.credential_type_id, environment_id: +f.environment_id,
      server_id: f.server_id ? +f.server_id : null, port: f.port ? +f.port : null,
      expires_at: f.expires_at || null, password: changePw && f.password ? f.password : null,
    };
    try {
      if (initial) await api.put(`/credentials/${initial.id}`, body);
      else await api.post("/credentials", body);
      toast(initial ? "Credential updated" : "Credential saved (encrypted)");
      onSaved();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal wide title={initial ? `Edit ${initial.name}` : "Add credential"} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" form="cred-form" disabled={busy}>{busy ? "Saving…" : "Save"}</button></>}>
      <form id="cred-form" className="form-grid" onSubmit={submit} autoComplete="off">
        <Field label="Server">
          <select value={f.server_id} onChange={(e) => pickServer(e.target.value)}>
            <option value="">— Not linked to a server —</option>
            {servers?.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.environment.name})</option>)}
          </select>
        </Field>
        <Field label="Credential type" required>
          <select required value={f.credential_type_id} onChange={(e) => pickType(e.target.value)}>
            <option value="">Select…</option>
            {lk.types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </Field>
        <Field label="Credential name" required><input required value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="srv-p-03-db Root" /></Field>
        <Field label="Environment" required>
          <select required value={f.environment_id} onChange={(e) => set("environment_id", e.target.value)}>
            <option value="">Select…</option>
            {lk.environments.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        </Field>

        <div className="form-section">Access</div>
        <Field label="Username"><input className="mono" value={f.username} onChange={(e) => set("username", e.target.value)} autoComplete="off" /></Field>
        <Field label="Password">
          {initial && !changePw ? (
            <div className="row"><span className="muted small">{initial.has_secret ? "Password stored — unchanged" : "No password stored"}</span><button type="button" className="btn sm" onClick={() => setChangePw(true)}>{initial.has_secret ? "Change password" : "Set password"}</button></div>
          ) : (
            <>
              <div className="input-group">
                <input className="mono" type={showPw ? "text" : "password"} value={f.password} onChange={(e) => set("password", e.target.value)} autoComplete="new-password" placeholder="Enter or generate" />
                <button type="button" className="btn" onClick={() => setShowPw(!showPw)} title="Show/hide">{showPw ? "🙈" : "👁"}</button>
                <button type="button" className="btn" onClick={() => setGen(true)}>🔑 Generate</button>
              </div>
              <StrengthMeter value={f.password} />
            </>
          )}
        </Field>
        <Field label="Host / IP"><input className="mono" value={f.host} onChange={(e) => set("host", e.target.value)} placeholder="10.80.0.13" /></Field>
        <Field label="Port"><input type="number" min={1} max={65535} value={f.port} onChange={(e) => set("port", e.target.value)} /></Field>
        <Field label="URL" full><input value={f.url} onChange={(e) => set("url", e.target.value)} placeholder="https://portainer.internal:9443" /></Field>

        <div className="form-section">Details</div>
        <Field label="Category"><input value={f.category} onChange={(e) => set("category", e.target.value)} placeholder="Server, Database, Cloud…" /></Field>
        <Field label="Service"><input value={f.service} onChange={(e) => set("service", e.target.value)} placeholder="postgres, redis, harbor…" /></Field>
        <Field label="Owner"><input value={f.owner} onChange={(e) => set("owner", e.target.value)} /></Field>
        <Field label="Status"><select value={f.status} onChange={(e) => set("status", e.target.value)}>{STATUSES.map((s) => <option key={s}>{s}</option>)}</select></Field>
        <Field label="Expiry date"><input type="date" value={f.expires_at} onChange={(e) => set("expires_at", e.target.value)} /></Field>
        <div />
        <Field label="Description" full><textarea value={f.description} onChange={(e) => set("description", e.target.value)} /></Field>
        <Field label="Notes" full><textarea value={f.notes} onChange={(e) => set("notes", e.target.value)} placeholder="Do not put passwords or keys here — notes are not encrypted." /></Field>
        <Field label="Tags" full><TagPicker all={lk.tags} value={f.tag_ids} onChange={(v) => set("tag_ids", v)} /></Field>
      </form>
      {gen && <GeneratorModal onClose={() => setGen(false)} onUse={(pw) => { set("password", pw); setChangePw(true); }} />}
    </Modal>
  );
}
