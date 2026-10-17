from collections import defaultdict
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..audit import audit
from ..db import get_db
from ..deps import Principal, require
from ..models import Application, ApplicationVersion, Environment, Server, ServiceDependency, VersionHistory
from ..schemas import (
    ApplicationIn,
    ApplicationOut,
    DependencyIn,
    DependencyOut,
    DeploymentIn,
    DeploymentOut,
    HistoryOut,
    VersionUpdateIn,
)
from .common import csv_response, get_env, like, scope

router = APIRouter(prefix="/api", tags=["versions"])


def _dep_out(d: ApplicationVersion) -> DeploymentOut:
    o = DeploymentOut.model_validate(d)
    o.updated_by_name = d.updated_by.username if d.updated_by else None
    return o


def _history(db: Session, d: ApplicationVersion, old: str | None, new: str, who: str, notes: str | None) -> None:
    db.add(VersionHistory(
        application_version_id=d.id, application_name=d.application.name, component=d.component,
        server_name=d.server.name if d.server else None, environment_name=d.environment.name,
        old_version=old, new_version=new, changed_by=who, notes=notes,
    ))


def _get_dep(db: Session, p: Principal, dep_id: int) -> ApplicationVersion:
    d = db.get(ApplicationVersion, dep_id)
    if not d or not p.can_env(d.environment_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Deployment not found")
    return d


def _check_refs(db: Session, p: Principal, body: DeploymentIn) -> None:
    p.require_env(body.environment_id)
    get_env(db, body.environment_id)
    if not db.get(Application, body.application_id):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Unknown application")
    if body.server_id is not None:
        srv = db.get(Server, body.server_id)
        if not srv or not p.can_env(srv.environment_id):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Unknown server")


def _label(d: ApplicationVersion) -> str:
    return f"{d.application.name} / {d.component} @ {d.server.name if d.server else '-'} ({d.environment.name})"


# ---------------------------------------------------------------- applications


@router.get("/applications", response_model=list[ApplicationOut])
def list_applications(db: Session = Depends(get_db), _: Principal = Depends(require("versions.view"))):
    counts = dict(db.execute(
        select(ApplicationVersion.application_id, func.count()).group_by(ApplicationVersion.application_id)).all())
    out = []
    for a in db.scalars(select(Application).order_by(Application.name)):
        o = ApplicationOut.model_validate(a)
        o.deployment_count = counts.get(a.id, 0)
        out.append(o)
    return out


@router.post("/applications", response_model=ApplicationOut, status_code=201)
def create_application(body: ApplicationIn, request: Request, db: Session = Depends(get_db), p: Principal = Depends(require("versions.create"))):
    a = Application(**body.model_dump())
    a.name = a.name.strip()
    db.add(a)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, "Application already exists")
    audit(db, request, "APPLICATION_CREATED", p.user, entity_type="application", entity_id=a.id, entity_label=a.name)
    db.commit()
    return a


@router.put("/applications/{app_id}", response_model=ApplicationOut)
def update_application(app_id: int, body: ApplicationIn, request: Request, db: Session = Depends(get_db), p: Principal = Depends(require("versions.update"))):
    a = db.get(Application, app_id)
    if not a:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Application not found")
    for k, v in body.model_dump().items():
        setattr(a, k, v)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, "Application already exists")
    audit(db, request, "APPLICATION_UPDATED", p.user, entity_type="application", entity_id=a.id, entity_label=a.name)
    db.commit()
    return a


@router.delete("/applications/{app_id}", status_code=204)
def delete_application(app_id: int, request: Request, db: Session = Depends(get_db), p: Principal = Depends(require("versions.delete"))):
    a = db.get(Application, app_id)
    if not a:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Application not found")
    audit(db, request, "APPLICATION_DELETED", p.user, entity_type="application", entity_id=a.id, entity_label=a.name)
    db.delete(a)
    db.commit()


# ---------------------------------------------------------------- deployments


def _dep_query(p: Principal, q, environment_id, application_id, server_id, client_id=None, service_type=None):
    stmt = (
        scope(select(ApplicationVersion), ApplicationVersion.environment_id, p.env_ids())
        .join(Application, ApplicationVersion.application_id == Application.id)
        .outerjoin(Server, ApplicationVersion.server_id == Server.id)
    )
    if q:
        t = like(q.strip())
        stmt = stmt.where(or_(Application.name.ilike(t), ApplicationVersion.component.ilike(t),
                              ApplicationVersion.current_version.ilike(t), Server.name.ilike(t),
                              ApplicationVersion.image.ilike(t)))
    if environment_id:
        stmt = stmt.where(ApplicationVersion.environment_id == environment_id)
    if application_id:
        stmt = stmt.where(ApplicationVersion.application_id == application_id)
    if server_id:
        stmt = stmt.where(ApplicationVersion.server_id == server_id)
    if client_id:
        stmt = stmt.where(Server.client_id == client_id)
    if service_type:
        stmt = stmt.where(ApplicationVersion.service_type == service_type)
    return stmt.order_by(Application.name, ApplicationVersion.component, Server.name)


