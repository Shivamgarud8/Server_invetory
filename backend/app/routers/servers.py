from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy import String, cast, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..audit import audit, diff
from ..db import get_db
from ..deps import Principal, require
from ..models import ApplicationVersion, Client, Credential, Server, ServerNetwork, ServerSpec, server_tags
from ..schemas import ServerIn, ServerOut
from .common import csv_response, get_env, get_tags, like, scope

router = APIRouter(prefix="/api/servers", tags=["servers"])

_FIELDS = [
    "name", "hostname", "environment_id", "client_id", "server_type", "role", "provider", "location", "os_name",
    "os_version", "kernel_version", "architecture", "docker_version", "compose_version", "status", "owner",
    "purpose", "notes", "ssh_user", "ssh_port", "ssh_auth_method", "ssh_key_ref", "mount_points", "exposed_ports",
    "firewall_notes", "backup_policy", "recovery_instructions",
]


def _query(p: Principal, q: str | None, environment_id: int | None, status_: str | None,
           server_type: str | None, tag_id: int | None, client_id: int | None = None):
    stmt = scope(select(Server), Server.environment_id, p.env_ids())
    if q:
        t = like(q.strip())
        ip_match = select(ServerNetwork.server_id).where(cast(ServerNetwork.ip_address, String).ilike(t))
        stmt = stmt.where(
            or_(
                Server.name.ilike(t), Server.hostname.ilike(t), Server.purpose.ilike(t), Server.owner.ilike(t),
                Server.server_type.ilike(t), Server.os_name.ilike(t), Server.id.in_(ip_match),
            )
        )
    if environment_id:
        stmt = stmt.where(Server.environment_id == environment_id)
    if client_id:
        stmt = stmt.where(Server.client_id == client_id)
    if status_:
        stmt = stmt.where(Server.status == status_)
    if server_type:
        stmt = stmt.where(Server.server_type == server_type)
    if tag_id:
        stmt = stmt.where(Server.id.in_(select(server_tags.c.server_id).where(server_tags.c.tag_id == tag_id)))
    return stmt.order_by(Server.name)


def _counts(db: Session, ids: list[int]) -> tuple[dict, dict]:
    if not ids:
        return {}, {}
    creds = dict(db.execute(
        select(Credential.server_id, func.count()).where(Credential.server_id.in_(ids)).group_by(Credential.server_id)
    ).all())
    deps = dict(db.execute(
        select(ApplicationVersion.server_id, func.count())
        .where(ApplicationVersion.server_id.in_(ids)).group_by(ApplicationVersion.server_id)
    ).all())
    return creds, deps


def _out(s: Server, creds: dict, deps: dict) -> ServerOut:
    o = ServerOut.model_validate(s)
    o.credential_count = creds.get(s.id, 0)
    o.deployment_count = deps.get(s.id, 0)
    return o


def _snapshot(s: Server) -> dict:
    d = {f: getattr(s, f) for f in _FIELDS}
    d["environment_id"] = s.environment.name if s.environment else s.environment_id
    d["client_id"] = s.client.name if s.client else None
    if s.spec:
        for k in ("cpu_cores", "ram_gb", "disk_gb", "disk_usage_pct"):
            v = getattr(s.spec, k)
            d[k] = float(v) if v is not None else None
    d["networks"] = sorted(f"{n.ip_type}:{n.ip_address}" for n in s.networks)
    d["tags"] = sorted(t.name for t in s.tags)
    return d


def _apply(db: Session, s: Server, body: ServerIn) -> None:
    get_env(db, body.environment_id)
    if body.client_id is not None and not db.get(Client, body.client_id):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Unknown client")
    for f in _FIELDS:
        setattr(s, f, getattr(body, f))
    s.name = body.name.strip()
    if s.spec is None:
        s.spec = ServerSpec()
    for k, v in body.spec.model_dump().items():
        setattr(s.spec, k, v)
    s.networks = [ServerNetwork(**n.model_dump()) for n in body.networks]
    s.tags = get_tags(db, body.tag_ids)


