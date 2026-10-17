import logging
from datetime import date, datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from ..audit import audit, diff
from ..config import get_settings
from ..db import get_db
from ..deps import Principal, require
from ..models import ApplicationVersion, Client, Credential, CredentialSecretHistory, CredentialType, Server, credential_tags
from ..schemas import (
    CredentialIn,
    CredentialOut,
    HistoryEntryOut,
    ReauthIn,
    RevealIn,
    RevealOut,
    SetSecretIn,
)
from ..security import VaultError, get_vault, verify_password
from .common import csv_response, get_env, get_tags, like, scope

router = APIRouter(prefix="/api/credentials", tags=["credentials"])
log = logging.getLogger("tagid.credentials")

HISTORY_LIMIT = 5

_FIELDS = [
    "name", "credential_type_id", "category", "server_id", "client_id", "service_id", "environment_id", "host",
    "port", "username", "url", "service", "description", "owner", "status", "expires_at", "notes",
    "rotation_policy", "rotation_interval_days", "next_rotation_at",
]


def _query(p: Principal, q, environment_id, credential_type_id, status_, tag_id, server_id, expiring,
           client_id=None, service_id=None, rotation=None):
    stmt = scope(select(Credential), Credential.environment_id, p.env_ids()).outerjoin(Server, Credential.server_id == Server.id)
    if q:
        t = like(q.strip())
        stmt = stmt.where(or_(
            Credential.name.ilike(t), Credential.username.ilike(t), Credential.host.ilike(t),
            Credential.service.ilike(t), Credential.url.ilike(t), Credential.owner.ilike(t),
            Credential.description.ilike(t), Server.name.ilike(t),
        ))
    if environment_id:
        stmt = stmt.where(Credential.environment_id == environment_id)
    if credential_type_id:
        stmt = stmt.where(Credential.credential_type_id == credential_type_id)
    if status_:
        stmt = stmt.where(Credential.status == status_)
    if server_id:
        stmt = stmt.where(Credential.server_id == server_id)
    if client_id:
        stmt = stmt.where(Credential.client_id == client_id)
    if service_id:
        stmt = stmt.where(Credential.service_id == service_id)
    if tag_id:
        stmt = stmt.where(Credential.id.in_(
            select(credential_tags.c.credential_id).where(credential_tags.c.tag_id == tag_id)))
    if expiring:
        limit = date.today() + timedelta(days=get_settings().credential_expiry_warning_days)
        stmt = stmt.where(Credential.expires_at.is_not(None), Credential.expires_at <= limit)
    if rotation == "due":  # overdue or due within the warning window
        limit = date.today() + timedelta(days=get_settings().credential_expiry_warning_days)
        stmt = stmt.where(Credential.rotation_policy == "periodic", Credential.next_rotation_at <= limit)
    elif rotation == "pending":
        stmt = stmt.where(Credential.pending_verification.is_(True))
    return stmt.order_by(Credential.name)


def _history_counts(db: Session, ids: list[int]) -> dict[int, int]:
    if not ids:
        return {}
    return dict(db.execute(
        select(CredentialSecretHistory.credential_id, func.count())
        .where(CredentialSecretHistory.credential_id.in_(ids)).group_by(CredentialSecretHistory.credential_id)
    ).all())


def _out(c: Credential, counts: dict[int, int]) -> CredentialOut:
    o = CredentialOut.model_validate(c)
    o.history_count = counts.get(c.id, 0)
    return o


def _snapshot(c: Credential) -> dict:
    d = {f: getattr(c, f) for f in _FIELDS}
    for k in ("expires_at", "next_rotation_at"):
        d[k] = d[k].isoformat() if d[k] else None
    d["credential_type_id"] = c.credential_type.name if c.credential_type else c.credential_type_id
    d["environment_id"] = c.environment.name if c.environment else c.environment_id
    d["server_id"] = c.server.name if c.server else None
    d["client_id"] = c.client.name if c.client else None
    d["service_id"] = c.service_id
    d["tags"] = sorted(t.name for t in c.tags)
    return d


