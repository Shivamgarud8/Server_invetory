import { useEffect, useState, type FormEvent } from "react";
import { PageHead } from "../components/Layout";
import { Empty, Field, fmtDate, useUi } from "../components/ui";
import { api } from "../lib/api";
import { useLoad } from "../lib/hooks";

interface EmailCfg {
  enabled: boolean; smtp_host: string; smtp_port: number; smtp_security: string; smtp_username: string; from_address: string; from_name: string;
  recipients: string[]; frequency: string; interval_days: number; weekday: number; send_time: string; timezone: string; anchor_date: string | null;
  include_inventory: boolean; include_health: boolean; include_rotations: boolean; attach_inventory_json: boolean; attach_encrypted_bundle: boolean;
  smtp_password_set: boolean; bundle_passphrase_set: boolean; next_run_at: string | null; schedule_text: string; last_sent_at: string | null;
  last_run: { at: string; status: string; detail: string } | null;
}
interface Run { id: number; created_at: string; kind: string; status: string; recipients: string; detail: string; triggered_by: string }

const PRESETS: Record<string, { host: string; port: number; security: string }> = {
  Gmail: { host: "smtp.gmail.com", port: 587, security: "starttls" },
  "Outlook / Microsoft 365": { host: "smtp.office365.com", port: 587, security: "starttls" },
  "Zoho": { host: "smtp.zoho.in", port: 465, security: "ssl" },
  "Amazon SES (ap-south-1)": { host: "email-smtp.ap-south-1.amazonaws.com", port: 587, security: "starttls" },
};
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export function Reports() {
  const { toast } = useUi();
  const { data: cfg, reload } = useLoad(() => api.get<EmailCfg>("/reports/email"));
  const { data: runs, reload: reloadRuns } = useLoad(() => api.get<Run[]>("/reports/runs"));
  const [f, setF] = useState<EmailCfg | null>(null);
  const [recipients, setRecipients] = useState("");
  const [smtpPw, setSmtpPw] = useState("");
  const [bundlePp, setBundlePp] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (cfg) {
      setF(cfg);
      setRecipients(cfg.recipients.join(", "));
    }
  }, [cfg]);
  if (!f) return null;
  const set = <K extends keyof EmailCfg>(k: K, v: EmailCfg[K]) => setF((p) => (p ? { ...p, [k]: v } : p));

  const save = async (e?: FormEvent) => {
    e?.preventDefault();
    setBusy("save");
    try {
      await api.put("/reports/email", {
        ...f, recipients: recipients.split(/[\s,;]+/).filter(Boolean), smtp_password: smtpPw || null, bundle_passphrase: bundlePp || null,
        anchor_date: f.anchor_date || null,
      });
      setSmtpPw("");
      setBundlePp("");
      toast("Email settings saved");
      reload();
      return true;
    } catch (e) {
      toast((e as Error).message, true);
      return false;
    } finally {
      setBusy(null);
    }
  };
  const action = async (path: string, label: string) => {
    if (!(await save())) return;
    setBusy(label);
    try {
      const r = await api.post<{ detail: string }>(path);
      toast(`${label}: ${r.detail}`);
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(null);
      reload();
      reloadRuns();
    }
  };

  return (
    <>
      <PageHead title="Email & Reports" sub="Scheduled infrastructure reports with the inventory attached — sent by the background scheduler even when nobody is logged in">
        <button className="btn" disabled={!!busy} onClick={() => action("/reports/test", "Test email")}>{busy === "Test email" ? "Sending…" : "✉ Send test email"}</button>
        <button className="btn primary" disabled={!!busy} onClick={() => action("/reports/send-now", "Report")}>{busy === "Report" ? "Sending…" : "📤 Send report now"}</button>
      </PageHead>

      <div className="grid grid-3" style={{ marginBottom: 16 }}>
        <div className="card stat"><div className="label">Schedule</div><div style={{ fontWeight: 700, marginTop: 6 }}>{cfg?.schedule_text}</div></div>
        <div className="card stat"><div className="label">Next report</div><div style={{ fontWeight: 700, marginTop: 6 }}>{cfg?.next_run_at ? fmtDate(cfg.next_run_at, true) : "—"}</div></div>
        <div className="card stat"><div className="label">Last delivery</div><div style={{ fontWeight: 700, marginTop: 6 }}>
          {cfg?.last_run ? <><span className={`badge ${cfg.last_run.status === "sent" ? "ok" : "danger"}`}>{cfg.last_run.status}</span> {fmtDate(cfg.last_run.at, true)}</> : "never"}</div>
          {cfg?.last_run?.status === "failed" && <div className="small" style={{ color: "var(--danger)" }}>{cfg.last_run.detail}</div>}
        </div>
      </div>

      <form className="grid grid-2" onSubmit={save}>
        <div className="card card-pad form-grid" style={{ alignContent: "start" }}>
          <div className="form-section" style={{ borderTop: 0, marginTop: 0, paddingTop: 0 }}>SMTP server</div>
          <div className="full row wrap" style={{ gap: 6 }}>
            <span className="small muted">Presets:</span>
            {Object.entries(PRESETS).map(([k, p]) => <button key={k} type="button" className="btn sm" onClick={() => setF((x) => (x ? { ...x, smtp_host: p.host, smtp_port: p.port, smtp_security: p.security } : x))}>{k}</button>)}
          </div>
          <Field label="SMTP host" required><input required value={f.smtp_host} onChange={(e) => set("smtp_host", e.target.value)} /></Field>
          <Field label="Port" required><input type="number" required value={f.smtp_port} onChange={(e) => set("smtp_port", +e.target.value)} /></Field>
          <Field label="Encryption">
            <select value={f.smtp_security} onChange={(e) => set("smtp_security", e.target.value)}>
              <option value="starttls">STARTTLS (587)</option><option value="ssl">SSL/TLS (465)</option><option value="none">None (internal relay only)</option>
            </select>
          </Field>
          <Field label="Username"><input value={f.smtp_username} onChange={(e) => set("smtp_username", e.target.value)} placeholder="you@gmail.com" autoComplete="off" /></Field>
          <Field label={`App password ${f.smtp_password_set ? "(saved — leave empty to keep)" : ""}`} full>
            <input type="password" value={smtpPw} onChange={(e) => setSmtpPw(e.target.value)} autoComplete="new-password" placeholder={f.smtp_password_set ? "••••••••••••" : "Gmail: Google Account → Security → App passwords"} />
          </Field>
          <Field label="From address" required><input type="email" required value={f.from_address} onChange={(e) => set("from_address", e.target.value)} /></Field>
          <Field label="From name"><input value={f.from_name} onChange={(e) => set("from_name", e.target.value)} /></Field>
          <Field label="Recipients (comma separated)" required full><input required value={recipients} onChange={(e) => setRecipients(e.target.value)} placeholder="shivam@…, devops-team@…" /></Field>
          <p className="full small muted" style={{ margin: 0 }}>The app password is stored encrypted and is never shown again or included in any email or export.</p>
        </div>

        <div className="card card-pad form-grid" style={{ alignContent: "start" }}>
          <div className="form-section" style={{ borderTop: 0, marginTop: 0, paddingTop: 0 }}>Schedule</div>
          <label className="check full"><input type="checkbox" checked={f.enabled} onChange={(e) => set("enabled", e.target.checked)} /> <b>Send reports automatically</b></label>
          <Field label="Frequency">
            <select value={f.frequency} onChange={(e) => set("frequency", e.target.value)}>
              <option value="every_n_days">Every N days</option><option value="weekly">Weekly</option><option value="daily">Daily</option>
            </select>
          </Field>
          {f.frequency === "every_n_days" && <Field label="Every (days)"><input type="number" min={1} max={365} value={f.interval_days} onChange={(e) => set("interval_days", +e.target.value)} /></Field>}
          {f.frequency === "weekly" && <Field label="Day"><select value={f.weekday} onChange={(e) => set("weekday", +e.target.value)}>{DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}</select></Field>}
          {f.frequency === "daily" && <div />}
          <Field label="Time"><input type="time" value={f.send_time} onChange={(e) => set("send_time", e.target.value)} /></Field>
          <Field label="Time zone"><input value={f.timezone} onChange={(e) => set("timezone", e.target.value)} placeholder="Asia/Kolkata" /></Field>
          {f.frequency === "every_n_days" && <Field label="First send date"><input type="date" value={f.anchor_date || ""} onChange={(e) => set("anchor_date", e.target.value)} /></Field>}

          <div className="form-section">Report contents</div>
          <label className="check"><input type="checkbox" checked={f.include_inventory} onChange={(e) => set("include_inventory", e.target.checked)} /> Client & server inventory</label>
          <label className="check"><input type="checkbox" checked={f.include_health} onChange={(e) => set("include_health", e.target.checked)} /> Status & open issues</label>
          <label className="check"><input type="checkbox" checked={f.include_rotations} onChange={(e) => set("include_rotations", e.target.checked)} /> Upcoming credential rotations</label>
          <label className="check"><input type="checkbox" checked={f.attach_inventory_json} onChange={(e) => set("attach_inventory_json", e.target.checked)} /> Attach inventory JSON (no passwords)</label>
          <label className="check full"><input type="checkbox" checked={f.attach_encrypted_bundle} onChange={(e) => set("attach_encrypted_bundle", e.target.checked)} /> Attach <b>encrypted recovery bundle</b> (includes passwords)</label>
          {f.attach_encrypted_bundle && <>
            <Field label={`Bundle passphrase ${f.bundle_passphrase_set ? "(saved — leave empty to keep)" : "(min. 12 chars)"}`} full>
              <input type="password" value={bundlePp} onChange={(e) => setBundlePp(e.target.value)} autoComplete="new-password" />
            </Field>
            <div className="full alert warn">The passphrase is never put in the email. Keep it separately (password manager) — the attachment is useless without it.</div>
          </>}
          <div className="full row"><span className="spacer" /><button className="btn primary" disabled={!!busy}>{busy === "save" ? "Saving…" : "Save settings"}</button></div>
        </div>
      </form>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-head"><h2>Delivery history</h2></div>
        <div className="table-wrap">
          <table className="tbl">
            <thead><tr><th>When</th><th>Kind</th><th>Status</th><th>Recipients</th><th>Detail</th><th>By</th></tr></thead>
            <tbody>{runs?.map((r) => (
              <tr key={r.id}><td className="small">{fmtDate(r.created_at, true)}</td><td><span className="badge gray">{r.kind}</span></td>
                <td><span className={`badge ${r.status === "sent" ? "ok" : "danger"}`}>{r.status}</span></td>
                <td className="small">{r.recipients}</td><td className="small" style={{ maxWidth: 420 }}>{r.detail}</td><td className="small">{r.triggered_by}</td></tr>
            ))}</tbody>
          </table>
          {runs && !runs.length && <Empty>Nothing sent yet — use “Send test email”.</Empty>}
        </div>
      </div>
    </>
  );
}
