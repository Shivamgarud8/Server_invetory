"""Clients (customer workspaces), their domains, templates and architecture diagrams."""

from collections import defaultdict

from fastapi import APIRouter, Depends, HTTPException, Request, status
import ipaddress

from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..audit import audit, diff
from ..db import get_db
from ..deps import Principal, require
from ..models import (
    Application,
    ApplicationVersion,
    ArchitectureLayout,
    Client,
    Credential,
    Domain,
    Server,
    ServerNetwork,
    ServerSpec,
    ServiceDependency,
)
from ..schemas import SERVER_ROLES, SERVICE_TYPES, ClientIn, ClientOut, DomainIn, DomainOut
from .common import get_env, like, scope

router = APIRouter(prefix="/api", tags=["clients"])

_CLIENT_FIELDS = ["name", "code", "description", "architecture_type", "color", "contact", "notes", "runbook",
                  "backup_policy", "recovery_plan"]


def _get_client(db: Session, client_id: int) -> Client:
    c = db.get(Client, client_id)
    if not c:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Client not found")
    return c


def _client_out(db: Session, p: Principal, c: Client) -> ClientOut:
    o = ClientOut.model_validate(c)
    servers = list(db.scalars(scope(select(Server), Server.environment_id, p.env_ids()).where(Server.client_id == c.id)))
    o.server_count = len(servers)
    o.environments = sorted({s.environment.name for s in servers})
    health: dict[str, int] = defaultdict(int)
    for s in servers:
        health[s.health_status] += 1
    o.health = dict(health)
    ids = [s.id for s in servers] or [-1]
    o.service_count = db.scalar(select(func.count()).select_from(ApplicationVersion).where(ApplicationVersion.server_id.in_(ids))) or 0
    o.domain_count = db.scalar(select(func.count()).select_from(Domain).where(Domain.client_id == c.id)) or 0
    o.credential_count = db.scalar(
        scope(select(func.count()).select_from(Credential), Credential.environment_id, p.env_ids())
        .where(Credential.client_id == c.id)) or 0
    return o


# ---------------------------------------------------------------- clients CRUD


@router.get("/clients", response_model=list[ClientOut])
def list_clients(q: str | None = None, db: Session = Depends(get_db), p: Principal = Depends(require("clients.view"))):
    stmt = select(Client).order_by(Client.name)
    if q:
        stmt = stmt.where(Client.name.ilike(like(q.strip())))
    return [_client_out(db, p, c) for c in db.scalars(stmt)]


@router.get("/clients/{client_id}", response_model=ClientOut)
def get_client(client_id: int, db: Session = Depends(get_db), p: Principal = Depends(require("clients.view"))):
    return _client_out(db, p, _get_client(db, client_id))


@router.post("/clients", response_model=ClientOut, status_code=201)
def create_client(body: ClientIn, request: Request, db: Session = Depends(get_db),
                  p: Principal = Depends(require("clients.create"))):
    c = Client(**body.model_dump())
    c.name = c.name.strip()
    db.add(c)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, "A client with this name already exists")
    audit(db, request, "CLIENT_CREATED", p.user, entity_type="client", entity_id=c.id, entity_label=c.name)
    db.commit()
    return _client_out(db, p, c)


@router.put("/clients/{client_id}", response_model=ClientOut)
def update_client(client_id: int, body: ClientIn, request: Request, db: Session = Depends(get_db),
                  p: Principal = Depends(require("clients.update"))):
    c = _get_client(db, client_id)
    before = {f: getattr(c, f) for f in _CLIENT_FIELDS}
    for k, v in body.model_dump().items():
        setattr(c, k, v)
    c.name = c.name.strip()
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, "A client with this name already exists")
    changes = diff(before, {f: getattr(c, f) for f in _CLIENT_FIELDS})
    if changes:
        audit(db, request, "CLIENT_UPDATED", p.user, entity_type="client", entity_id=c.id, entity_label=c.name,
              details=changes)
    db.commit()
    return _client_out(db, p, c)


