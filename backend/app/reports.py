"""Email report settings, scheduling maths, report building and SMTP delivery."""

import json
import smtplib
import ssl
from datetime import date, datetime, time, timedelta, timezone
from email.message import EmailMessage
from email.utils import formatdate, make_msgid
from html import escape
from zoneinfo import ZoneInfo

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from . import backup
from .models import AppSetting, Client, ConfigBackup, Credential, Domain, ReportRun, Server
from .security import decrypt_setting, encrypt_bundle, encrypt_setting

EMAIL_KEY = "email"
MONITOR_KEY = "monitoring"

DEFAULT_EMAIL = {
    "enabled": False,
    "smtp_host": "smtp.gmail.com",
    "smtp_port": 587,
    "smtp_security": "starttls",  # starttls | ssl | none
    "smtp_username": "",
    "from_address": "",
    "from_name": "TagID Infra Manager",
    "recipients": [],
    "frequency": "every_n_days",  # daily | weekly | every_n_days
    "interval_days": 15,
    "weekday": 0,  # Monday
    "send_time": "10:00",
    "timezone": "Asia/Kolkata",
    "anchor_date": None,  # first send date for every_n_days (defaults to the day the schedule was saved)
    "include_inventory": True,
    "include_health": True,
    "include_rotations": True,
    "attach_inventory_json": True,
    "attach_encrypted_bundle": False,
    "last_sent_at": None,
    "last_slot": None,
}
DEFAULT_MONITOR = {"enabled": True, "interval_minutes": 10, "snapshot_hour": 2, "last_check_at": None,
                   "last_snapshot_date": None}

SECRET_SMTP = "smtp_password"
SECRET_BUNDLE = "bundle_passphrase"


# ---------------------------------------------------------------- settings storage


def load(db: Session, key: str, default: dict) -> tuple[dict, AppSetting | None]:
    row = db.get(AppSetting, key)
    return ({**default, **(row.value if row else {})}, row)


def save(db: Session, key: str, value: dict, secrets: dict[str, str | None] | None = None) -> AppSetting:
    """secrets: name -> new value (None = keep, '' = clear). Stored encrypted as one JSON blob."""
    row = db.get(AppSetting, key) or AppSetting(key=key, value={})
    current = read_secrets(row, key)
    for name, v in (secrets or {}).items():
        if v is None:
            continue
        if v == "":
            current.pop(name, None)
        else:
            current[name] = v
    row.value = value
    row.secret_enc = encrypt_setting(key, json.dumps(current)) if current else None
    db.merge(row)
    return row


def read_secrets(row: AppSetting | None, key: str) -> dict:
    if row is None or not row.secret_enc:
        return {}
    try:
        return json.loads(decrypt_setting(key, row.secret_enc))
    except Exception:  # noqa: BLE001 — APP_SECRET_KEY changed: treat as not set
        return {}


# ---------------------------------------------------------------- schedule


def next_run(cfg: dict, now: datetime | None = None) -> datetime | None:
    if not cfg.get("enabled"):
        return None
    tz = ZoneInfo(cfg.get("timezone") or "Asia/Kolkata")
    now = (now or datetime.now(timezone.utc)).astimezone(tz)
    hh, mm = (int(x) for x in (cfg.get("send_time") or "10:00").split(":")[:2])
    at = time(hh, mm)
    last_slot = cfg.get("last_slot")

    def ok(dt: datetime) -> bool:
        return dt > now or (dt <= now and last_slot != dt.isoformat() and (now - dt) < timedelta(minutes=60))

    freq = cfg.get("frequency")
    if freq == "daily":
        cand = datetime.combine(now.date(), at, tz)
        return cand if ok(cand) else cand + timedelta(days=1)
    if freq == "weekly":
        wd = int(cfg.get("weekday") or 0)
        cand = datetime.combine(now.date() + timedelta(days=(wd - now.weekday()) % 7), at, tz)
        return cand if ok(cand) else cand + timedelta(days=7)
    n = max(1, int(cfg.get("interval_days") or 15))
    anchor = date.fromisoformat(cfg["anchor_date"]) if cfg.get("anchor_date") else now.date()
    if now.date() <= anchor:
        cand = datetime.combine(anchor, at, tz)
        return cand if ok(cand) else cand + timedelta(days=n)
    k = (now.date() - anchor).days // n
    cand = datetime.combine(anchor + timedelta(days=k * n), at, tz)
    return cand if ok(cand) else cand + timedelta(days=n)


def due_slot(cfg: dict, now: datetime | None = None) -> datetime | None:
    """The slot to send right now, if any (up to 60 minutes late, e.g. after a restart; never twice)."""
    nr = next_run(cfg, now)
    now = now or datetime.now(timezone.utc)
    if nr and nr <= now and cfg.get("last_slot") != nr.isoformat():
        return nr
    return None


