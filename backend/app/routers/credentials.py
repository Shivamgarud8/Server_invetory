import logging
from datetime import date, datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from ..audit import audit, diff
from ..config import get_settings
from ..db import get_db
from ..deps import Principal, require
from ..models import Credential, CredentialType, Server, credential_tags
from ..schemas import CredentialIn, CredentialOut, RevealIn, RevealOut
from ..security import VaultError, get_vault
from .common import csv_response, get_env, get_tags, like, scope

router = APIRouter(prefix="/api/credentials", tags=["credentials"])
log = logging.getLogger("tagid.credentials")

_FIELDS = [
    "name", "credential_type_id", "category", "server_id", "environment_id", "host", "port", "username",
    "url", "service", "description", "owner", "status", "expires_at", "notes",
]


def _query(p: Principal, q, environment_id, credential_type_id, status_, tag_id, server_id, expiring):
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
    if tag_id:
        stmt = stmt.where(Credential.id.in_(
            select(credential_tags.c.credential_id).where(credential_tags.c.tag_id == tag_id)))
    if expiring:
        limit = date.today() + timedelta(days=get_settings().credential_expiry_warning_days)
        stmt = stmt.where(Credential.expires_at.is_not(None), Credential.expires_at <= limit)
    return stmt.order_by(Credential.name)


def _snapshot(c: Credential) -> dict:
    d = {f: getattr(c, f) for f in _FIELDS}
    d["expires_at"] = c.expires_at.isoformat() if c.expires_at else None
    d["credential_type_id"] = c.credential_type.name if c.credential_type else c.credential_type_id
    d["environment_id"] = c.environment.name if c.environment else c.environment_id
    d["server_id"] = c.server.name if c.server else None
    d["tags"] = sorted(t.name for t in c.tags)
    return d


def _get_scoped(db: Session, p: Principal, cred_id: int) -> Credential:
    c = db.get(Credential, cred_id)
    if not c or not p.can_env(c.environment_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Credential not found")
    return c


def _apply(db: Session, p: Principal, c: Credential, body: CredentialIn) -> None:
    get_env(db, body.environment_id)
    if not db.get(CredentialType, body.credential_type_id):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Unknown credential type")
    if body.server_id is not None:
        srv = db.get(Server, body.server_id)
        if not srv or not p.can_env(srv.environment_id):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Unknown server")
    for f in _FIELDS:
        setattr(c, f, getattr(body, f))
    c.name = body.name.strip()
    c.tags = get_tags(db, body.tag_ids)


def _store_secret(c: Credential, secret: str) -> None:
    vault = get_vault()
    try:
        c.secret_enc = vault.store(c.id, secret)
    except VaultError as e:
        log.error("Vault store failed for credential %s: %s", c.id, e)
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "Secret storage unavailable")
    c.secret_provider = vault.name
    c.has_secret = True
    c.password_changed_at = datetime.now(timezone.utc)


@router.get("", response_model=list[CredentialOut])
def list_credentials(
    q: str | None = None, environment_id: int | None = None, credential_type_id: int | None = None,
    status_: str | None = Query(None, alias="status"), tag_id: int | None = None, server_id: int | None = None,
    expiring: bool = False, db: Session = Depends(get_db), p: Principal = Depends(require("credentials.view")),
):
    return list(db.scalars(_query(p, q, environment_id, credential_type_id, status_, tag_id, server_id, expiring)).unique())


@router.get("/export")
def export_credentials(
    request: Request, q: str | None = None, environment_id: int | None = None, credential_type_id: int | None = None,
    status_: str | None = Query(None, alias="status"), tag_id: int | None = None, server_id: int | None = None,
    expiring: bool = False, db: Session = Depends(get_db),
    p: Principal = Depends(require("credentials.view", "credentials.export")),
):
    creds = list(db.scalars(_query(p, q, environment_id, credential_type_id, status_, tag_id, server_id, expiring)).unique())
    audit(db, request, "CREDENTIALS_EXPORTED", p.user, details={"count": len(creds)})
    db.commit()
    header = ["Credential Name", "Type", "Category", "Environment", "Server", "Host/IP", "Port", "Username", "URL",
              "Service", "Owner", "Status", "Password Last Changed", "Expiry Date", "Tags", "Description", "Notes"]
    rows = [[
        c.name, c.credential_type.name, c.category, c.environment.name, c.server.name if c.server else None, c.host,
        c.port, c.username, c.url, c.service, c.owner, c.status,
        c.password_changed_at.date().isoformat() if c.password_changed_at else None,
        c.expires_at.isoformat() if c.expires_at else None, " ".join(t.name for t in c.tags), c.description, c.notes,
    ] for c in creds]
    return csv_response("credentials-no-passwords", header, rows)


@router.get("/{cred_id}", response_model=CredentialOut)
def get_credential(cred_id: int, db: Session = Depends(get_db), p: Principal = Depends(require("credentials.view"))):
    return _get_scoped(db, p, cred_id)


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
        _store_secret(c, body.password)
    db.flush()
    db.refresh(c)
    audit(db, request, "CREDENTIAL_CREATED", p.user, entity_type="credential", entity_id=c.id, entity_label=c.name,
          details=_snapshot(c))
    db.commit()
    return c


@router.put("/{cred_id}", response_model=CredentialOut)
def update_credential(
    cred_id: int, body: CredentialIn, request: Request, db: Session = Depends(get_db),
    p: Principal = Depends(require("credentials.update")),
):
    c = _get_scoped(db, p, cred_id)
    p.require_env(body.environment_id)
    before = _snapshot(c)
    _apply(db, p, c, body)
    c.updated_by_id = p.user.id
    if body.password:
        _store_secret(c, body.password)
    db.flush()
    db.refresh(c)
    changes = diff(before, _snapshot(c))
    if changes:
        audit(db, request, "CREDENTIAL_UPDATED", p.user, entity_type="credential", entity_id=c.id,
              entity_label=c.name, details=changes)
    if body.password:
        audit(db, request, "PASSWORD_CHANGED", p.user, entity_type="credential", entity_id=c.id, entity_label=c.name)
    db.commit()
    return c


@router.delete("/{cred_id}", status_code=204)
def delete_credential(
    cred_id: int, request: Request, db: Session = Depends(get_db), p: Principal = Depends(require("credentials.delete"))
):
    c = _get_scoped(db, p, cred_id)
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
    c = _get_scoped(db, p, cred_id)
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