@router.delete("/clients/{client_id}", status_code=204)
def delete_client(client_id: int, request: Request, db: Session = Depends(get_db),
                  p: Principal = Depends(require("clients.delete"))):
    c = _get_client(db, client_id)
    audit(db, request, "CLIENT_DELETED", p.user, entity_type="client", entity_id=c.id, entity_label=c.name,
          details={"note": "servers, domains and credentials were kept and unlinked"})
    db.delete(c)
    db.commit()


# ---------------------------------------------------------------- domains


def _domain_q(p: Principal, client_id: int | None, q: str | None):
    stmt = select(Domain).order_by(Domain.name)
    env_ids = p.env_ids()
    if env_ids is not None:
        stmt = stmt.where((Domain.environment_id.is_(None)) | (Domain.environment_id.in_(env_ids or {-1})))
    if client_id:
        stmt = stmt.where(Domain.client_id == client_id)
    if q:
        stmt = stmt.where(Domain.name.ilike(like(q.strip())))
    return stmt


def _apply_domain(db: Session, p: Principal, d: Domain, body: DomainIn) -> None:
    if body.client_id is not None:
        _get_client(db, body.client_id)
    if body.environment_id is not None:
        get_env(db, body.environment_id)
        p.require_env(body.environment_id)
    srv = None
    if body.server_id is not None:
        srv = db.get(Server, body.server_id)
        if not srv or not p.can_env(srv.environment_id):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Unknown server")
    for k, v in body.model_dump().items():
        setattr(d, k, v)
    if srv is not None:
        d.client_id = d.client_id or srv.client_id
        d.environment_id = d.environment_id or srv.environment_id
        if not d.target:
            pub = next((n for n in srv.networks if n.ip_type == "public"), None) or (srv.networks[0] if srv.networks else None)
            d.target = str(pub.ip_address).split("/")[0] if pub else None


@router.get("/domains", response_model=list[DomainOut])
def list_domains(client_id: int | None = None, q: str | None = None, db: Session = Depends(get_db),
                 p: Principal = Depends(require("clients.view"))):
    return list(db.scalars(_domain_q(p, client_id, q)))


@router.post("/domains", response_model=DomainOut, status_code=201)
def create_domain(body: DomainIn, request: Request, db: Session = Depends(get_db),
                  p: Principal = Depends(require("clients.create"))):
    d = Domain()
    _apply_domain(db, p, d, body)
    db.add(d)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, "This domain already exists")
    audit(db, request, "DOMAIN_CREATED", p.user, entity_type="domain", entity_id=d.id, entity_label=d.name)
    db.commit()
    db.refresh(d)
    return d


@router.put("/domains/{domain_id}", response_model=DomainOut)
def update_domain(domain_id: int, body: DomainIn, request: Request, db: Session = Depends(get_db),
                  p: Principal = Depends(require("clients.update"))):
    d = db.get(Domain, domain_id)
    if not d:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Domain not found")
    _apply_domain(db, p, d, body)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, "This domain already exists")
    audit(db, request, "DOMAIN_UPDATED", p.user, entity_type="domain", entity_id=d.id, entity_label=d.name)
    db.commit()
    db.refresh(d)
    return d


@router.delete("/domains/{domain_id}", status_code=204)
def delete_domain(domain_id: int, request: Request, db: Session = Depends(get_db),
                  p: Principal = Depends(require("clients.delete"))):
    d = db.get(Domain, domain_id)
    if not d:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Domain not found")
    audit(db, request, "DOMAIN_DELETED", p.user, entity_type="domain", entity_id=d.id, entity_label=d.name)
    db.delete(d)
    db.commit()


# ---------------------------------------------------------------- templates


