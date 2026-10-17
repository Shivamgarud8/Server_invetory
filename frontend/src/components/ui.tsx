import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import type { Environment, Tag } from "../lib/types";

// ---------------------------------------------------------------- toasts & confirm

interface Toast { id: number; msg: string; error?: boolean }
interface UiCtx {
  toast: (msg: string, error?: boolean) => void;
  confirm: (title: string, body?: ReactNode, danger?: boolean) => Promise<boolean>;
}
const Ctx = createContext<UiCtx>(null!);

export function UiProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [dialog, setDialog] = useState<{ title: string; body?: ReactNode; danger?: boolean; resolve: (v: boolean) => void } | null>(null);

  const toast = useCallback((msg: string, error = false) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, msg, error }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), error ? 6000 : 3000);
  }, []);

  const confirm = useCallback(
    (title: string, body?: ReactNode, danger = true) => new Promise<boolean>((resolve) => setDialog({ title, body, danger, resolve })),
    [],
  );

  const close = (v: boolean) => {
    dialog?.resolve(v);
    setDialog(null);
  };

  return (
    <Ctx.Provider value={{ toast, confirm }}>
      {children}
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.error ? "error" : ""}`}>{t.msg}</div>
        ))}
      </div>
      {dialog && (
        <Modal title={dialog.title} onClose={() => close(false)}
          footer={<>
            <button className="btn" onClick={() => close(false)}>Cancel</button>
            <button className={`btn ${dialog.danger ? "danger solid" : "primary"}`} onClick={() => close(true)} autoFocus>Confirm</button>
          </>}>
          {dialog.body || <p className="muted">Are you sure?</p>}
        </Modal>
      )}
    </Ctx.Provider>
  );
}

export const useUi = () => useContext(Ctx);

// ---------------------------------------------------------------- modal

export function Modal({ title, children, footer, onClose, wide }: {
  title: ReactNode; children: ReactNode; footer?: ReactNode; onClose: () => void; wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? "wide" : ""}`} role="dialog" aria-modal="true">
        <div className="modal-head">
          <h2>{title}</h2>
          <span className="spacer" />
          <button className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- chips

export function EnvBadge({ env }: { env: Pick<Environment, "name" | "color"> }) {
  return <span className="badge env" style={{ background: env.color }}>{env.name}</span>;
}

export function TagChips({ tags }: { tags: Tag[] }) {
  return (
    <span className="row wrap" style={{ gap: 4 }}>
      {tags.map((t) => (
        <span key={t.id} className="badge tag" style={{ color: t.color, borderColor: t.color }}>{t.name}</span>
      ))}
    </span>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const s = status.toLowerCase();
  const cls = ["active", "running", "online"].includes(s) ? "ok" : ["maintenance", "rotating", "pending"].includes(s) ? "warn" : ["inactive", "decommissioned", "disabled", "revoked", "offline"].includes(s) ? "danger" : "gray";
  return <span className={`badge ${cls}`}>{status}</span>;
}

const HEALTH_STYLE: Record<string, [string, string]> = {
  healthy: ["ok", "●"], warning: ["warn", "▲"], critical: ["danger", "■"], offline: ["danger", "■"], unknown: ["gray", "?"],
};

export function HealthBadge({ status, detail, at }: { status: string; detail?: string | null; at?: string | null }) {
  const [cls, icon] = HEALTH_STYLE[status] || HEALTH_STYLE.unknown;
  const title = [detail, at ? `checked ${new Date(at).toLocaleString()}` : null].filter(Boolean).join(" · ");
  return <span className={`badge ${cls}`} title={title || "Not checked yet"}>{icon} {status}</span>;
}

export function ClientChip({ client }: { client: { name: string; color: string } | null | undefined }) {
  if (!client) return <span className="muted">—</span>;
  return <span className="badge" style={{ background: client.color + "22", color: client.color, borderColor: client.color }}>{client.name}</span>;
}

export function TagPicker({ all, value, onChange }: { all: Tag[]; value: number[]; onChange: (ids: number[]) => void }) {
  return (
    <div className="row wrap" style={{ gap: 6 }}>
      {all.map((t) => {
        const on = value.includes(t.id);
        return (
          <button type="button" key={t.id} className="badge tag" onClick={() => onChange(on ? value.filter((x) => x !== t.id) : [...value, t.id])}
            style={{ cursor: "pointer", color: on ? "#fff" : t.color, background: on ? t.color : "transparent", borderColor: t.color, padding: "4px 10px" }}>
            {on ? "✓ " : ""}{t.name}
          </button>
        );
      })}
      {!all.length && <span className="muted small">No tags defined — add them in Settings.</span>}
    </div>
  );
}

// ---------------------------------------------------------------- formatting

export function fmtDate(v: string | null | undefined, withTime = false) {
  if (!v) return "—";
  const d = new Date(v);
  if (isNaN(d.getTime())) return v;
  return d.toLocaleString("en-GB", {
    day: "2-digit", month: "short", year: "numeric",
    ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}),
  });
}

export function timeAgo(v: string | null | undefined) {
  if (!v) return "—";
  const s = (Date.now() - new Date(v).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return fmtDate(v);
}

export function daysUntil(v: string | null) {
  if (!v) return null;
  return Math.ceil((new Date(v + "T00:00:00").getTime() - Date.now()) / 86400000);
}

export function ExpiryBadge({ date }: { date: string | null }) {
  const d = daysUntil(date);
  if (d === null) return <span className="muted">—</span>;
  if (d < 0) return <span className="badge danger">Expired {-d}d ago</span>;
  if (d <= 30) return <span className="badge warn">{d}d left</span>;
  return <span className="muted small">{fmtDate(date)}</span>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Field({ label, required, children, full }: { label: string; required?: boolean; children: ReactNode; full?: boolean }) {
  return (
    <label className={`field ${full ? "full" : ""}`}>
      <span className={required ? "req" : ""}>{label}</span>
      {children}
    </label>
  );
}