def get_server_scoped(db: Session, p: Principal, server_id: int) -> Server:
    s = db.get(Server, server_id)
    if not s or not p.can_env(s.environment_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Server not found")
    return s


@router.get("", response_model=list[ServerOut])
def list_servers(
    q: str | None = None, environment_id: int | None = None, status_: str | None = Query(None, alias="status"),
    server_type: str | None = None, tag_id: int | None = None, client_id: int | None = None,
    db: Session = Depends(get_db), p: Principal = Depends(require("servers.view")),
):
    servers = list(db.scalars(_query(p, q, environment_id, status_, server_type, tag_id, client_id)).unique())
    creds, deps = _counts(db, [s.id for s in servers])
    return [_out(s, creds, deps) for s in servers]


@router.get("/export")
def export_servers(
    request: Request, q: str | None = None, environment_id: int | None = None,
    status_: str | None = Query(None, alias="status"), server_type: str | None = None, tag_id: int | None = None,
    db: Session = Depends(get_db), p: Principal = Depends(require("servers.view")),
):
    servers = list(db.scalars(_query(p, q, environment_id, status_, server_type, tag_id)).unique())
    audit(db, request, "SERVERS_EXPORTED", p.user, details={"count": len(servers)})
    db.commit()

    def ips(s, t):
        return ", ".join(str(n.ip_address) for n in s.networks if n.ip_type == t)

    header = ["Server Name", "Hostname", "Client", "Environment", "Role", "Server Type", "Private IP", "Public IP",
              "VPN IP", "Network IP",
              "Provider", "Location", "OS", "OS Version", "Kernel", "Architecture", "CPU Cores", "RAM (GB)",
              "Disk (GB)", "Disk Usage %", "Docker", "Compose", "Status", "Owner", "Purpose", "Tags", "Notes"]
    rows = [[
        s.name, s.hostname, s.client.name if s.client else None, s.environment.name, s.role, s.server_type,
        ips(s, "private"), ips(s, "public"), ips(s, "vpn"), ips(s, "network"),
        s.provider, s.location, s.os_name, s.os_version, s.kernel_version, s.architecture,
        s.spec.cpu_cores if s.spec else None, s.spec.ram_gb if s.spec else None, s.spec.disk_gb if s.spec else None,
        s.spec.disk_usage_pct if s.spec else None, s.docker_version, s.compose_version, s.status, s.owner,
        s.purpose, " ".join(t.name for t in s.tags), s.notes,
    ] for s in servers]
    return csv_response("servers", header, rows)


@router.get("/{server_id}", response_model=ServerOut)
def get_server(server_id: int, db: Session = Depends(get_db), p: Principal = Depends(require("servers.view"))):
    s = get_server_scoped(db, p, server_id)
    creds, deps = _counts(db, [s.id])
    return _out(s, creds, deps)


@router.post("", response_model=ServerOut, status_code=201)
def create_server(body: ServerIn, request: Request, db: Session = Depends(get_db), p: Principal = Depends(require("servers.create"))):
    p.require_env(body.environment_id)
    s = Server(created_by_id=p.user.id, updated_by_id=p.user.id)
    _apply(db, s, body)
    db.add(s)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, "A server with this name already exists")
    db.refresh(s)
    audit(db, request, "SERVER_CREATED", p.user, entity_type="server", entity_id=s.id, entity_label=s.name,
          details=_snapshot(s))
    db.commit()
    return _out(s, {}, {})


@router.put("/{server_id}", response_model=ServerOut)
def update_server(
    server_id: int, body: ServerIn, request: Request, db: Session = Depends(get_db),
    p: Principal = Depends(require("servers.update")),
):
    s = get_server_scoped(db, p, server_id)
    p.require_env(body.environment_id)
    before = _snapshot(s)
    _apply(db, s, body)
    s.updated_by_id = p.user.id
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, "A server with this name already exists")
    db.refresh(s)
    changes = diff(before, _snapshot(s))
    if changes:
        audit(db, request, "SERVER_UPDATED", p.user, entity_type="server", entity_id=s.id, entity_label=s.name,
              details=changes)
    db.commit()
    creds, deps = _counts(db, [s.id])
    return _out(s, creds, deps)


@router.delete("/{server_id}", status_code=204)
def delete_server(server_id: int, request: Request, db: Session = Depends(get_db), p: Principal = Depends(require("servers.delete"))):
    s = get_server_scoped(db, p, server_id)
    audit(db, request, "SERVER_DELETED", p.user, entity_type="server", entity_id=s.id, entity_label=s.name,
          details=_snapshot(s))
    db.delete(s)
    db.commit()