# ---------------------------------------------------------------- report content


def summary(db: Session) -> dict:
    today = date.today()
    warn = today + timedelta(days=30)
    servers = list(db.scalars(select(Server).order_by(Server.name)).unique())
    health = {}
    for s in servers:
        health[s.health_status] = health.get(s.health_status, 0) + 1
    last_backup = db.scalar(select(ConfigBackup).order_by(ConfigBackup.id.desc()).limit(1))
    return {
        "clients": [{"name": c.name, "architecture": c.architecture_type,
                     "servers": sum(1 for s in servers if s.client_id == c.id)}
                    for c in db.scalars(select(Client).order_by(Client.name))],
        "server_total": len(servers),
        "health": health,
        "issues": [{"name": s.name, "client": s.client.name if s.client else "-", "status": s.health_status,
                    "detail": s.health_detail or ""}
                   for s in servers if s.health_status in ("critical", "offline", "warning")],
        "domain_issues": [{"name": d.name, "status": d.health_status, "detail": d.health_detail or ""}
                          for d in db.scalars(select(Domain)) if d.health_status in ("critical", "offline", "warning")],
        "rotations": [{"name": c.name, "client": c.client.name if c.client else "-",
                       "due": c.next_rotation_at.isoformat(), "overdue": c.next_rotation_at < today}
                      for c in db.scalars(select(Credential).where(
                          Credential.rotation_policy == "periodic", Credential.next_rotation_at <= warn)
                          .order_by(Credential.next_rotation_at)).unique()],
        "pending_verification": db.scalar(select(func.count()).select_from(Credential)
                                          .where(Credential.pending_verification.is_(True))) or 0,
        "credential_total": db.scalar(select(func.count()).select_from(Credential)) or 0,
        "last_backup": last_backup.created_at.isoformat() if last_backup else None,
    }


def _table(headers: list[str], rows: list[list]) -> str:
    th = "".join(f'<th style="text-align:left;padding:6px 10px;background:#eef2ff;font-size:12px">{escape(h)}</th>'
                 for h in headers)
    trs = "".join("<tr>" + "".join(f'<td style="padding:6px 10px;border-top:1px solid #e5e7eb;font-size:13px">'
                                   f'{escape(str(c))}</td>' for c in r) + "</tr>" for r in rows)
    return f'<table style="border-collapse:collapse;width:100%;margin:6px 0 18px">{th and "<tr>" + th + "</tr>"}{trs}</table>'


def render_html(cfg: dict, s: dict, app_name: str, label: str) -> str:
    h = s["health"]
    parts = ['<div style="font-family:Segoe UI,Arial,sans-serif;max-width:760px;color:#0f172a">',
             f'<h2 style="margin:0 0 4px">{escape(app_name)} — infrastructure report</h2>',
             f'<div style="color:#64748b;margin-bottom:18px">{escape(label)} · '
             f'{datetime.now(ZoneInfo(cfg.get("timezone") or "Asia/Kolkata")).strftime("%d %b %Y %H:%M %Z")}</div>',
             _table(["Clients", "Servers", "Healthy", "Warning", "Critical/Offline", "Unknown", "Credentials"],
                    [[len(s["clients"]), s["server_total"], h.get("healthy", 0), h.get("warning", 0),
                      h.get("critical", 0) + h.get("offline", 0), h.get("unknown", 0), s["credential_total"]]])]
    if cfg.get("include_inventory") and s["clients"]:
        parts += ["<h3>Clients</h3>", _table(["Client", "Architecture", "Servers"],
                                              [[c["name"], c["architecture"], c["servers"]] for c in s["clients"]])]
    if cfg.get("include_health"):
        parts.append("<h3>Status issues</h3>")
        rows = [[i["name"], i["client"], i["status"], i["detail"]] for i in s["issues"]] + \
               [[d["name"], "domain", d["status"], d["detail"]] for d in s["domain_issues"]]
        parts.append(_table(["Name", "Client", "Status", "Detail"], rows) if rows else "<p>No open issues ✓</p>")
    if cfg.get("include_rotations"):
        parts.append("<h3>Credential rotations (next 30 days)</h3>")
        parts.append(_table(["Credential", "Client", "Due", ""],
                            [[r["name"], r["client"], r["due"], "OVERDUE" if r["overdue"] else ""] for r in s["rotations"]])
                     if s["rotations"] else "<p>Nothing due ✓</p>")
        if s["pending_verification"]:
            parts.append(f'<p style="color:#b45309">{s["pending_verification"]} password change(s) still await '
                         f'verification on the target system.</p>')
    parts.append(f'<p>Latest configuration backup: <b>{escape(s["last_backup"] or "none yet")}</b></p>')
    if cfg.get("attach_inventory_json"):
        parts.append("<p>Attached: inventory JSON (no passwords).</p>")
    if cfg.get("attach_encrypted_bundle"):
        parts.append("<p>Attached: encrypted recovery bundle. The passphrase is <b>not</b> in this email — "
                     "it is kept by your administrator.</p>")
    parts.append('<p style="color:#94a3b8;font-size:12px">Sent automatically by TagID Infra Manager · '
                 'Designed &amp; developed by <a href="https://shivam-garud.vercel.app/">Shivam Garud</a></p></div>')
    return "".join(parts)


