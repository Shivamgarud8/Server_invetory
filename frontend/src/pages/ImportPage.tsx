import { useState } from "react";
import { PageHead } from "../components/Layout";
import { useUi } from "../components/ui";
import { api, download } from "../lib/api";
import { invalidateLookups } from "../lib/hooks";

interface Result {
  rows: number;
  counts: { create: number; update: number; unchanged: number };
  errors: { row: number; error: string }[];
  results: { row: number; action: string; label: string; has_password: boolean }[];
  unmapped_columns: string[];
  dry_run: boolean;
  message?: string;
}

const KINDS = [
  { key: "servers", title: "Server Inventory", sheet: "Server Inventory.xlsx", into: "servers + specs + networks", order: 1 },
  { key: "credentials", title: "Password Management", sheet: "Password.xlsx", into: "credentials (passwords encrypted)", order: 2 },
  { key: "versions", title: "Version Management", sheet: "Version.xlsx", into: "applications + deployments + history", order: 3 },
] as const;

export function ImportPage() {
  const { toast } = useUi();
  const [kind, setKind] = useState<(typeof KINDS)[number]["key"]>("servers");
  const [file, setFile] = useState<File | null>(null);
  const [sheet, setSheet] = useState("");
  const [res, setRes] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (dry: boolean) => {
    if (!file) return;
    setBusy(true);
    const fd = new FormData();
    fd.append("file", file);
    fd.append("dry_run", String(dry));
    if (sheet) fd.append("sheet", sheet);
    try {
      const r = await api.upload<Result>(`/import/${kind}`, fd);
      setRes(r);
      if (!dry && !r.errors.length) {
        toast(`Imported: ${r.counts.create} created, ${r.counts.update} updated`);
        invalidateLookups();
      }
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHead title="Excel Import" sub="Move the legacy spreadsheets into the portal. Import servers first so credentials and versions can link to them." />
      <div className="grid grid-3" style={{ marginBottom: 16 }}>
        {KINDS.map((k) => (
          <button key={k.key} className="card card-pad" onClick={() => { setKind(k.key); setRes(null); }}
            style={{ textAlign: "left", cursor: "pointer", font: "inherit", color: "inherit", outline: kind === k.key ? "2px solid var(--primary)" : undefined }}>
            <div className="small muted">Step {k.order}</div>
            <h2 style={{ margin: "4px 0" }}>{k.title}</h2>
            <div className="small muted"><span className="mono">{k.sheet}</span> → {k.into}</div>
          </button>
        ))}
      </div>
      <div className="card card-pad grid" style={{ gap: 14 }}>
        <div className="row wrap">
          <input type="file" accept=".xlsx,.csv" onChange={(e) => { setFile(e.target.files?.[0] || null); setRes(null); }} style={{ maxWidth: 380 }} />
          <input placeholder="Sheet name (optional, default: first)" value={sheet} onChange={(e) => setSheet(e.target.value)} style={{ maxWidth: 280 }} />
          <span className="spacer" />
          <button className="btn" onClick={() => download(`/import/${kind}/template`).catch((e) => toast(e.message, true))}>⇩ Download template</button>
        </div>
        <p className="small muted" style={{ margin: 0 }}>
          Column headers are matched flexibly ("Server Name", "server", "IP", "Private IP"…). Environments accept PROD/Production, STAGING/Stage, UAT, TEST/QA, DEV.
          Existing records are updated by name. The import is all-or-nothing: if any row fails, nothing is saved.
        </p>
        <div className="row">
          <button className="btn" disabled={!file || busy} onClick={() => run(true)}>1. Validate (dry run)</button>
          <button className="btn primary" disabled={!file || busy || !res || res.errors.length > 0 || !res.dry_run} onClick={() => run(false)}>2. Import</button>
        </div>
        {kind === "credentials" && <div className="alert warn">After importing, delete the Excel file from shared drives and laptops — it contains plaintext passwords.</div>}
      </div>

      {res && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="card-head">
            <h2>{res.dry_run ? "Validation result" : "Import complete"}</h2><span className="spacer" />
            <span className="badge ok">{res.counts.create} new</span><span className="badge primary">{res.counts.update} update</span>
            {res.counts.unchanged > 0 && <span className="badge gray">{res.counts.unchanged} unchanged</span>}
            {res.errors.length > 0 && <span className="badge danger">{res.errors.length} errors</span>}
          </div>
          <div className="card-pad grid" style={{ gap: 10 }}>
            {res.message && <div className="alert danger">{res.message}</div>}
            {res.unmapped_columns.length > 0 && <div className="alert info">Ignored columns: {res.unmapped_columns.join(", ")}</div>}
            {res.errors.map((e) => <div key={e.row} className="alert danger">Row {e.row}: {e.error}</div>)}
            <table className="tbl">
              <thead><tr><th>Row</th><th>Record</th><th>Action</th></tr></thead>
              <tbody>{res.results.map((r) => (
                <tr key={r.row}><td>{r.row}</td><td>{r.label} {r.has_password && <span className="badge warn">🔐 password</span>}</td><td><span className={`badge ${r.action === "create" ? "ok" : r.action === "update" ? "primary" : "gray"}`}>{r.action}</span></td></tr>
              ))}</tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
