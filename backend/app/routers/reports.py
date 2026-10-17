from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, EmailStr, Field, field_validator
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import health, reports
from ..audit import audit
from ..config import get_settings
from ..db import get_db
from ..deps import Principal, require
from ..models import ReportRun

router = APIRouter(prefix="/api", tags=["reports"])


class EmailSettingsIn(BaseModel):
    enabled: bool = False
    smtp_host: str = Field(min_length=1, max_length=255)
    smtp_port: int = Field(ge=1, le=65535)
    smtp_security: str = Field(pattern=r"^(starttls|ssl|none)$")
    smtp_username: str = ""
    smtp_password: str | None = None  # None = keep current, "" = clear
    from_address: EmailStr
    from_name: str = "TagID Infra Manager"
    recipients: list[EmailStr] = Field(min_length=1, max_length=20)
    frequency: str = Field(pattern=r"^(daily|weekly|every_n_days)$")
    interval_days: int = Field(default=15, ge=1, le=365)
    weekday: int = Field(default=0, ge=0, le=6)
    send_time: str = Field(pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    timezone: str = "Asia/Kolkata"
    anchor_date: date | None = None
    include_inventory: bool = True
    include_health: bool = True
    include_rotations: bool = True
    attach_inventory_json: bool = True
    attach_encrypted_bundle: bool = False
    bundle_passphrase: str | None = None  # None = keep, "" = clear

    @field_validator("timezone")
    @classmethod
    def _tz(cls, v: str) -> str:
        from zoneinfo import ZoneInfo

        ZoneInfo(v)
        return v

    @field_validator("bundle_passphrase")
    @classmethod
    def _pp(cls, v):
        if v and len(v) < 12:
            raise ValueError("Bundle passphrase must be at least 12 characters")
        return v


def _email_out(db: Session) -> dict:
    cfg, row = reports.load(db, reports.EMAIL_KEY, reports.DEFAULT_EMAIL)
    sec = reports.read_secrets(row, reports.EMAIL_KEY)
    nr = reports.next_run(cfg)
    last = db.scalar(select(ReportRun).where(ReportRun.kind != "test").order_by(ReportRun.id.desc()).limit(1))
    return {**{k: v for k, v in cfg.items() if k not in ("last_slot",)},
            "smtp_password_set": bool(sec.get(reports.SECRET_SMTP)),
            "bundle_passphrase_set": bool(sec.get(reports.SECRET_BUNDLE)),
            "next_run_at": nr.isoformat() if nr else None,
            "schedule_text": reports.describe(cfg),
            "last_run": {"at": last.created_at, "status": last.status, "detail": last.detail} if last else None}


@router.get("/reports/email")
def get_email_settings(db: Session = Depends(get_db), _: Principal = Depends(require("reports.manage"))):
    return _email_out(db)


@router.put("/reports/email")
def save_email_settings(body: EmailSettingsIn, request: Request, db: Session = Depends(get_db),
                        p: Principal = Depends(require("reports.manage"))):
    cfg, _ = reports.load(db, reports.EMAIL_KEY, reports.DEFAULT_EMAIL)
    data = body.model_dump(exclude={"smtp_password", "bundle_passphrase"})
    data["recipients"] = [str(r) for r in body.recipients]
    data["from_address"] = str(body.from_address)
    data["anchor_date"] = (body.anchor_date or date.today()).isoformat()
    for k in ("last_sent_at", "last_slot"):
        data[k] = cfg.get(k)
    if data["attach_encrypted_bundle"] and not body.bundle_passphrase:
        _, row = reports.load(db, reports.EMAIL_KEY, reports.DEFAULT_EMAIL)
        if not reports.read_secrets(row, reports.EMAIL_KEY).get(reports.SECRET_BUNDLE):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Set a bundle passphrase to attach encrypted bundles")
    reports.save(db, reports.EMAIL_KEY, data,
                 {reports.SECRET_SMTP: body.smtp_password, reports.SECRET_BUNDLE: body.bundle_passphrase})
    audit(db, request, "EMAIL_SETTINGS_UPDATED", p.user,
          details={"schedule": reports.describe(data), "recipients": len(data["recipients"]),
                   "smtp_password_changed": body.smtp_password is not None})
    db.commit()
    return _email_out(db)


def _label() -> str:
    s = get_settings()
    return s.server_label or s.public_url or "TagID"


@router.post("/reports/test")
def send_test(request: Request, db: Session = Depends(get_db), p: Principal = Depends(require("reports.manage"))):
    run = reports.send_report(db, "test", p.user.username, get_settings().app_name, _label())
    audit(db, request, "REPORT_TEST_SENT" if run.status == "sent" else "REPORT_FAILED", p.user, details={"detail": run.detail})
    db.commit()
    if run.status != "sent":
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, run.detail or "Sending failed")
    return {"ok": True, "detail": run.detail}


@router.post("/reports/send-now")
def send_now(request: Request, db: Session = Depends(get_db), p: Principal = Depends(require("reports.manage"))):
    run = reports.send_report(db, "manual", p.user.username, get_settings().app_name, _label())
    audit(db, request, "REPORT_SENT" if run.status == "sent" else "REPORT_FAILED", p.user, details={"detail": run.detail})
    db.commit()
    if run.status != "sent":
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, run.detail or "Sending failed")
    return {"ok": True, "detail": run.detail}


@router.get("/reports/runs")
def list_runs(db: Session = Depends(get_db), _: Principal = Depends(require("reports.manage"))):
    return [{"id": r.id, "created_at": r.created_at, "kind": r.kind, "status": r.status, "recipients": r.recipients,
             "detail": r.detail, "triggered_by": r.triggered_by}
            for r in db.scalars(select(ReportRun).order_by(ReportRun.id.desc()).limit(50))]


# ---------------------------------------------------------------- monitoring


class MonitorIn(BaseModel):
    enabled: bool = True
    interval_minutes: int = Field(default=10, ge=1, le=1440)
    snapshot_hour: int = Field(default=2, ge=0, le=23)


@router.get("/monitoring/settings")
def get_monitor(db: Session = Depends(get_db), _: Principal = Depends(require("servers.view"))):
    cfg, _ = reports.load(db, reports.MONITOR_KEY, reports.DEFAULT_MONITOR)
    return cfg


@router.put("/monitoring/settings")
def save_monitor(body: MonitorIn, request: Request, db: Session = Depends(get_db),
                 p: Principal = Depends(require("reports.manage"))):
    cfg, _ = reports.load(db, reports.MONITOR_KEY, reports.DEFAULT_MONITOR)
    cfg.update(body.model_dump())
    reports.save(db, reports.MONITOR_KEY, cfg)
    audit(db, request, "MONITORING_SETTINGS_UPDATED", p.user, details=body.model_dump())
    db.commit()
    return cfg


class CheckIn(BaseModel):
    server_ids: list[int] | None = None
    domain_ids: list[int] | None = None


@router.post("/monitoring/check")
def check_now(body: CheckIn, request: Request, db: Session = Depends(get_db),
              p: Principal = Depends(require("servers.view"))):
    res = health.run_checks(db, body.server_ids, body.domain_ids)
    audit(db, request, "STATUS_CHECK_RUN", p.user, details=res)
    db.commit()
    return res
