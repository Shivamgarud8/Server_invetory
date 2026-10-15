from datetime import datetime

from fastapi import APIRouter, Depends, Request
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from ..audit import audit
from ..db import get_db
from ..deps import Principal, require
from ..models import AuditLog
from ..schemas import AuditOut
from .common import csv_response, like

router = APIRouter(prefix="/api/audit-logs", tags=["audit"])


def _query(q, action, username, entity_type, date_from, date_to, entity_id=None):
    stmt = select(AuditLog)
    if q:
        t = like(q.strip())
        stmt = stmt.where(or_(AuditLog.entity_label.ilike(t), AuditLog.username.ilike(t),
                              AuditLog.ip_address.ilike(t), AuditLog.action.ilike(t)))
    if action:
        stmt = stmt.where(AuditLog.action == action)
    if username:
        stmt = stmt.where(AuditLog.username == username)
    if entity_type:
        stmt = stmt.where(AuditLog.entity_type == entity_type)
    if entity_id:
        stmt = stmt.where(AuditLog.entity_id == entity_id)
    if date_from:
        stmt = stmt.where(AuditLog.created_at >= date_from)
    if date_to:
        stmt = stmt.where(AuditLog.created_at <= date_to)
    return stmt


@router.get("")
def list_audit(
    q: str | None = None, action: str | None = None, username: str | None = None, entity_type: str | None = None,
    entity_id: int | None = None, date_from: datetime | None = None, date_to: datetime | None = None,
    page: int = 1, page_size: int = 50,
    db: Session = Depends(get_db), _: Principal = Depends(require("audit.view")),
):
    page_size = max(1, min(page_size, 200))
    stmt = _query(q, action, username, entity_type, date_from, date_to, entity_id)
    total = db.scalar(select(func.count()).select_from(stmt.subquery()))
    rows = db.scalars(stmt.order_by(AuditLog.id.desc()).offset((max(page, 1) - 1) * page_size).limit(page_size))
    return {"total": total, "items": [AuditOut.model_validate(r) for r in rows]}


@router.get("/actions")
def list_actions(db: Session = Depends(get_db), _: Principal = Depends(require("audit.view"))):
    return sorted(db.scalars(select(AuditLog.action).distinct()))


@router.get("/export")
def export_audit(
    request: Request, q: str | None = None, action: str | None = None, username: str | None = None,
    entity_type: str | None = None, date_from: datetime | None = None, date_to: datetime | None = None,
    db: Session = Depends(get_db), p: Principal = Depends(require("audit.view")),
):
    rows = list(db.scalars(_query(q, action, username, entity_type, date_from, date_to).order_by(AuditLog.id.desc()).limit(50000)))
    audit(db, request, "AUDIT_EXPORTED", p.user, details={"count": len(rows)})
    db.commit()
    return csv_response(
        "audit-log",
        ["Time", "User", "Action", "Entity Type", "Entity", "IP", "Details"],
        [[r.created_at.isoformat(), r.username, r.action, r.entity_type, r.entity_label, r.ip_address,
          r.details] for r in rows],
    )
