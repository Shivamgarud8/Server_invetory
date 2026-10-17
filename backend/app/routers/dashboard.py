from datetime import date, datetime, timedelta, timezone

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..db import get_db
from ..deps import Principal, require
from ..models import (
    Application,
    ApplicationVersion,
    AuditLog,
    Client,
    ConfigBackup,
    Credential,
    Environment,
    Server,
    User,
    VersionHistory,
)
from .common import scope

router = APIRouter(prefix="/api/dashboard", tags=["dashboard"])

STALE_PASSWORD_DAYS = 90


@router.get("")
def dashboard(db: Session = Depends(get_db), p: Principal = Depends(require("dashboard.view"))):
    env_ids = p.env_ids()
    s = get_settings()
    today = date.today()
    out: dict = {"environments": [], "cards": {}}

    envs = list(db.scalars(scope(select(Environment), Environment.id, env_ids).order_by(Environment.sort_order)))
    out["environments"] = [{"id": e.id, "name": e.name, "color": e.color} for e in envs]

    if p.can("clients.view"):
        out["cards"]["clients"] = db.scalar(select(func.count()).select_from(Client))

    if p.can("servers.view"):
        by_env = dict(db.execute(
            scope(select(Server.environment_id, func.count()), Server.environment_id, env_ids).group_by(Server.environment_id)
        ).all())
        out["servers_by_env"] = {str(e.id): by_env.get(e.id, 0) for e in envs}
        out["health"] = dict(db.execute(
            scope(select(Server.health_status, func.count()), Server.environment_id, env_ids).group_by(Server.health_status)
        ).all())
        out["cards"]["servers"] = sum(by_env.values())
        out["recent_servers"] = [
            {"id": x.id, "name": x.name, "environment": x.environment.name, "color": x.environment.color,
             "created_at": x.created_at}
            for x in db.scalars(scope(select(Server), Server.environment_id, env_ids).order_by(Server.created_at.desc()).limit(6))
        ]

    if p.can("credentials.view"):
        base = scope(select(func.count()).select_from(Credential), Credential.environment_id, env_ids)
        warn_limit = today + timedelta(days=s.credential_expiry_warning_days)
        stale_before = datetime.now(timezone.utc) - timedelta(days=STALE_PASSWORD_DAYS)
        out["cards"]["credentials"] = db.scalar(base)
        out["cards"]["credentials_expiring"] = db.scalar(
            base.where(Credential.expires_at.is_not(None), Credential.expires_at >= today, Credential.expires_at <= warn_limit))
        out["cards"]["credentials_expired"] = db.scalar(
            base.where(Credential.expires_at.is_not(None), Credential.expires_at < today))
        out["cards"]["credentials_stale"] = db.scalar(
            base.where(Credential.has_secret.is_(True), Credential.password_changed_at < stale_before))
        out["cards"]["rotations_overdue"] = db.scalar(
            base.where(Credential.rotation_policy == "periodic", Credential.next_rotation_at < today))
        out["cards"]["rotations_upcoming"] = db.scalar(
            base.where(Credential.rotation_policy == "periodic", Credential.next_rotation_at >= today,
                       Credential.next_rotation_at <= warn_limit))
        out["cards"]["pending_verification"] = db.scalar(base.where(Credential.pending_verification.is_(True)))
        out["rotations"] = [
            {"id": c.id, "name": c.name, "client": c.client.name if c.client else None,
             "due": c.next_rotation_at, "days_left": (c.next_rotation_at - today).days}
            for c in db.scalars(
                scope(select(Credential), Credential.environment_id, env_ids)
                .where(Credential.rotation_policy == "periodic", Credential.next_rotation_at <= warn_limit)
                .order_by(Credential.next_rotation_at).limit(8))
        ]
        out["expiring"] = [
            {"id": c.id, "name": c.name, "environment": c.environment.name, "color": c.environment.color,
             "expires_at": c.expires_at, "days_left": (c.expires_at - today).days}
            for c in db.scalars(
                scope(select(Credential), Credential.environment_id, env_ids)
                .where(Credential.expires_at.is_not(None), Credential.expires_at <= warn_limit)
                .order_by(Credential.expires_at).limit(8))
        ]
        out["recent_password_changes"] = [
            {"id": c.id, "name": c.name, "environment": c.environment.name, "color": c.environment.color,
             "changed_at": c.password_changed_at}
            for c in db.scalars(
                scope(select(Credential), Credential.environment_id, env_ids)
                .where(Credential.password_changed_at.is_not(None))
                .order_by(Credential.password_changed_at.desc()).limit(6))
        ]

    if p.can("versions.view"):
        dep_base = scope(select(ApplicationVersion), ApplicationVersion.environment_id, env_ids).subquery()
        out["cards"]["applications"] = db.scalar(select(func.count(func.distinct(dep_base.c.application_id))))
        out["cards"]["applications_total"] = db.scalar(select(func.count()).select_from(Application))
        out["cards"]["deployments"] = db.scalar(select(func.count()).select_from(dep_base))
        out["cards"]["versions"] = db.scalar(select(func.count(func.distinct(dep_base.c.current_version))))
        hist = select(VersionHistory).order_by(VersionHistory.changed_at.desc()).limit(8)
        if env_ids is not None:
            hist = hist.where(VersionHistory.environment_name.in_([e.name for e in envs] or ["-"]))
        out["recent_versions"] = [
            {"application": h.application_name, "component": h.component, "server": h.server_name,
             "environment": h.environment_name, "old": h.old_version, "new": h.new_version,
             "by": h.changed_by, "at": h.changed_at}
            for h in db.scalars(hist)
        ]

    if p.can("users.view"):
        out["cards"]["users"] = db.scalar(select(func.count()).select_from(User).where(User.is_active.is_(True)))
        out["cards"]["users_without_mfa"] = db.scalar(
            select(func.count()).select_from(User).where(User.is_active.is_(True), User.totp_enabled.is_(False)))

    last_backup = db.scalar(select(ConfigBackup.created_at).order_by(ConfigBackup.id.desc()).limit(1))
    out["last_backup_at"] = last_backup
    from .. import reports as reports_mod

    cfg, _ = reports_mod.load(db, reports_mod.EMAIL_KEY, reports_mod.DEFAULT_EMAIL)
    nr = reports_mod.next_run(cfg)
    out["next_report_at"] = nr.isoformat() if nr else None
    out["report_schedule"] = reports_mod.describe(cfg)

    if p.can("audit.view"):
        since = datetime.now(timezone.utc) - timedelta(hours=24)
        out["cards"]["failed_logins_24h"] = db.scalar(
            select(func.count()).select_from(AuditLog).where(AuditLog.action == "LOGIN_FAILED", AuditLog.created_at >= since))
        out["cards"]["password_views_24h"] = db.scalar(
            select(func.count()).select_from(AuditLog)
            .where(AuditLog.action.in_(["PASSWORD_VIEWED", "PASSWORD_COPIED"]), AuditLog.created_at >= since))
        out["recent_activity"] = [
            {"id": a.id, "at": a.created_at, "user": a.username, "action": a.action, "label": a.entity_label,
             "ip": a.ip_address}
            for a in db.scalars(select(AuditLog).order_by(AuditLog.id.desc()).limit(12))
        ]
    return out