def get_credential_scoped(db: Session, p: Principal, cred_id: int) -> Credential:
    c = db.get(Credential, cred_id)
    if not c or not p.can_env(c.environment_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Credential not found")
    return c


def _apply(db: Session, p: Principal, c: Credential, body: CredentialIn) -> None:
    get_env(db, body.environment_id)
    if not db.get(CredentialType, body.credential_type_id):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Unknown credential type")
    srv = None
    if body.server_id is not None:
        srv = db.get(Server, body.server_id)
        if not srv or not p.can_env(srv.environment_id):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Unknown server")
    if body.client_id is not None and not db.get(Client, body.client_id):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Unknown client")
    if body.service_id is not None:
        svc = db.get(ApplicationVersion, body.service_id)
        if not svc or not p.can_env(svc.environment_id):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Unknown service")
    if body.rotation_policy == "periodic" and not body.rotation_interval_days:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Periodic rotation needs a rotation interval (days)")
    for f in _FIELDS:
        setattr(c, f, getattr(body, f))
    c.name = body.name.strip()
    if c.client_id is None and srv is not None:
        c.client_id = srv.client_id  # inherit the server's client
    if c.rotation_policy == "static":
        c.rotation_interval_days = None
        c.next_rotation_at = None
    elif c.next_rotation_at is None:
        base = (c.password_changed_at or datetime.now(timezone.utc)).date()
        c.next_rotation_at = base + timedelta(days=c.rotation_interval_days)
    c.tags = get_tags(db, body.tag_ids)


def store_secret(db: Session, c: Credential, secret: str, actor: str, reason: str | None, *, is_change: bool) -> None:
    """Save a new secret; the previous one goes to the (max 5) encrypted history."""
    vault = get_vault()
    now = datetime.now(timezone.utc)
    try:
        if c.has_secret and c.secret_provider == vault.name:
            ref = vault.archive(c.id, c.secret_enc)
            db.add(CredentialSecretHistory(
                credential_id=c.id, provider=vault.name, valid_from=c.password_changed_at, replaced_at=now,
                replaced_by=actor, reason=reason, **ref,
            ))
        c.secret_enc = vault.store(c.id, secret)
    except VaultError as e:
        log.error("Vault operation failed for credential %s: %s", c.id, e)
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "Secret storage unavailable")
    except Exception as e:  # noqa: BLE001 — undecryptable old secret: keep going, but never leak details
        log.error("Could not archive previous secret of credential %s: %s", c.id, type(e).__name__)
        c.secret_enc = vault.store(c.id, secret)
    db.flush()
    old = list(db.scalars(
        select(CredentialSecretHistory).where(CredentialSecretHistory.credential_id == c.id)
        .order_by(CredentialSecretHistory.replaced_at.desc(), CredentialSecretHistory.id.desc()).offset(HISTORY_LIMIT)
    ))
    for h in old:
        db.delete(h)
    c.secret_provider = vault.name
    c.has_secret = True
    c.password_changed_at = now
    c.last_change_reason = reason
    if is_change:
        # The portal only records the new value; someone must confirm it was changed on the real system
        c.pending_verification = True
    if c.rotation_policy == "periodic" and c.rotation_interval_days:
        c.next_rotation_at = now.date() + timedelta(days=c.rotation_interval_days)


def _reauth(db: Session, request: Request, p: Principal, password: str, what: str) -> None:
    if not verify_password(password, p.user.password_hash):
        audit(db, request, "REAUTH_FAILED", p.user, details={"for": what})
        db.commit()
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Password is incorrect")


@router.get("", response_model=list[CredentialOut])
def list_credentials(
    q: str | None = None, environment_id: int | None = None, credential_type_id: int | None = None,
    status_: str | None = Query(None, alias="status"), tag_id: int | None = None, server_id: int | None = None,
    client_id: int | None = None, service_id: int | None = None, rotation: str | None = None,
    expiring: bool = False, db: Session = Depends(get_db), p: Principal = Depends(require("credentials.view")),
):
    creds = list(db.scalars(_query(p, q, environment_id, credential_type_id, status_, tag_id, server_id, expiring,
                                   client_id, service_id, rotation)).unique())
    counts = _history_counts(db, [c.id for c in creds])
    return [_out(c, counts) for c in creds]


