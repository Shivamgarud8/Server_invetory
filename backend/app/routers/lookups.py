from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..audit import audit
from ..db import get_db
from ..deps import Principal, get_principal, require
from ..models import CredentialType, Environment, Tag
from ..schemas import (
    CredentialTypeIn,
    CredentialTypeOut,
    EnvironmentIn,
    EnvironmentOut,
    TagIn,
    TagOut,
)

router = APIRouter(prefix="/api", tags=["lookups"])

# (model, input schema, output schema, audit entity, order column)
_KINDS = {
    "environments": (Environment, EnvironmentIn, EnvironmentOut, "environment", Environment.sort_order),
    "tags": (Tag, TagIn, TagOut, "tag", Tag.name),
    "credential-types": (CredentialType, CredentialTypeIn, CredentialTypeOut, "credential_type", CredentialType.name),
}


def _register(path: str):
    model, schema_in, schema_out, entity, order = _KINDS[path]

    @router.get(f"/{path}", response_model=list[schema_out], name=f"list_{entity}")
    def list_items(db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
        stmt = select(model).order_by(order)
        if model is Environment and p.env_ids() is not None:
            stmt = stmt.where(Environment.id.in_(p.env_ids() or {-1}))
        return list(db.scalars(stmt))

    @router.post(f"/{path}", response_model=schema_out, status_code=201, name=f"create_{entity}")
    def create_item(
        body: schema_in, request: Request, db: Session = Depends(get_db),
        p: Principal = Depends(require("settings.manage")),
    ):
        obj = model(**body.model_dump())
        db.add(obj)
        try:
            db.flush()
        except IntegrityError:
            db.rollback()
            raise HTTPException(status.HTTP_409_CONFLICT, "Name already exists")
        audit(db, request, f"{entity.upper()}_CREATED", p.user, entity_type=entity, entity_id=obj.id, entity_label=obj.name)
        db.commit()
        return obj

    @router.put(f"/{path}/{{item_id}}", response_model=schema_out, name=f"update_{entity}")
    def update_item(
        item_id: int, body: schema_in, request: Request, db: Session = Depends(get_db),
        p: Principal = Depends(require("settings.manage")),
    ):
        obj = db.get(model, item_id)
        if not obj:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
        for k, v in body.model_dump().items():
            setattr(obj, k, v)
        try:
            db.flush()
        except IntegrityError:
            db.rollback()
            raise HTTPException(status.HTTP_409_CONFLICT, "Name already exists")
        audit(db, request, f"{entity.upper()}_UPDATED", p.user, entity_type=entity, entity_id=obj.id, entity_label=obj.name)
        db.commit()
        return obj

    @router.delete(f"/{path}/{{item_id}}", status_code=204, name=f"delete_{entity}")
    def delete_item(
        item_id: int, request: Request, db: Session = Depends(get_db),
        p: Principal = Depends(require("settings.manage")),
    ):
        obj = db.get(model, item_id)
        if not obj:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
        label = obj.name
        try:
            db.delete(obj)
            db.flush()
        except IntegrityError:
            db.rollback()
            raise HTTPException(status.HTTP_409_CONFLICT, "Still in use by servers, credentials or deployments")
        audit(db, request, f"{entity.upper()}_DELETED", p.user, entity_type=entity, entity_id=item_id, entity_label=label)
        db.commit()


for _path in _KINDS:
    _register(_path)
