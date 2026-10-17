import json
from datetime import datetime

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile, status
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import backup
from ..audit import audit
from ..db import get_db
from ..deps import Principal, require
from ..models import ConfigBackup
from ..security import decrypt_bundle, encrypt_bundle, verify_password
from .credentials import store_secret

router = APIRouter(prefix="/api/backup", tags=["backup"])
MAX_UPLOAD = 50 * 1024 * 1024


def _all_envs(p: Principal) -> None:
    if p.env_ids() is not None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Backups and restores need access to all environments")


def _reauth(db: Session, request: Request, p: Principal, password: str, what: str) -> None:
    if not verify_password(password, p.user.password_hash):
        audit(db, request, "REAUTH_FAILED", p.user, details={"for": what})
        db.commit()
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Password is incorrect")


def _download(content: dict, name: str) -> Response:
    return Response(json.dumps(content, indent=1, default=str), media_type="application/json",
                    headers={"Content-Disposition": f'attachment; filename="{name}"'})


@router.get("/inventory")
def download_inventory(request: Request, db: Session = Depends(get_db), p: Principal = Depends(require("backup.export"))):
    """Full inventory JSON — never contains passwords or secrets."""
    _all_envs(p)
    inv = backup.build_inventory(db)
    audit(db, request, "BACKUP_EXPORTED", p.user, details={"checksum": inv["manifest"]["checksum_sha256"]})
    db.commit()
    return _download(inv, f"tagid-inventory-{datetime.now():%Y%m%d-%H%M}.json")


class BundleIn(BaseModel):
    passphrase: str = Field(min_length=12, max_length=256)
    current_password: str = Field(min_length=1, max_length=256)


@router.post("/bundle")
def download_bundle(body: BundleIn, request: Request, db: Session = Depends(get_db),
                    p: Principal = Depends(require("backup.export", "backup.export_secrets"))):
    """Encrypted recovery bundle including current secrets. Passphrase is never stored or sent anywhere."""
    _all_envs(p)
    _reauth(db, request, p, body.current_password, "recovery bundle")
    inv = backup.build_inventory(db, include_secrets=True)
    bundle = encrypt_bundle(body.passphrase, json.dumps(inv, default=str).encode())
    audit(db, request, "RECOVERY_BUNDLE_EXPORTED", p.user,
          details={"secrets": inv["manifest"]["counts"].get("secrets", 0)})
    db.commit()
    return _download(bundle, f"tagid-recovery-bundle-{datetime.now():%Y%m%d-%H%M}.tagid.json")


@router.get("/snapshots")
def list_snapshots(db: Session = Depends(get_db), p: Principal = Depends(require("backup.export"))):
    return [{"id": b.id, "created_at": b.created_at, "kind": b.kind, "checksum": b.checksum,
             "size_bytes": b.size_bytes, "summary": b.summary, "created_by": b.created_by}
            for b in db.scalars(select(ConfigBackup).order_by(ConfigBackup.id.desc()))]


@router.post("/snapshots", status_code=201)
def create_snapshot(request: Request, db: Session = Depends(get_db), p: Principal = Depends(require("backup.export"))):
    _all_envs(p)
    snap = backup.take_snapshot(db, "manual", p.user.username)
    audit(db, request, "CONFIG_SNAPSHOT_CREATED", p.user, details={"checksum": snap.checksum})
    db.commit()
    return {"id": snap.id, "checksum": snap.checksum}


@router.get("/snapshots/{snap_id}")
def download_snapshot(snap_id: int, request: Request, db: Session = Depends(get_db),
                      p: Principal = Depends(require("backup.export"))):
    _all_envs(p)
    snap = db.get(ConfigBackup, snap_id)
    if not snap:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Snapshot not found")
    audit(db, request, "BACKUP_EXPORTED", p.user, details={"snapshot": snap_id})
    db.commit()
    return _download(snap.content, f"tagid-inventory-{snap.created_at:%Y%m%d-%H%M}.json")


async def _read_upload(file: UploadFile, passphrase: str | None) -> tuple[dict, bool]:
    raw = await file.read(MAX_UPLOAD + 1)
    if len(raw) > MAX_UPLOAD:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "File larger than 50 MB")
    try:
        doc = json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Not a valid JSON file")
    encrypted = isinstance(doc, dict) and doc.get("format") == "tagid-recovery-bundle"
    if encrypted:
        if not passphrase:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "This is an encrypted recovery bundle — enter its passphrase")
        try:
            doc = json.loads(decrypt_bundle(passphrase, doc))
        except Exception:  # noqa: BLE001
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Wrong passphrase or damaged bundle")
    return doc, encrypted


@router.post("/import/preview")
async def import_preview(
    file: UploadFile = File(...), passphrase: str | None = Form(None),
    db: Session = Depends(get_db), p: Principal = Depends(require("backup.restore")),
):
    _all_envs(p)
    doc, encrypted = await _read_upload(file, passphrase)
    try:
        data = backup.validate(doc)
    except backup.ImportErrorWithDetail as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e))
    return {"manifest": doc["manifest"], "encrypted": encrypted, "plan": backup.plan(db, data)}


@router.post("/import/apply")
async def import_apply(
    request: Request, file: UploadFile = File(...), passphrase: str | None = Form(None),
    mode: str = Form("merge"), restore_secrets: bool = Form(False), overwrite_secrets: bool = Form(False),
    current_password: str = Form(...), db: Session = Depends(get_db),
    p: Principal = Depends(require("backup.restore")),
):
    """Restores inventory records only. Never runs commands, deploys, or changes passwords on real servers."""
    _all_envs(p)
    if mode not in ("merge", "add_only"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "mode must be 'merge' or 'add_only'")
    if restore_secrets and not p.can("credentials.update"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Restoring secrets needs the credentials.update permission")
    _reauth(db, request, p, current_password, "restore")
    doc, encrypted = await _read_upload(file, passphrase)
    try:
        data = backup.validate(doc)
        pre = backup.take_snapshot(db, "pre-import", p.user.username)
        stats = backup.apply(db, data, mode=mode, restore_secrets=restore_secrets and encrypted,
                             overwrite_secrets=overwrite_secrets, actor=p.user.username, store_secret_fn=store_secret)
    except backup.ImportErrorWithDetail as e:
        db.rollback()
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e))
    except HTTPException:
        db.rollback()
        raise
    except Exception as e:  # noqa: BLE001
        db.rollback()
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Import failed, nothing was changed: {type(e).__name__}: {str(e)[:200]}")
    audit(db, request, "BACKUP_RESTORED", p.user, entity_label=file.filename,
          details={"mode": mode, "encrypted": encrypted, "pre_import_snapshot": pre.id, **stats})
    db.commit()
    return {"stats": stats, "pre_import_snapshot": pre.id}