@router.get("/export")
def export_credentials(
    request: Request, q: str | None = None, environment_id: int | None = None, credential_type_id: int | None = None,
    status_: str | None = Query(None, alias="status"), tag_id: int | None = None, server_id: int | None = None,
    client_id: int | None = None, expiring: bool = False, db: Session = Depends(get_db),
    p: Principal = Depends(require("credentials.view", "credentials.export")),
):
    creds = list(db.scalars(_query(p, q, environment_id, credential_type_id, status_, tag_id, server_id, expiring,
                                   client_id)).unique())
    audit(db, request, "CREDENTIALS_EXPORTED", p.user, details={"count": len(creds)})
    db.commit()
    header = ["Credential Name", "Client", "Type", "Category", "Environment", "Server", "Host/IP", "Port", "Username",
              "URL", "Service", "Owner", "Status", "Rotation", "Next Rotation", "Password Last Changed", "Expiry Date",
              "Tags", "Description", "Notes"]
    rows = [[
        c.name, c.client.name if c.client else None, c.credential_type.name, c.category, c.environment.name,
        c.server.name if c.server else None, c.host, c.port, c.username, c.url, c.service, c.owner, c.status,
        c.rotation_policy, c.next_rotation_at.isoformat() if c.next_rotation_at else None,
        c.password_changed_at.date().isoformat() if c.password_changed_at else None,
        c.expires_at.isoformat() if c.expires_at else None, " ".join(t.name for t in c.tags), c.description, c.notes,
    ] for c in creds]
    return csv_response("credentials-no-passwords", header, rows)


@router.get("/{cred_id}", response_model=CredentialOut)
def get_credential(cred_id: int, db: Session = Depends(get_db), p: Principal = Depends(require("credentials.view"))):
    c = get_credential_scoped(db, p, cred_id)
    return _out(c, _history_counts(db, [c.id]))


@router.post("", response_model=CredentialOut, status_code=201)
def create_credential(
    body: CredentialIn, request: Request, db: Session = Depends(get_db), p: Principal = Depends(require("credentials.create"))
):
    p.require_env(body.environment_id)
    c = Credential(created_by_id=p.user.id, updated_by_id=p.user.id, secret_provider=get_vault().name)
    _apply(db, p, c, body)
    db.add(c)
    db.flush()  # need the id: it is bound into the ciphertext / vault path
    if body.password:
        store_secret(db, c, body.password, p.user.username, body.change_reason or "Initial password", is_change=False)
    db.flush()
    db.refresh(c)
    audit(db, request, "CREDENTIAL_CREATED", p.user, entity_type="credential", entity_id=c.id, entity_label=c.name,
          details=_snapshot(c))
    db.commit()
    return _out(c, {})


@router.put("/{cred_id}", response_model=CredentialOut)
def update_credential(
    cred_id: int, body: CredentialIn, request: Request, db: Session = Depends(get_db),
    p: Principal = Depends(require("credentials.update")),
):
    c = get_credential_scoped(db, p, cred_id)
    p.require_env(body.environment_id)
    before = _snapshot(c)
    _apply(db, p, c, body)
    c.updated_by_id = p.user.id
    if body.password:
        store_secret(db, c, body.password, p.user.username, body.change_reason or "Changed in credential form",
                     is_change=True)
    db.flush()
    db.refresh(c)
    changes = diff(before, _snapshot(c))
    if changes:
        audit(db, request, "CREDENTIAL_UPDATED", p.user, entity_type="credential", entity_id=c.id,
              entity_label=c.name, details=changes)
    if body.password:
        audit(db, request, "PASSWORD_CHANGED", p.user, entity_type="credential", entity_id=c.id, entity_label=c.name,
              details={"reason": c.last_change_reason})
    db.commit()
    return _out(c, _history_counts(db, [c.id]))


@router.post("/{cred_id}/password", response_model=CredentialOut)
def set_password(
    cred_id: int, body: SetSecretIn, request: Request, db: Session = Depends(get_db),
    p: Principal = Depends(require("credentials.update")),
):
    """Assign a new password (e.g. from the generator). The old one moves to history."""
    c = get_credential_scoped(db, p, cred_id)
    store_secret(db, c, body.password, p.user.username, body.reason.strip(), is_change=c.has_secret)
    c.updated_by_id = p.user.id
    audit(db, request, "PASSWORD_CHANGED", p.user, entity_type="credential", entity_id=c.id, entity_label=c.name,
          details={"reason": body.reason.strip()})
    db.commit()
    db.refresh(c)
    return _out(c, _history_counts(db, [c.id]))


