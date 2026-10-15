import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { PageHead } from "../components/Layout";
import { Empty, Modal, fmtDate, useUi } from "../components/ui";
import { api, download } from "../lib/api";
import { useDebounced, useLoad } from "../lib/hooks";
import type { AuditEntry } from "../lib/types";
import { ActionBadge } from "./Dashboard";

const PAGE = 50;

export function AuditLogs() {
  const { toast } = useUi();
  const [sp] = useSearchParams();
  const [q, setQ] = useState("");
  const [action, setAction] = useState(sp.get("action") || "");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const [detail, setDetail] = useState<AuditEntry | null>(null);
  const dq = useDebounced(q);
  const params = {
    q: dq, action,
    date_from: from ? new Date(from + "T00:00:00").toISOString() : undefined,
    date_to: to ? new Date(to + "T23:59:59").toISOString() : undefined,
  };
  const { data: actions } = useLoad(() => api.get<string[]>("/audit-logs/actions"));
  const { data } = useLoad(() => api.get<{ total: number; items: AuditEntry[] }>("/audit-logs", { ...params, page, page_size: PAGE }), [dq, action, from, to, page]);
  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE)) : 1;

  return (
    <>
      <PageHead title="Audit Logs" sub="Every login, change and password access — tamper-evident history for compliance">
        <button className="btn" onClick={() => download("/audit-logs/export", params).catch((e) => toast(e.message, true))}>⇩ Export CSV</button>
      </PageHead>
      <div className="card">
        <div className="filters">
          <input type="search" placeholder="Search user, entity, IP…" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
          <select value={action} onChange={(e) => { setAction(e.target.value); setPage(1); }}><option value="">All actions</option>{actions?.map((a) => <option key={a}>{a}</option>)}</select>
          <input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1); }} style={{ width: "auto" }} title="From" />
          <input type="date" value={to} onChange={(e) => { setTo(e.target.value); setPage(1); }} style={{ width: "auto" }} title="To" />
          <span className="spacer" />
          <span className="muted small" style={{ alignSelf: "center" }}>{data?.total ?? 0} events</span>
        </div>
        <div className="table-wrap">
          <table className="tbl">
            <thead><tr><th>Time</th><th>User</th><th>Action</th><th>Target</th><th>IP address</th><th /></tr></thead>
            <tbody>
              {data?.items.map((a) => (
                <tr key={a.id} className="clickable" onClick={() => setDetail(a)}>
                  <td className="small nowrap">{fmtDate(a.created_at, true)}</td>
                  <td><b>{a.username || "—"}</b></td>
                  <td><ActionBadge action={a.action} /></td>
                  <td>{a.entity_label}{a.entity_type && <span className="small muted"> ({a.entity_type})</span>}</td>
                  <td className="mono small">{a.ip_address}</td>
                  <td className="small muted">{a.details ? "details ›" : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data && !data.items.length && <Empty>No events match.</Empty>}
        </div>
        <div className="filters" style={{ borderTop: "1px solid var(--border)", borderBottom: 0 }}>
          <span className="spacer" />
          <button className="btn sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>‹ Prev</button>
          <span className="small" style={{ alignSelf: "center" }}>Page {page} / {pages}</span>
          <button className="btn sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next ›</button>
        </div>
      </div>
      {detail && (
        <Modal title={detail.action} onClose={() => setDetail(null)}>
          <dl className="kv">
            <dt>Time</dt><dd>{fmtDate(detail.created_at, true)}</dd>
            <dt>User</dt><dd>{detail.username}</dd>
            <dt>Target</dt><dd>{detail.entity_label} {detail.entity_type && <span className="muted">({detail.entity_type} #{detail.entity_id})</span>}</dd>
            <dt>IP</dt><dd className="mono">{detail.ip_address}</dd>
            <dt>Browser</dt><dd className="small">{detail.user_agent}</dd>
          </dl>
          {detail.details && <pre className="mono small" style={{ background: "var(--panel-2)", padding: 12, borderRadius: 8, overflowX: "auto", marginTop: 16 }}>{JSON.stringify(detail.details, null, 2)}</pre>}
        </Modal>
      )}
    </>
  );
}
