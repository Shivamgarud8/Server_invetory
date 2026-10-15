from fastapi import Request
from sqlalchemy.orm import Session

from .models import AuditLog, User
from .netutil import client_ip

# Keys that must never land in audit details
_SENSITIVE = {"password", "secret", "token", "totp", "new_password", "current_password", "secret_enc"}


def _clean(details: dict | None) -> dict | None:
    if not details:
        return None
    return {k: ("***" if k.lower() in _SENSITIVE else v) for k, v in details.items()}


def audit(
    db: Session,
    request: Request | None,
    action: str,
    user: User | None = None,
    *,
    username: str | None = None,
    entity_type: str | None = None,
    entity_id: int | None = None,
    entity_label: str | None = None,
    details: dict | None = None,
) -> None:
    """Adds an audit row to the current transaction; caller commits."""
    db.add(
        AuditLog(
            user_id=user.id if user else None,
            username=user.username if user else username,
            action=action,
            entity_type=entity_type,
            entity_id=entity_id,
            entity_label=entity_label,
            ip_address=client_ip(request) if request else None,
            user_agent=(request.headers.get("user-agent", "")[:255] if request else None),
            details=_clean(details),
        )
    )


def diff(before: dict, after: dict) -> dict:
    """Field-level change summary for update audits."""
    return {k: {"from": before.get(k), "to": v} for k, v in after.items() if before.get(k) != v}