@router.post("/{cred_id}/verify", response_model=CredentialOut)
def verify_rotation(
    cred_id: int, request: Request, db: Session = Depends(get_db),
    p: Principal = Depends(require("credentials.update")),
):
    """Confirm the new password was actually applied (and tested) on the target system."""
    c = get_credential_scoped(db, p, cred_id)
    c.pending_verification = False
    audit(db, request, "PASSWORD_ROTATION_VERIFIED", p.user, entity_type="credential", entity_id=c.id,
          entity_label=c.name)
    db.commit()
    return _out(c, _history_counts(db, [c.id]))


@router.get("/{cred_id}/history", response_model=list[HistoryEntryOut])
def password_history(cred_id: int, db: Session = Depends(get_db), p: Principal = Depends(require("credentials.view"))):
    """Change timeline (dates, who, why) — never the secret values."""
    c = get_credential_scoped(db, p, cred_id)
    rows = db.scalars(
        select(CredentialSecretHistory).where(CredentialSecretHistory.credential_id == c.id)
        .order_by(CredentialSecretHistory.replaced_at.desc(), CredentialSecretHistory.id.desc())
    )
    return [HistoryEntryOut(id=h.id, valid_from=h.valid_from, replaced_at=h.replaced_at, replaced_by=h.replaced_by,
                            reason=h.reason) for h in rows]


@router.post("/{cred_id}/history/{entry_id}/reveal", response_model=RevealOut)
def reveal_history(
    cred_id: int, entry_id: int, body: ReauthIn, request: Request, db: Session = Depends(get_db),
    p: Principal = Depends(require("credentials.view_password", "credentials.view_history")),
):
    c = get_credential_scoped(db, p, cred_id)
    _reauth(db, request, p, body.current_password, "history reveal")
    h = db.get(CredentialSecretHistory, entry_id)
    if not h or h.credential_id != c.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "History entry not found")
    vault = get_vault()
    if h.provider != vault.name:
        raise HTTPException(status.HTTP_409_CONFLICT, f"Stored with the '{h.provider}' provider")
    try:
        secret = vault.read_history(c.id, h)
    except Exception as e:  # noqa: BLE001
        log.error("History read failed for credential %s: %s", c.id, type(e).__name__)
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "Unable to decrypt secret")
    audit(db, request, "PASSWORD_HISTORY_VIEWED", p.user, entity_type="credential", entity_id=c.id,
          entity_label=c.name, details={"replaced_at": h.replaced_at.isoformat()})
    db.commit()
    return RevealOut(password=secret)


@router.delete("/{cred_id}", status_code=204)
def delete_credential(
    cred_id: int, request: Request, db: Session = Depends(get_db), p: Principal = Depends(require("credentials.delete"))
):
    c = get_credential_scoped(db, p, cred_id)
    audit(db, request, "CREDENTIAL_DELETED", p.user, entity_type="credential", entity_id=c.id, entity_label=c.name,
          details=_snapshot(c))
    if c.has_secret and c.secret_provider == "hashicorp":
        try:
            get_vault().delete(c.id)
        except VaultError as e:
            log.error("Vault delete failed for credential %s: %s", c.id, e)
            raise HTTPException(status.HTTP_502_BAD_GATEWAY, "Secret storage unavailable")
    db.delete(c)
    db.commit()


@router.post("/{cred_id}/reveal", response_model=RevealOut)
def reveal_password(
    cred_id: int, body: RevealIn, request: Request, db: Session = Depends(get_db),
    p: Principal = Depends(require("credentials.view", "credentials.view_password")),
):
    c = get_credential_scoped(db, p, cred_id)
    if not c.has_secret:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No password stored for this credential")
    vault = get_vault()
    if c.secret_provider != vault.name:
        raise HTTPException(status.HTTP_409_CONFLICT, f"Secret is stored in '{c.secret_provider}' provider")
    try:
        secret = vault.read(c.id, c.secret_enc)
    except Exception as e:  # noqa: BLE001 — never leak crypto/vault internals to the client
        log.error("Secret read failed for credential %s: %s", c.id, type(e).__name__)
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "Unable to decrypt secret")
    action = "PASSWORD_COPIED" if body.purpose == "copy" else "PASSWORD_VIEWED"
    label = f"{c.server.name} / {c.username}" if c.server and c.username else c.name
    audit(db, request, action, p.user, entity_type="credential", entity_id=c.id, entity_label=label)
    db.commit()
    return RevealOut(password=secret)