class TemplateServer(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    role: str = Field(pattern=SERVER_ROLES)
    environment_id: int
    private_ip: str | None = None
    public_ip: str | None = None
    vpn_ip: str | None = None
    ssh_user: str | None = None

    @field_validator("private_ip", "public_ip", "vpn_ip")
    @classmethod
    def _ip(cls, v):
        if v and v.strip():
            ipaddress.ip_interface(v.strip())
            return v.strip()
        return None


class TemplateService(BaseModel):
    server_index: int = Field(ge=0)
    application: str = Field(min_length=1, max_length=128)
    component: str = Field(min_length=1, max_length=128)
    service_type: str = Field(pattern=SERVICE_TYPES)
    port: int | None = Field(default=None, ge=1, le=65535)


class TemplateDependency(BaseModel):
    from_index: int = Field(ge=0)
    to_index: int = Field(ge=0)


class TemplateApplyIn(BaseModel):
    template: str = Field(pattern=r"^(single|three_tier|shared_db|custom)$")
    servers: list[TemplateServer] = Field(min_length=1)
    services: list[TemplateService] = []
    dependencies: list[TemplateDependency] = []


@router.post("/clients/{client_id}/apply-template")
def apply_template(client_id: int, body: TemplateApplyIn, request: Request, db: Session = Depends(get_db),
                   p: Principal = Depends(require("clients.update", "servers.create", "versions.create"))):
    """Create the servers / services / connections the user confirmed in the template wizard."""
    c = _get_client(db, client_id)
    created_servers: list[Server] = []
    for t in body.servers:
        get_env(db, t.environment_id)
        p.require_env(t.environment_id)
        if db.scalar(select(Server.id).where(Server.name == t.name.strip())):
            raise HTTPException(status.HTTP_409_CONFLICT, f"Server '{t.name}' already exists — rename it in the wizard")
        s = Server(name=t.name.strip(), environment_id=t.environment_id, client_id=c.id, role=t.role,
                   server_type=t.role.replace("_", " ").title() + " Server", ssh_user=t.ssh_user, ssh_port=22,
                   created_by_id=p.user.id, updated_by_id=p.user.id, spec=ServerSpec())
        for kind, ip in (("private", t.private_ip), ("public", t.public_ip), ("vpn", t.vpn_ip)):
            if ip and ip.strip():
                s.networks.append(ServerNetwork(ip_type=kind, ip_address=ip.strip()))
        db.add(s)
        created_servers.append(s)
    db.flush()

    apps = {a.name.lower(): a for a in db.scalars(select(Application))}
    created_services: list[ApplicationVersion] = []
    for t in body.services:
        if t.server_index >= len(created_servers):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Service refers to an unknown server")
        srv = created_servers[t.server_index]
        app = apps.get(t.application.lower())
        if app is None:
            app = Application(name=t.application, category=t.service_type)
            db.add(app)
            db.flush()
            apps[app.name.lower()] = app
        svc = ApplicationVersion(application_id=app.id, component=t.component, server_id=srv.id,
                                 environment_id=srv.environment_id, current_version="-", service_type=t.service_type,
                                 port=t.port, updated_by_id=p.user.id)
        db.add(svc)
        created_services.append(svc)
    db.flush()
    for dep in body.dependencies:
        if max(dep.from_index, dep.to_index) >= len(created_services) or dep.from_index == dep.to_index:
            continue
        a, b = created_services[dep.from_index], created_services[dep.to_index]
        db.add(ServiceDependency(from_service_id=a.id, to_service_id=b.id, port=b.port))
    c.architecture_type = body.template
    audit(db, request, "TEMPLATE_APPLIED", p.user, entity_type="client", entity_id=c.id, entity_label=c.name,
          details={"template": body.template, "servers": [s.name for s in created_servers],
                   "services": len(created_services)})
    db.commit()
    return {"servers": len(created_servers), "services": len(created_services)}


# ---------------------------------------------------------------- architecture

TIER = {"proxy": 2, "application": 3, "combined": 3, "monitoring": 3, "other": 3, "storage": 4, "database": 4}
SVC_W, SVC_H, GAP = 160, 54, 14
SVC_ORDER = {"proxy": 0, "ui": 1, "api": 2, "worker": 3, "cache": 4, "queue": 5, "storage": 6, "database": 7,
             "monitoring": 8, "other": 9}


def svc_node_id(s: ApplicationVersion) -> str:
    return f"svc:{s.application.name}|{s.component}|{s.server.name if s.server else '-'}|{s.environment.name}"


def _ip(s: Server, kind: str) -> str | None:
    n = next((n for n in s.networks if n.ip_type == kind), None)
    return str(n.ip_address).split("/")[0] if n else None


def build_graph(db: Session, p: Principal, c: Client) -> dict:
    """Diagram generated from the inventory: Internet → domains → proxy → app servers (with services) → databases."""
    servers = list(db.scalars(scope(select(Server), Server.environment_id, p.env_ids())
                              .where(Server.client_id == c.id).order_by(Server.name)))
    srv_ids = [s.id for s in servers] or [-1]
    services = list(db.scalars(select(ApplicationVersion).where(ApplicationVersion.server_id.in_(srv_ids))).unique())
    svc_ids = [s.id for s in services] or [-1]
    deps = list(db.scalars(select(ServiceDependency).where(
        ServiceDependency.from_service_id.in_(svc_ids), ServiceDependency.to_service_id.in_(svc_ids))))
    domains = list(db.scalars(select(Domain).where(Domain.client_id == c.id).order_by(Domain.name)))
    cred_counts = dict(db.execute(select(Credential.server_id, func.count()).where(
        Credential.server_id.in_(srv_ids)).group_by(Credential.server_id)).all())

    nodes, edges = [], []
    tiers: dict[int, list[dict]] = defaultdict(list)

    nodes.append({"id": "internet", "type": "infra", "position": {"x": 0, "y": 0},
                  "data": {"kind": "internet", "label": "Internet / Users"}})
    tiers[0].append(nodes[-1])
    for d in domains:
        n = {"id": f"dom:{d.name}", "type": "infra", "position": {"x": 0, "y": 0},
             "data": {"kind": "domain", "ref_id": d.id, "label": d.name,
                      "subtitle": f"{d.record_type} → {d.target or (d.server.name if d.server else '?')}",
                      "health": d.health_status}}
        nodes.append(n)
        tiers[1].append(n)
        edges.append({"id": f"e:internet>{n['id']}", "source": "internet", "target": n["id"],
                      "label": "DNS", "data": {"kind": "dns"}})

    by_server: dict[int, list[ApplicationVersion]] = defaultdict(list)
    for s in services:
        by_server[s.server_id].append(s)
    for lst in by_server.values():  # top-to-bottom flow inside a server: entry points first, backing services last
        lst.sort(key=lambda x: (SVC_ORDER.get(x.service_type, 9), x.component.lower()))

    for s in servers:
        svcs = by_server.get(s.id, [])
        cols = 2 if len(svcs) > 1 else 1
        rows = (len(svcs) + cols - 1) // cols
        w = max(260, cols * (SVC_W + GAP) + GAP)
        h = 84 + rows * (SVC_H + GAP) + (GAP if svcs else 0)
        sid = f"srv:{s.name}"
        n = {"id": sid, "type": "server", "position": {"x": 0, "y": 0}, "style": {"width": w, "height": h},
             "data": {"kind": "server", "ref_id": s.id, "label": s.name, "role": s.role,
                      "env": s.environment.name, "env_color": s.environment.color,
                      "ip": _ip(s, "private") or _ip(s, "public") or _ip(s, "vpn"),
                      "public_ip": _ip(s, "public"), "vpn_ip": _ip(s, "vpn"),
                      "health": s.health_status, "credentials": cred_counts.get(s.id, 0)}}
        nodes.append(n)
        tiers[TIER.get(s.role, 3)].append(n)
        for i, svc in enumerate(svcs):
            nodes.append({"id": svc_node_id(svc), "type": "service", "parentId": sid, "extent": "parent",
                          "position": {"x": GAP + (i % cols) * (SVC_W + GAP), "y": 78 + (i // cols) * (SVC_H + GAP)},
                          "style": {"width": SVC_W, "height": SVC_H},
                          "data": {"kind": "service", "ref_id": svc.id, "label": svc.component,
                                   "app": svc.application.name, "service_type": svc.service_type,
                                   "port": svc.port, "version": svc.current_version}})

    for d in domains:
        if d.server and d.server.client_id == c.id and p.can_env(d.server.environment_id):
            edges.append({"id": f"e:dom:{d.name}>srv:{d.server.name}", "source": f"dom:{d.name}",
                          "target": f"srv:{d.server.name}", "label": "HTTPS", "data": {"kind": "route"}})

    svc_by_id = {s.id: s for s in services}
    linked_pairs = set()
    for dep in deps:
        a, b = svc_by_id[dep.from_service_id], svc_by_id[dep.to_service_id]
        lbl = " ".join(x for x in [dep.protocol, f":{dep.port}" if dep.port else None, dep.label] if x) or None
        edges.append({"id": f"e:dep:{dep.id}", "source": svc_node_id(a), "target": svc_node_id(b), "label": lbl,
                      "data": {"kind": "dependency", "ref_id": dep.id}})
        linked_pairs.add((a.server_id, b.server_id))

    # Suggested tier links where nothing explicit exists yet (dashed in the UI)
    proxies = [s for s in servers if s.role == "proxy"]
    apps = [s for s in servers if TIER.get(s.role, 3) == 3]
    dbs = [s for s in servers if TIER.get(s.role, 3) == 4]
    for up, down in ((proxies, apps), (apps, dbs)):
        for a in up:
            for b in down:
                if (a.id, b.id) not in linked_pairs and a.environment_id == b.environment_id:
                    edges.append({"id": f"e:inferred:{a.name}>{b.name}", "source": f"srv:{a.name}",
                                  "target": f"srv:{b.name}", "label": "inferred", "data": {"kind": "inferred"}})

    # Top-down layout: one row per tier, nodes spread horizontally and centred
    y = 0
    for t in sorted(tiers):
        row = tiers[t]
        widths = [(n.get("style") or {}).get("width", 220) for n in row]
        total = sum(widths) + 60 * (len(row) - 1)
        x = -total / 2
        for n, w in zip(row, widths):
            n["position"] = {"x": x, "y": y}
            x += w + 60
        y += max([(n.get("style") or {}).get("height", 70) for n in row] + [70]) + 90
    return {"nodes": nodes, "edges": edges}


class LayoutIn(BaseModel):
    layout: dict


@router.get("/clients/{client_id}/architecture")
def get_architecture(client_id: int, db: Session = Depends(get_db), p: Principal = Depends(require("clients.view"))):
    c = _get_client(db, client_id)
    saved = db.get(ArchitectureLayout, c.id)
    return {"generated": build_graph(db, p, c),
            "saved": saved.layout if saved else None,
            "saved_at": saved.updated_at if saved else None,
            "saved_by": saved.updated_by if saved else None}


@router.put("/clients/{client_id}/architecture")
def save_architecture(client_id: int, body: LayoutIn, request: Request, db: Session = Depends(get_db),
                      p: Principal = Depends(require("clients.update"))):
    c = _get_client(db, client_id)
    if len(str(body.layout)) > 2_000_000:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "Layout too large")
    row = db.get(ArchitectureLayout, c.id) or ArchitectureLayout(client_id=c.id, layout={})
    row.layout = body.layout
    row.updated_by = p.user.username
    db.merge(row)
    audit(db, request, "ARCHITECTURE_SAVED", p.user, entity_type="client", entity_id=c.id, entity_label=c.name,
          details={"nodes": len(body.layout.get("nodes", [])), "edges": len(body.layout.get("edges", []))})
    db.commit()
    return {"ok": True}


@router.delete("/clients/{client_id}/architecture", status_code=204)
def reset_architecture(client_id: int, request: Request, db: Session = Depends(get_db),
                       p: Principal = Depends(require("clients.update"))):
    c = _get_client(db, client_id)
    row = db.get(ArchitectureLayout, c.id)
    if row:
        db.delete(row)
        audit(db, request, "ARCHITECTURE_RESET", p.user, entity_type="client", entity_id=c.id, entity_label=c.name)
        db.commit()