# ---------------------------------------------------------------- delivery


def _smtp_send(cfg: dict, password: str | None, msg: EmailMessage) -> None:
    host, port, sec = cfg["smtp_host"], int(cfg["smtp_port"]), cfg.get("smtp_security", "starttls")
    ctx = ssl.create_default_context()
    if sec == "ssl":
        server = smtplib.SMTP_SSL(host, port, timeout=25, context=ctx)
    else:
        server = smtplib.SMTP(host, port, timeout=25)
    try:
        server.ehlo()
        if sec == "starttls":
            server.starttls(context=ctx)
            server.ehlo()
        if cfg.get("smtp_username"):
            server.login(cfg["smtp_username"], password or "")
        server.send_message(msg)
    finally:
        try:
            server.quit()
        except Exception:  # noqa: BLE001
            pass


def _message(cfg: dict, subject: str, html: str) -> EmailMessage:
    if not cfg.get("from_address") or not cfg.get("recipients"):
        raise ValueError("Set the sender address and at least one recipient first")
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = f'{cfg.get("from_name") or "TagID Infra Manager"} <{cfg["from_address"]}>'
    msg["To"] = ", ".join(cfg["recipients"])
    msg["Date"] = formatdate(localtime=True)
    msg["Message-ID"] = make_msgid(domain=cfg["from_address"].split("@")[-1])
    msg.set_content("This report is best viewed in an HTML-capable mail client.")
    msg.add_alternative(html, subtype="html")
    return msg


def send_report(db: Session, kind: str, actor: str | None, app_name: str, label: str) -> ReportRun:
    cfg, row = load(db, EMAIL_KEY, DEFAULT_EMAIL)
    secrets = read_secrets(row, EMAIL_KEY)
    run = ReportRun(kind=kind, status="failed", recipients=", ".join(cfg.get("recipients") or []), triggered_by=actor)
    try:
        if kind == "test":
            msg = _message(cfg, f"[{app_name}] Test email",
                           f"<p>SMTP settings work. Reports will be sent "
                           f"{escape(describe(cfg))}.</p><p style='color:#94a3b8'>{escape(label)}</p>")
        else:
            s = summary(db)
            stamp = datetime.now().strftime("%Y-%m-%d")
            msg = _message(cfg, f"[{app_name}] Infrastructure report {stamp}", render_html(cfg, s, app_name, label))
            snap = backup.take_snapshot(db, "report", actor)
            if cfg.get("attach_inventory_json"):
                msg.add_attachment(json.dumps(snap.content, indent=1, default=str).encode(), maintype="application",
                                   subtype="json", filename=f"tagid-inventory-{stamp}.json")
            if cfg.get("attach_encrypted_bundle"):
                passphrase = secrets.get(SECRET_BUNDLE)
                if not passphrase:
                    raise ValueError("Encrypted bundle attachment is enabled but no bundle passphrase is set")
                inv = backup.build_inventory(db, include_secrets=True)
                bundle = encrypt_bundle(passphrase, json.dumps(inv, default=str).encode())
                msg.add_attachment(json.dumps(bundle).encode(), maintype="application", subtype="json",
                                   filename=f"tagid-recovery-bundle-{stamp}.tagid.json")
        _smtp_send(cfg, secrets.get(SECRET_SMTP), msg)
        run.status = "sent"
        run.detail = f"{len(cfg['recipients'])} recipient(s)"
    except Exception as e:  # noqa: BLE001 — store a readable error for the UI
        run.detail = f"{type(e).__name__}: {e}"[:1000]
    db.add(run)
    return run


def describe(cfg: dict) -> str:
    if not cfg.get("enabled"):
        return "only when sent manually (schedule disabled)"
    t = f'at {cfg.get("send_time")} ({cfg.get("timezone")})'
    f = cfg.get("frequency")
    if f == "daily":
        return f"every day {t}"
    if f == "weekly":
        return f'every {["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"][int(cfg.get("weekday") or 0)]} {t}'
    return f'every {cfg.get("interval_days")} days {t}'
