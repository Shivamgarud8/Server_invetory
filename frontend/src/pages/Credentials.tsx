import { useEffect, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { PageHead } from "../components/Layout";
import { GeneratorModal, GeneratorPanel, StrengthMeter, copyText } from "../components/PasswordGenerator";
import { SecretCell } from "../components/SecretCell";
import { ClientChip, Empty, EnvBadge, ExpiryBadge, Field, Modal, StatusBadge, TagChips, TagPicker, daysUntil, fmtDate, timeAgo, useUi } from "../components/ui";
import { api, download } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useDebounced, useLoad, useLookups } from "../lib/hooks";
import type { Client, Credential, Deployment, PasswordHistoryEntry, Server } from "../lib/types";

const STATUSES = ["Active", "Inactive", "Rotating", "Revoked"];

export function Credentials({ clientId, embedded }: { clientId?: number; embedded?: boolean } = {}) {
  const { can } = useAuth();
  const { toast, confirm } = useUi();
  const lk = useLookups();
  const [sp] = useSearchParams();
  const [q, setQ] = useState("");
  const [env, setEnv] = useState(sp.get("environment_id") || "");
  const [type, setType] = useState("");
  const [status, setStatus] = useState("");
  const [tag, setTag] = useState("");
  const [client, setClient] = useState(clientId ? String(clientId) : sp.get("client_id") || "");
  const [rotation, setRotation] = useState(sp.get("rotation") || "");
  const [expiring, setExpiring] = useState(sp.get("expiring") === "1");
  const dq = useDebounced(q);
  const params = { q: dq, environment_id: env, credential_type_id: type, status, tag_id: tag, expiring, client_id: client, rotation };
  const { data, reload } = useLoad(() => api.get<Credential[]>("/credentials", params), [dq, env, type, status, tag, expiring, client, rotation]);
  const { data: clients } = useLoad(() => (embedded ? Promise.resolve([] as Client[]) : api.get<Client[]>("/clients").catch(() => [] as Client[])));
  const [editing, setEditing] = useState<Credential | "new" | null>(null);
  const [viewing, setViewing] = useState<Credential | null>(null);
  const [rotating, setRotating] = useState<Credential | null>(null);

  const remove = async (c: Credential) => {
    if (!(await confirm(`Delete "${c.name}"?`, <p>The stored password and its history will be destroyed. This cannot be undone.</p>))) return;
    try {
      await api.del(`/credentials/${c.id}`);
      toast("Credential deleted");
      setViewing(null);
      reload();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  const verify = async (c: Credential) => {
    if (!(await confirm("Confirm the new password works on the real system?", <p>Only confirm after you changed it on <b>{c.server?.name || c.host || "the target"}</b> and logged in with it.</p>, false))) return;
    await api.post(`/credentials/${c.id}/verify`).then(() => (toast("Marked as verified"), reload())).catch((e) => toast(e.message, true));
  };

  const actions = (
    <>
      {can("credentials.export") && <button className="btn" onClick={() => download("/credentials/export", params).catch((e) => toast(e.message, true))}>⇩ Export CSV</button>}
      {can("credentials.create") && <button className="btn primary" onClick={() => setEditing("new")}>+ Add Credential</button>}
    </>
  );

  return (
    <>
      {!embedded && <PageHead title="Password Management" sub="Encrypted credentials per client, server and service. Every reveal, copy and change is audited.">{actions}</PageHead>}

      <div className="card">
        <div className="filters">
          {embedded && <div className="row" style={{ width: "100%" }}><span className="spacer" />{actions}</div>}
          <input type="search" placeholder="Search name, server, username, host, service…" value={q} onChange={(e) => setQ(e.target.value)} />
          {!embedded && <select value={client} onChange={(e) => setClient(e.target.value)}><option value="">All clients</option>{clients?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>}
          <select value={env} onChange={(e) => setEnv(e.target.value)}><option value="">All environments</option>{lk.environments.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select>
          <select value={type} onChange={(e) => setType(e.target.value)}><option value="">All types</option>{lk.types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
          <select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Any status</option>{STATUSES.map((s) => <option key={s}>{s}</option>)}</select>
          <select value={rotation} onChange={(e) => setRotation(e.target.value)}><option value="">Any rotation</option><option value="due">Rotation due / overdue</option><option value="pending">Awaiting verification</option></select>
          <select value={tag} onChange={(e) => setTag(e.target.value)}><option value="">All tags</option>{lk.tags.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
          <label className="check"><input type="checkbox" checked={expiring} onChange={(e) => setExpiring(e.target.checked)} /> Expiring / expired</label>
          <span className="spacer" />
          <span className="muted small" style={{ alignSelf: "center" }}>{data?.length ?? 0} credentials</span>
        </div>
        <div className="table-wrap">
          <table className="tbl">
            <thead><tr><th>Credential</th>{!embedded && <th>Client</th>}<th>Env</th><th>Type</th><th>Server / Service</th><th>Username</th><th>Password</th><th>Changed</th><th>Rotation</th><th>Status</th><th /></tr></thead>
            <tbody>
              {data?.map((c) => (
                <tr key={c.id} className="clickable" onClick={() => setViewing(c)}>
                  <td><b>{c.name}</b>{c.tags.length > 0 && <div style={{ marginTop: 3 }}><TagChips tags={c.tags} /></div>}</td>
                  {!embedded && <td><ClientChip client={c.client} /></td>}
                  <td><EnvBadge env={c.environment} /></td>
                  <td><span className="badge gray">{c.credential_type.name}</span></td>
                  <td className="small">{c.server ? <Link to={`/servers/${c.server.id}`} onClick={(e) => e.stopPropagation()}>{c.server.name}</Link> : null}
                    {c.linked_service && <div className="muted">📦 {c.linked_service.label}</div>}
                    <div className="mono muted">{c.host}{c.port ? `:${c.port}` : ""}</div></td>
                  <td className="mono">{c.username || <span className="muted">—</span>}</td>
                  <td><SecretCell credentialId={c.id} hasSecret={c.has_secret} /></td>
                  <td className="small muted nowrap" title={c.last_change_reason || ""}>{timeAgo(c.password_changed_at)}{c.history_count > 0 && <div>🕘 {c.history_count} previous</div>}</td>
                  <td><RotationBadge c={c} /></td>
                  <td><StatusBadge status={c.status} /><ExpiryBadge date={c.expires_at} /></td>
                  <td className="right nowrap" onClick={(e) => e.stopPropagation()}>
                    {c.pending_verification && can("credentials.update") && <button className="icon-btn" title="Confirm the new password works on the target" onClick={() => verify(c)}>✅</button>}
                    {can("credentials.update") && <button className="icon-btn key-btn" title="Generate & assign a new password" onClick={() => setRotating(c)}>🔑</button>}
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
        <Modal wide title={viewing.name} onClose={() => setViewing(null)} footer={<>
          {can("credentials.delete") && <button className="btn danger" onClick={() => remove(viewing)}>Delete</button>}
          <span className="spacer" />
          {can("credentials.update") && <button className="btn" onClick={() => { setRotating(viewing); setViewing(null); }}>🔑 New password</button>}
          {can("credentials.update") && <button className="btn primary" onClick={() => { setEditing(viewing); setViewing(null); }}>Edit</button>}
        </>}>
          <CredentialDetail c={viewing} />
          <PasswordHistory c={viewing} />
        </Modal>
      )}
      {rotating && <RotateModal c={rotating} onClose={() => setRotating(null)} onDone={() => { setRotating(null); reload(); }} />}
      {editing && <CredentialForm initial={editing === "new" ? null : editing} defaultClientId={clientId} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />}
    </>
  );
}

function RotationBadge({ c }: { c: Credential }) {
  if (c.pending_verification) return <span className="badge warn" title="Changed in the portal — confirm it was changed on the target">⏳ verify</span>;
  if (c.rotation_policy !== "periodic") return <span className="badge gray">static</span>;
  const d = daysUntil(c.next_rotation_at);
  if (d === null) return <span className="badge gray">every {c.rotation_interval_days}d</span>;
  if (d < 0) return <span className="badge danger">overdue {-d}d</span>;
  if (d <= 30) return <span className="badge warn">due in {d}d</span>;
  return <span className="badge ok" title={`every ${c.rotation_interval_days} days`}>{fmtDate(c.next_rotation_at)}</span>;
}

/** Key icon flow: generate (or type) → confirm with a reason → old password moves to the 5-version history. */
function RotateModal({ c, onClose, onDone }: { c: Credential; onClose: () => void; onDone: () => void }) {
  const { toast } = useUi();
  const [pw, setPw] = useState("");
  const [reason, setReason] = useState(c.rotation_policy === "periodic" ? "Scheduled rotation" : "");
  const [step, setStep] = useState<"generate" | "confirm">("generate");
  const [busy, setBusy] = useState(false);
  const assign = async () => {
    setBusy(true);
    try {
      await api.post(`/credentials/${c.id}/password`, { password: pw, reason });
      toast(c.has_secret ? "Password updated — previous version kept in history" : "Password saved");
      onDone();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal wide title={<span>🔑 New password — {c.name}</span>} onClose={onClose}
      footer={step === "confirm" ? <>
        <button className="btn" onClick={() => setStep("generate")}>← Back</button>
        <button className="btn primary" disabled={busy || !reason.trim()} onClick={assign}>{busy ? "Saving…" : "Assign password"}</button>
      </> : undefined}>
      {step === "generate" ? (
        <GeneratorPanel onUse={(p) => { setPw(p); setStep("confirm"); }} contextHint={[c.client?.name, c.server?.name, c.credential_type.name].filter(Boolean).join(" ")} />
      ) : (
        <div className="grid" style={{ gap: 12 }}>
          <div className="gen-output">{pw}</div>
          <StrengthMeter value={pw} />
          <Field label="Reason for change" required><input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Scheduled rotation / staff change / suspected exposure" /></Field>
          <div className="alert warn">
            This updates the password <b>stored in the portal</b> only. Change it on <b>{c.server?.name || c.host || "the target system"}</b> too,
            then click ✅ in the list to confirm it works. The current password is kept in the encrypted history (last 5 versions).
          </div>
        </div>
      )}
    </Modal>
  );
}

function PasswordHistory({ c }: { c: Credential }) {
  const { can } = useAuth();
  const { toast } = useUi();
  const { data } = useLoad(() => api.get<PasswordHistoryEntry[]>(`/credentials/${c.id}/history`), [c.id]);
  const [revealFor, setRevealFor] = useState<PasswordHistoryEntry | null>(null);
  const [pwd, setPwd] = useState("");
  const [shown, setShown] = useState<Record<number, string>>({});
  const reveal = async () => {
    if (!revealFor) return;
    try {
      const r = await api.post<{ password: string }>(`/credentials/${c.id}/history/${revealFor.id}/reveal`, { current_password: pwd });
      setShown((s) => ({ ...s, [revealFor.id]: r.password }));
      setTimeout(() => setShown((s) => { const n = { ...s }; delete n[revealFor.id]; return n; }), 20000);
      setRevealFor(null);
      setPwd("");
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  return (
    <div style={{ marginTop: 18 }}>
      <h3>🕘 Password history <span className="muted small">(last 5 versions · newest first)</span></h3>
      <div className="timeline">
        <div className="timeline-item current">
          <b>Current password</b> <span className="muted small">set {fmtDate(c.password_changed_at, true)}{c.last_change_reason ? ` · ${c.last_change_reason}` : ""}</span>
          {c.pending_verification && <span className="badge warn" style={{ marginLeft: 6 }}>awaiting verification</span>}
        </div>
        {data?.map((h, i) => (
          <div key={h.id} className="timeline-item">
            <div className="row wrap">
              <b>Version −{i + 1}</b>
              <span className="muted small">used {h.valid_from ? fmtDate(h.valid_from, true) : "?"} → {fmtDate(h.replaced_at, true)}</span>
              <span className="small">replaced by <b>{h.replaced_by || "?"}</b>{h.reason ? ` — ${h.reason}` : ""}</span>
              <span className="spacer" />
              {shown[h.id] ? <span className="secret"><span className="val shown">{shown[h.id]}</span></span>
                : can("credentials.view_history") && <button className="btn sm" onClick={() => setRevealFor(h)}>Reveal</button>}
            </div>
          </div>
        ))}
        {data && !data.length && <div className="muted small" style={{ padding: "6px 0" }}>No previous versions yet.</div>}
      </div>
      <p className="small muted" style={{ margin: "6px 0 0" }}>Old passwords are kept for audit and recovery only — they are never re-applied automatically and never included in exports.</p>
      {revealFor && (
        <Modal title="Confirm it's you" onClose={() => setRevealFor(null)} footer={<><button className="btn" onClick={() => setRevealFor(null)}>Cancel</button><button className="btn primary" onClick={reveal}>Reveal old password</button></>}>
          <p className="muted" style={{ marginTop: 0 }}>Viewing a previous password needs your login password. This is recorded in the audit log.</p>
          <Field label="Your password"><input type="password" autoFocus value={pwd} onChange={(e) => setPwd(e.target.value)} onKeyDown={(e) => e.key === "Enter" && reveal()} /></Field>
        </Modal>
      )}
    </div>
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
  client_id: string; service_id: string; rotation_policy: string; rotation_interval_days: string; next_rotation_at: string; change_reason: string;
}

function CredentialForm({ initial, defaultClientId, onClose, onSaved }: { initial: Credential | null; defaultClientId?: number; onClose: () => void; onSaved: () => void }) {
  const lk = useLookups();
  const { toast } = useUi();
  const { data: servers } = useLoad(() => api.get<Server[]>("/servers"));
  const { data: clients } = useLoad(() => api.get<Client[]>("/clients").catch(() => [] as Client[]));
  const { data: services } = useLoad(() => api.get<Deployment[]>("/deployments").catch(() => [] as Deployment[]));
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
    client_id: String(initial?.client?.id || defaultClientId || ""), service_id: String(initial?.linked_service?.id || ""),
    rotation_policy: initial?.rotation_policy || "static", rotation_interval_days: initial?.rotation_interval_days ? String(initial.rotation_interval_days) : "90",
    next_rotation_at: initial?.next_rotation_at || "", change_reason: "",
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
      client_id: p.client_id || (s?.client ? String(s.client.id) : ""),
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
      client_id: f.client_id ? +f.client_id : null, service_id: f.service_id ? +f.service_id : null,
      rotation_interval_days: f.rotation_policy === "periodic" ? +f.rotation_interval_days || null : null,
      next_rotation_at: f.rotation_policy === "periodic" ? f.next_rotation_at || null : null,
      change_reason: f.change_reason || null,
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
        <Field label="Client">
          <select value={f.client_id} onChange={(e) => set("client_id", e.target.value)}>
            <option value="">— None —</option>{clients?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
        <Field label="Service (application on the server)">
          <select value={f.service_id} onChange={(e) => set("service_id", e.target.value)}>
            <option value="">— Not linked to a service —</option>
            {services?.filter((d) => !f.server_id || d.server?.id === +f.server_id).map((d) => <option key={d.id} value={d.id}>{d.application.name} / {d.component}{d.server ? ` @ ${d.server.name}` : ""}</option>)}
          </select>
        </Field>
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
        <div className="form-section">Rotation policy</div>
        <Field label="Rotation">
          <select value={f.rotation_policy} onChange={(e) => set("rotation_policy", e.target.value)}>
            <option value="static">Static — does not rotate automatically</option>
            <option value="periodic">Periodic — must be rotated regularly</option>
          </select>
        </Field>
        {f.rotation_policy === "periodic" ? <>
          <Field label="Rotate every (days)"><input type="number" min={1} value={f.rotation_interval_days} onChange={(e) => set("rotation_interval_days", e.target.value)} /></Field>
          <Field label="Next rotation date"><input type="date" value={f.next_rotation_at} onChange={(e) => set("next_rotation_at", e.target.value)} /></Field>
          <p className="small muted" style={{ alignSelf: "end", margin: 0 }}>Empty = last change + interval. Dashboard and email reports warn 30 days ahead.</p>
        </> : <div />}
        {initial && changePw && <Field label="Reason for password change" full><input value={f.change_reason} onChange={(e) => set("change_reason", e.target.value)} placeholder="Scheduled rotation / staff change…" /></Field>}
        <div className="form-section">Validity</div>
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