@router.get("/deployments", response_model=list[DeploymentOut])
def list_deployments(
    q: str | None = None, environment_id: int | None = None, application_id: int | None = None,
    server_id: int | None = None, client_id: int | None = None, service_type: str | None = None,
    db: Session = Depends(get_db), p: Principal = Depends(require("versions.view")),
):
    return [_dep_out(d) for d in db.scalars(
        _dep_query(p, q, environment_id, application_id, server_id, client_id, service_type)).unique()]


@router.get("/deployments/export")
def export_deployments(
    request: Request, q: str | None = None, environment_id: int | None = None, application_id: int | None = None,
    server_id: int | None = None, db: Session = Depends(get_db), p: Principal = Depends(require("versions.view")),
):
    deps = list(db.scalars(_dep_query(p, q, environment_id, application_id, server_id)).unique())
    audit(db, request, "VERSIONS_EXPORTED", p.user, details={"count": len(deps)})
    db.commit()
    header = ["Application", "Component", "Server", "Environment", "Current Version", "Previous Version", "Image",
              "Deployed", "Updated By", "Notes"]
    rows = [[d.application.name, d.component, d.server.name if d.server else None, d.environment.name,
             d.current_version, d.previous_version, d.image, d.deployed_at.isoformat(),
             d.updated_by.username if d.updated_by else None, d.notes] for d in deps]
    return csv_response("versions", header, rows)


@router.post("/deployments", response_model=DeploymentOut, status_code=201)
def create_deployment(body: DeploymentIn, request: Request, db: Session = Depends(get_db), p: Principal = Depends(require("versions.create"))):
    _check_refs(db, p, body)
    data = body.model_dump()
    data["deployed_at"] = data["deployed_at"] or datetime.now(timezone.utc)
    d = ApplicationVersion(**data, updated_by_id=p.user.id)
    db.add(d)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, "This component is already tracked on that server/environment — update its version instead")
    db.refresh(d)
    _history(db, d, None, d.current_version, p.user.username, body.notes)
    audit(db, request, "VERSION_CREATED", p.user, entity_type="deployment", entity_id=d.id, entity_label=_label(d),
          details={"version": d.current_version})
    db.commit()
    return _dep_out(d)


@router.put("/deployments/{dep_id}", response_model=DeploymentOut)
def edit_deployment(dep_id: int, body: DeploymentIn, request: Request, db: Session = Depends(get_db), p: Principal = Depends(require("versions.update"))):
    """Edit the tracking record itself (component, server, env, notes). Version changes go through /version."""
    d = _get_dep(db, p, dep_id)
    _check_refs(db, p, body)
    old_version = d.current_version
    d.application_id = body.application_id
    d.component = body.component
    d.server_id = body.server_id
    d.environment_id = body.environment_id
    d.image = body.image
    d.notes = body.notes
    d.service_type = body.service_type
    d.port = body.port
    d.protocol = body.protocol
    d.health_url = body.health_url
    d.updated_by_id = p.user.id
    if body.current_version != old_version:
        d.previous_version = old_version
        d.current_version = body.current_version
        d.deployed_at = body.deployed_at or datetime.now(timezone.utc)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, "Another record already tracks this component there")
    db.refresh(d)
    if body.current_version != old_version:
        _history(db, d, old_version, d.current_version, p.user.username, body.notes)
    audit(db, request, "VERSION_UPDATED", p.user, entity_type="deployment", entity_id=d.id, entity_label=_label(d),
          details={"from": old_version, "to": d.current_version})
    db.commit()
    return _dep_out(d)


@router.post("/deployments/{dep_id}/version", response_model=DeploymentOut)
def update_version(dep_id: int, body: VersionUpdateIn, request: Request, db: Session = Depends(get_db), p: Principal = Depends(require("versions.update"))):
    d = _get_dep(db, p, dep_id)
    new = body.new_version.strip()
    if new == d.current_version:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "That is already the current version")
    old = d.current_version
    d.previous_version = old
    d.current_version = new
    d.deployed_at = body.deployed_at or datetime.now(timezone.utc)
    if body.image is not None:
        d.image = body.image or None
    if body.notes:
        d.notes = body.notes
    d.updated_by_id = p.user.id
    _history(db, d, old, new, p.user.username, body.notes)
    audit(db, request, "VERSION_UPDATED", p.user, entity_type="deployment", entity_id=d.id, entity_label=_label(d),
          details={"from": old, "to": new})
    db.commit()
    db.refresh(d)
    return _dep_out(d)


@router.post("/deployments/{dep_id}/rollback", response_model=DeploymentOut)
def rollback_version(dep_id: int, request: Request, db: Session = Depends(get_db), p: Principal = Depends(require("versions.update"))):
    d = _get_dep(db, p, dep_id)
    if not d.previous_version:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "No previous version recorded")
    return update_version(dep_id, VersionUpdateIn(new_version=d.previous_version, notes="Rollback"), request, db, p)


