import { useState } from "react";
import { PageHead } from "../components/Layout";
import { Empty, Field, Modal, fmtDate, timeAgo, useUi } from "../components/ui";
import { api, download } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useLoad } from "../lib/hooks";
import { invalidateLookups } from "../lib/hooks";

interface Snapshot { id: number; created_at: string; kind: string; checksum: string; size_bytes: number; summary: Record<string, number> | null; created_by: string | null }
interface PlanRow { new?: number; update?: number; unchanged?: number; total?: number; conflicts?: { key: string; fields: string[] }[] }
interface Preview { manifest: { generated_at: string; app_version: string; format_version: number; includes_secrets: boolean; counts: Record<string, number> }; encrypted: boolean; plan: Record<string, PlanRow> }

async function postDownload(path: string, body: unknown) {
  const res = await fetch(`/api${path}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "TagIDPortal" }, body: JSON.stringify(body), credentials: "same-origin" });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).detail || msg; } catch { /* not json */ }
    throw new Error(msg);
  }
  const blob = await res.blob();
  const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") || "")?.[1] || "bundle.json";
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function Backup() {
  const { can } = useAuth();
  const { toast } = useUi();
  const { data: snaps, reload } = useLoad(() => api.get<Snapshot[]>("/backup/snapshots"));
  const [bundleOpen, setBundleOpen] = useState(false);

  const snapNow = async () => {
    await api.post("/backup/snapshots").then(() => (toast("Snapshot saved"), reload())).catch((e) => toast(e.message, true));
  };

  return (
    <>
      <PageHead title="Backup & Disaster Recovery" sub="If this server is lost, these files let you rebuild the whole inventory and architecture on a new one" />
      <div className="grid grid-3" style={{ marginBottom: 16 }}>
        <div className="card card-pad grid" style={{ gap: 10, alignContent: "start" }}>
          <h2 style={{ margin: 0 }}>📄 Inventory JSON</h2>
          <p className="small muted" style={{ margin: 0 }}>Clients, servers, IPs, domains, services, connections, architecture layouts, credential <b>metadata</b>, rotation policies and change history. <b>No passwords.</b> Includes manifest, format version and SHA-256 checksum.</p>
          <div><button className="btn primary" onClick={() => download("/backup/inventory").catch((e) => toast(e.message, true))}>⇩ Download inventory</button></div>
        </div>
        <div className="card card-pad grid" style={{ gap: 10, alignContent: "start" }}>
          <h2 style={{ margin: 0 }}>🔒 Encrypted recovery bundle</h2>
          <p className="small muted" style={{ margin: 0 }}>Everything above <b>plus current passwords</b>, encrypted with AES-256-GCM using a passphrase you choose (scrypt). Without the passphrase the file is useless — store them separately.</p>
          <div><button className="btn" disabled={!can("backup.export_secrets")} onClick={() => setBundleOpen(true)} title={can("backup.export_secrets") ? "" : "Needs the backup.export_secrets permission"}>🔐 Create recovery bundle</button></div>
        </div>
        <div className="card card-pad grid" style={{ gap: 10, alignContent: "start" }}>
          <h2 style={{ margin: 0 }}>🕘 Automatic snapshots</h2>
          <p className="small muted" style={{ margin: 0 }}>The scheduler saves an inventory snapshot every day (and before every restore). Last 30 are kept in the database. For the application itself also run <span className="mono">scripts/backup.sh</span> (database dump) and keep a copy of <span className="mono">.env</span>.</p>
          <div><button className="btn" onClick={snapNow}>📸 Snapshot now</button></div>
        </div>
      </div>

      {can("backup.restore") && <Restore onDone={reload} />}

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-head"><h2>Snapshots</h2><span className="spacer" /><span className="small muted">{snaps?.[0] ? `Last: ${timeAgo(snaps[0].created_at)}` : ""}</span></div>
        <div className="table-wrap">
          <table className="tbl">
            <thead><tr><th>When</th><th>Kind</th><th>Contents</th><th>Size</th><th>Checksum</th><th /></tr></thead>
            <tbody>{snaps?.map((s) => (
              <tr key={s.id}>
                <td className="small">{fmtDate(s.created_at, true)}<div className="muted">{s.created_by}</div></td>
                <td><span className={`badge ${s.kind === "pre-import" ? "warn" : s.kind === "manual" ? "primary" : "gray"}`}>{s.kind}</span></td>
                <td className="small">{s.summary ? `${s.summary.clients ?? 0} clients · ${s.summary.servers ?? 0} servers · ${s.summary.services ?? 0} services · ${s.summary.credentials ?? 0} credentials` : "—"}</td>
                <td className="small">{(s.size_bytes / 1024).toFixed(0)} KB</td>
                <td className="mono small" title={s.checksum}>{s.checksum.slice(0, 12)}…</td>
                <td className="right"><button className="btn sm" onClick={() => download(`/backup/snapshots/${s.id}`).catch((e) => toast(e.message, true))}>⇩</button></td>
              </tr>
            ))}</tbody>
          </table>
          {snaps && !snaps.length && <Empty>No snapshots yet.</Empty>}
        </div>
      </div>
      {bundleOpen && <BundleModal onClose={() => setBundleOpen(false)} />}
    </>
  );
}

function BundleModal({ onClose }: { onClose: () => void }) {
  const { toast } = useUi();
  const [pp, setPp] = useState("");
  const [pp2, setPp2] = useState("");
  const [pwd, setPwd] = useState("");
  const [busy, setBusy] = useState(false);
  const go = async () => {
    if (pp !== pp2) return toast("Passphrases do not match", true);
    setBusy(true);
    try {
      await postDownload("/backup/bundle", { passphrase: pp, current_password: pwd });
      toast("Recovery bundle downloaded");
      onClose();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="🔐 Create encrypted recovery bundle" onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || pp.length < 12 || !pwd} onClick={go}>{busy ? "Encrypting…" : "Download bundle"}</button></>}>
      <div className="grid" style={{ gap: 12 }}>
        <div className="alert warn">This file contains every current password (encrypted). Keep the passphrase somewhere else — e.g. a password manager or sealed envelope. It is not stored anywhere by the portal.</div>
        <Field label="Bundle passphrase (min. 12 characters)" required><input type="password" value={pp} onChange={(e) => setPp(e.target.value)} autoComplete="new-password" /></Field>
        <Field label="Repeat passphrase" required><input type="password" value={pp2} onChange={(e) => setPp2(e.target.value)} autoComplete="new-password" /></Field>
        <Field label="Your login password (re-authentication)" required><input type="password" value={pwd} onChange={(e) => setPwd(e.target.value)} autoComplete="current-password" /></Field>
      </div>
    </Modal>
  );
}

function Restore({ onDone }: { onDone: () => void }) {
  const { can } = useAuth();
  const { toast } = useUi();
  const [file, setFile] = useState<File | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [mode, setMode] = useState("merge");
  const [restoreSecrets, setRestoreSecrets] = useState(true);
  const [overwrite, setOverwrite] = useState(false);
  const [pwd, setPwd] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Record<string, number> | null>(null);
  const [confirming, setConfirming] = useState(false);

  const form = (extra: Record<string, string> = {}) => {
    const fd = new FormData();
    fd.append("file", file!);
    if (passphrase) fd.append("passphrase", passphrase);
    for (const [k, v] of Object.entries(extra)) fd.append(k, v);
    return fd;
  };
  const doPreview = async () => {
    setBusy(true);
    setResult(null);
    try {
      setPreview(await api.upload<Preview>("/backup/import/preview", form()));
    } catch (e) {
      toast((e as Error).message, true);
      setPreview(null);
    } finally {
      setBusy(false);
    }
  };
  const apply = async () => {
    setBusy(true);
    try {
      const r = await api.upload<{ stats: Record<string, number> }>("/backup/import/apply", form({
        mode, restore_secrets: String(restoreSecrets && !!preview?.encrypted), overwrite_secrets: String(overwrite), current_password: pwd,
      }));
      setResult(r.stats);
      setConfirming(false);
      setPwd("");
      invalidateLookups();
      toast("Restore complete");
      onDone();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };

  const rows = preview ? Object.entries(preview.plan) : [];
  return (
    <div className="card card-pad grid" style={{ gap: 12 }}>
      <h2 style={{ margin: 0 }}>♻ Restore / import</h2>
      <ol className="small muted" style={{ margin: 0, paddingLeft: 18 }}>
        <li>Upload an inventory JSON or an encrypted recovery bundle.</li>
        <li>Preview: structure, version and checksum are validated; new, changed and unchanged records are listed.</li>
        <li>Confirm. A snapshot of the current state is saved first. Nothing is executed on servers and no live password is changed.</li>
      </ol>
      <div className="row wrap">
        <input type="file" accept=".json,application/json" onChange={(e) => { setFile(e.target.files?.[0] || null); setPreview(null); setResult(null); }} style={{ maxWidth: 360 }} />
        <input type="password" placeholder="Bundle passphrase (encrypted bundles only)" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} style={{ maxWidth: 300 }} />
        <button className="btn" disabled={!file || busy} onClick={doPreview}>{busy && !confirming ? "Checking…" : "1. Validate & preview"}</button>
      </div>

      {preview && (
        <>
          <div className="alert info">
            {preview.encrypted ? "🔒 Encrypted bundle (contains passwords)" : "📄 Inventory file (no passwords)"} · generated {fmtDate(preview.manifest.generated_at, true)} ·
            portal v{preview.manifest.app_version} · format v{preview.manifest.format_version} · checksum ✓
          </div>
          <table className="tbl">
            <thead><tr><th>Records</th><th>New</th><th>Changed</th><th>Unchanged</th><th>Differences</th></tr></thead>
            <tbody>{rows.map(([k, r]) => (
              <tr key={k}>
                <td><b>{k.replace(/_/g, " ")}</b></td>
                {r.total !== undefined ? <td colSpan={3} className="muted">{r.total} in file</td> : <>
                  <td><span className="badge ok">{r.new}</span></td><td><span className={`badge ${r.update ? "warn" : "gray"}`}>{r.update}</span></td><td><span className="badge gray">{r.unchanged}</span></td>
                </>}
                <td className="small muted">{r.conflicts?.slice(0, 4).map((c) => `${c.key.split("|")[0]}: ${c.fields.join(", ")}`).join(" · ")}{(r.conflicts?.length || 0) > 4 ? " …" : ""}</td>
              </tr>
            ))}</tbody>
          </table>
          <div className="row wrap" style={{ gap: 18 }}>
            <label className="check"><input type="radio" checked={mode === "merge"} onChange={() => setMode("merge")} /> Create new <b>and update</b> existing records</label>
            <label className="check"><input type="radio" checked={mode === "add_only"} onChange={() => setMode("add_only")} /> Only add missing records (keep existing as they are)</label>
          </div>
          {preview.encrypted && (
            <div className="row wrap" style={{ gap: 18 }}>
              <label className="check"><input type="checkbox" checked={restoreSecrets} disabled={!can("credentials.update")} onChange={(e) => setRestoreSecrets(e.target.checked)} /> Restore passwords from the bundle</label>
              <label className="check"><input type="checkbox" checked={overwrite} disabled={!restoreSecrets} onChange={(e) => setOverwrite(e.target.checked)} /> Also overwrite passwords that already exist here</label>
            </div>
          )}
          <div><button className="btn primary" onClick={() => setConfirming(true)}>2. Restore…</button></div>
        </>
      )}
      {result && (
        <div className="alert info">Done: {Object.entries(result).map(([k, v]) => `${v} ${k.replace(/_/g, " ")}`).join(" · ") || "nothing to change"}</div>
      )}
      {confirming && (
        <Modal title="Confirm restore" onClose={() => setConfirming(false)}
          footer={<><button className="btn" onClick={() => setConfirming(false)}>Cancel</button><button className="btn danger solid" disabled={busy || !pwd} onClick={apply}>{busy ? "Restoring…" : "Restore now"}</button></>}>
          <p style={{ marginTop: 0 }}>Mode: <b>{mode === "merge" ? "create + update" : "add missing only"}</b>{preview?.encrypted && restoreSecrets ? `, passwords restored${overwrite ? " (overwriting existing)" : " (only where none exists)"}` : ""}.</p>
          <p className="muted small">A pre-import snapshot is saved automatically so you can roll back by restoring it.</p>
          <Field label="Your login password" required><input type="password" autoFocus value={pwd} onChange={(e) => setPwd(e.target.value)} /></Field>
        </Modal>
      )}
    </div>
  );
}