@router.delete("/deployments/{dep_id}", status_code=204)
def delete_deployment(dep_id: int, request: Request, db: Session = Depends(get_db), p: Principal = Depends(require("versions.delete"))):
    d = _get_dep(db, p, dep_id)
    audit(db, request, "VERSION_DELETED", p.user, entity_type="deployment", entity_id=d.id, entity_label=_label(d),
          details={"version": d.current_version})
    db.delete(d)
    db.commit()


# ---------------------------------------------------------------- service dependencies


@router.get("/service-dependencies", response_model=list[DependencyOut])
def list_dependencies(
    client_id: int | None = None, db: Session = Depends(get_db), p: Principal = Depends(require("versions.view"))
):
    stmt = select(ServiceDependency)
    if client_id:
        ids = select(ApplicationVersion.id).join(Server, ApplicationVersion.server_id == Server.id).where(
            Server.client_id == client_id)
        stmt = stmt.where(or_(ServiceDependency.from_service_id.in_(ids), ServiceDependency.to_service_id.in_(ids)))
    return list(db.scalars(stmt))


@router.post("/service-dependencies", response_model=DependencyOut, status_code=201)
def create_dependency(body: DependencyIn, request: Request, db: Session = Depends(get_db),
                      p: Principal = Depends(require("versions.update"))):
    if body.from_service_id == body.to_service_id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "A service cannot depend on itself")
    a, b = _get_dep(db, p, body.from_service_id), _get_dep(db, p, body.to_service_id)
    dep = ServiceDependency(**body.model_dump())
    db.add(dep)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, "This connection already exists")
    audit(db, request, "DEPENDENCY_CREATED", p.user, entity_type="dependency", entity_id=dep.id,
          entity_label=f"{_label(a)} → {_label(b)}")
    db.commit()
    return dep


@router.delete("/service-dependencies/{dep_id}", status_code=204)
def delete_dependency(dep_id: int, request: Request, db: Session = Depends(get_db),
                      p: Principal = Depends(require("versions.update"))):
    dep = db.get(ServiceDependency, dep_id)
    if not dep:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Connection not found")
    audit(db, request, "DEPENDENCY_DELETED", p.user, entity_type="dependency", entity_id=dep.id)
    db.delete(dep)
    db.commit()


# ---------------------------------------------------------------- history & matrix


@router.get("/version-history", response_model=list[HistoryOut])
def version_history(
    deployment_id: int | None = None, q: str | None = None, limit: int = 200,
    db: Session = Depends(get_db), p: Principal = Depends(require("versions.view")),
):
    stmt = select(VersionHistory).order_by(VersionHistory.changed_at.desc(), VersionHistory.id.desc()).limit(min(limit, 1000))
    env_ids = p.env_ids()
    if env_ids is not None:
        names = list(db.scalars(select(Environment.name).where(Environment.id.in_(env_ids or {-1}))))
        stmt = stmt.where(VersionHistory.environment_name.in_(names or ["-"]))
    if deployment_id:
        stmt = stmt.where(VersionHistory.application_version_id == deployment_id)
    if q:
        t = like(q.strip())
        stmt = stmt.where(or_(VersionHistory.application_name.ilike(t), VersionHistory.component.ilike(t),
                              VersionHistory.server_name.ilike(t), VersionHistory.new_version.ilike(t)))
    return list(db.scalars(stmt))


def _vkey(v: str):
    """Loose semantic-version sort key: v3.33.10 > v3.33.9."""
    parts = []
    for chunk in v.lstrip("vV").replace("-", ".").split("."):
        parts.append((0, int(chunk), "") if chunk.isdigit() else (1, 0, chunk))
    return parts


@router.get("/version-matrix")
def version_matrix(db: Session = Depends(get_db), p: Principal = Depends(require("versions.view"))):
    env_ids = p.env_ids()
    envs = list(db.scalars(scope(select(Environment), Environment.id, env_ids).order_by(Environment.sort_order)))
    deps = db.scalars(scope(select(ApplicationVersion), ApplicationVersion.environment_id, env_ids)).unique()

    grid: dict[tuple[str, str], dict[int, dict[str, list[str]]]] = defaultdict(lambda: defaultdict(lambda: defaultdict(list)))
    for d in deps:
        grid[(d.application.name, d.component)][d.environment_id][d.current_version].append(d.server.name if d.server else "-")

    rows = []
    for (app, comp), cells in sorted(grid.items()):
        all_versions = {v for c in cells.values() for v in c}
        latest = max(all_versions, key=_vkey) if all_versions else None
        rows.append({
            "application": app,
            "component": comp,
            "latest": latest,
            "cells": {
                str(env_id): [
                    {"version": v, "servers": sorted(srvs), "outdated": v != latest}
                    for v, srvs in sorted(c.items(), key=lambda kv: _vkey(kv[0]), reverse=True)
                ]
                for env_id, c in cells.items()
            },
            "drift": len(all_versions) > 1,
        })
    return {"environments": [{"id": e.id, "name": e.name, "color": e.color} for e in envs], "rows": rows}
