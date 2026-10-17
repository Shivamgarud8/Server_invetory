"""Inventory export / import (disaster recovery).

The inventory JSON uses natural keys (names) for every reference, so it can be restored into an empty
portal on a new server. Secrets are only ever included inside a passphrase-encrypted recovery bundle.
"""

import hashlib
import json
from datetime import date, datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import (
    Application,
    ApplicationVersion,
    ArchitectureLayout,
    AuditLog,
    Client,
    ConfigBackup,
    Credential,
    CredentialType,
    Domain,
    Environment,
    Server,
    ServerNetwork,
    ServerSpec,
    ServiceDependency,
    Tag,
    VersionHistory,
)
from .security import get_vault

FORMAT = "tagid-inventory"
FORMAT_VERSION = 1
APP_VERSION = "1.6.0"
SNAPSHOT_KEEP = 30


def _iso(v):
    if isinstance(v, (datetime, date)):
        return v.isoformat()
    return v


def _num(v):
    return float(v) if v is not None else None


def svc_key(s: ApplicationVersion) -> str:
    return f"{s.application.name}|{s.component}|{s.server.name if s.server else '-'}|{s.environment.name}"


def cred_key(c: Credential) -> str:
    return f"{c.name}|{c.environment.name}|{c.username or ''}"


# ---------------------------------------------------------------- serialisers (also used to diff on import)

CLIENT_F = ["name", "code", "description", "architecture_type", "color", "contact", "notes", "runbook",
            "backup_policy", "recovery_plan"]
SERVER_F = ["name", "hostname", "server_type", "role", "provider", "location", "os_name", "os_version",
            "kernel_version", "architecture", "docker_version", "compose_version", "status", "owner", "purpose",
            "notes", "ssh_user", "ssh_port", "ssh_auth_method", "ssh_key_ref", "mount_points", "exposed_ports",
            "firewall_notes", "backup_policy", "recovery_instructions"]
DOMAIN_F = ["name", "record_type", "target", "dns_provider", "ssl_provider", "ssl_expires_at", "purpose", "notes"]
SERVICE_F = ["component", "current_version", "previous_version", "image", "service_type", "port", "protocol",
             "health_url", "notes"]
CRED_F = ["name", "category", "host", "port", "username", "url", "service", "description", "owner", "status",
          "expires_at", "rotation_policy", "rotation_interval_days", "next_rotation_at", "notes"]


def ser_client(c: Client) -> dict:
    return {f: getattr(c, f) for f in CLIENT_F}


def ser_server(s: Server) -> dict:
    d = {f: getattr(s, f) for f in SERVER_F}
    d["environment"] = s.environment.name
    d["client"] = s.client.name if s.client else None
    d["spec"] = {k: _num(getattr(s.spec, k)) if s.spec else None
                 for k in ("cpu_cores", "ram_gb", "disk_gb", "disk_usage_pct")}
    if d["spec"]["cpu_cores"] is not None:
        d["spec"]["cpu_cores"] = int(d["spec"]["cpu_cores"])
    d["networks"] = sorted(({"ip_type": n.ip_type, "ip_address": str(n.ip_address), "label": n.label}
                            for n in s.networks), key=lambda x: (x["ip_type"], x["ip_address"]))
    d["tags"] = sorted(t.name for t in s.tags)
    return d


def ser_domain(d: Domain) -> dict:
    o = {f: _iso(getattr(d, f)) for f in DOMAIN_F}
    o["client"] = d.client.name if d.client else None
    o["environment"] = d.environment.name if d.environment else None
    o["server"] = d.server.name if d.server else None
    return o


def ser_service(s: ApplicationVersion) -> dict:
    d = {f: getattr(s, f) for f in SERVICE_F}
    d.update(key=svc_key(s), application=s.application.name, server=s.server.name if s.server else None,
             environment=s.environment.name)
    return d


def ser_credential(c: Credential) -> dict:
    d = {f: _iso(getattr(c, f)) for f in CRED_F}
    d.update(key=cred_key(c), type=c.credential_type.name, environment=c.environment.name,
             client=c.client.name if c.client else None, server=c.server.name if c.server else None,
             linked_service=svc_key(c.linked_service) if c.linked_service else None,
             tags=sorted(t.name for t in c.tags))
    return d


# ---------------------------------------------------------------- export


def checksum(data: dict) -> str:
    return hashlib.sha256(json.dumps(data, sort_keys=True, separators=(",", ":"), default=str).encode()).hexdigest()


def build_inventory(db: Session, *, include_secrets: bool = False) -> dict:
    services = list(db.scalars(select(ApplicationVersion)).unique())
    svc_by_id = {s.id: s for s in services}
    creds = list(db.scalars(select(Credential)).unique())
    data = {
        "environments": [{"name": e.name, "color": e.color, "sort_order": e.sort_order, "is_production": e.is_production}
                         for e in db.scalars(select(Environment).order_by(Environment.sort_order))],
        "tags": [{"name": t.name, "color": t.color} for t in db.scalars(select(Tag).order_by(Tag.name))],
        "credential_types": [{"name": t.name, "default_port": t.default_port}
                             for t in db.scalars(select(CredentialType).order_by(CredentialType.name))],
        "clients": [ser_client(c) for c in db.scalars(select(Client).order_by(Client.name))],
        "servers": [ser_server(s) for s in db.scalars(select(Server).order_by(Server.name)).unique()],
        "domains": [ser_domain(d) for d in db.scalars(select(Domain).order_by(Domain.name))],
        "applications": [{"name": a.name, "category": a.category, "description": a.description,
                          "repository_url": a.repository_url}
                         for a in db.scalars(select(Application).order_by(Application.name))],
        "services": sorted((ser_service(s) for s in services), key=lambda x: x["key"]),
        "dependencies": sorted(({"from": svc_key(svc_by_id[d.from_service_id]), "to": svc_key(svc_by_id[d.to_service_id]),
                                 "protocol": d.protocol, "port": d.port, "label": d.label}
                                for d in db.scalars(select(ServiceDependency))), key=lambda x: (x["from"], x["to"])),
        "credentials": sorted((ser_credential(c) | {"has_secret": c.has_secret,
                                                    "password_changed_at": _iso(c.password_changed_at)}
                               for c in creds), key=lambda x: x["key"]),
        "architecture_layouts": [{"client": db.get(Client, l.client_id).name, "layout": l.layout}
                                 for l in db.scalars(select(ArchitectureLayout))],
        "version_history": [{"application": h.application_name, "component": h.component, "server": h.server_name,
                             "environment": h.environment_name, "old_version": h.old_version,
                             "new_version": h.new_version, "changed_by": h.changed_by,
                             "changed_at": _iso(h.changed_at), "notes": h.notes}
                            for h in db.scalars(select(VersionHistory).order_by(VersionHistory.id.desc()).limit(2000))],
        "change_log": [{"at": _iso(a.created_at), "user": a.username, "action": a.action, "entity": a.entity_label}
                       for a in db.scalars(select(AuditLog).where(AuditLog.action.notlike("LOGIN%"))
                                           .order_by(AuditLog.id.desc()).limit(500))],
    }
    if include_secrets:
        vault = get_vault()
        secrets = []
        for c in creds:
            if c.has_secret and c.secret_provider == vault.name:
                secrets.append({"credential": cred_key(c), "password": vault.read(c.id, c.secret_enc)})
        data["secrets"] = secrets
    counts = {k: len(v) for k, v in data.items() if isinstance(v, list)}
    return {"manifest": {"format": FORMAT, "format_version": FORMAT_VERSION, "app_version": APP_VERSION,
                         "generated_at": datetime.now(timezone.utc).isoformat(), "includes_secrets": include_secrets,
                         "counts": counts, "checksum_sha256": checksum(data)},
            "data": data}


def take_snapshot(db: Session, kind: str, actor: str | None) -> ConfigBackup:
    inv = build_inventory(db)
    raw = json.dumps(inv, default=str)
    snap = ConfigBackup(kind=kind, checksum=inv["manifest"]["checksum_sha256"], size_bytes=len(raw),
                        summary=inv["manifest"]["counts"], content=json.loads(raw), created_by=actor)
    db.add(snap)
    db.flush()
    for old in db.scalars(select(ConfigBackup).order_by(ConfigBackup.id.desc()).offset(SNAPSHOT_KEEP)):
        db.delete(old)
    return snap


# ---------------------------------------------------------------- import


class ImportErrorWithDetail(ValueError):
    pass


def validate(doc: dict) -> dict:
    m = doc.get("manifest") if isinstance(doc, dict) else None
    data = doc.get("data") if isinstance(doc, dict) else None
    if not isinstance(m, dict) or not isinstance(data, dict):
        raise ImportErrorWithDetail("Not a TagID inventory file (manifest/data missing)")
    if m.get("format") != FORMAT:
        raise ImportErrorWithDetail(f"Unknown format '{m.get('format')}'")
    if int(m.get("format_version", 0)) > FORMAT_VERSION:
        raise ImportErrorWithDetail(f"File format v{m.get('format_version')} is newer than this portal supports")
    if m.get("checksum_sha256") != checksum(data):
        raise ImportErrorWithDetail("Checksum mismatch — the file is corrupted or was edited")
    return data


def _pick(d: dict, fields: list[str]) -> dict:
    return {f: d.get(f) for f in fields}


def plan(db: Session, data: dict) -> dict:
    """Preview: what would be created, updated (with field differences) or left unchanged."""
    result: dict[str, dict] = {}

    def compare(kind, incoming, existing_map, key_fn, ser_fn, ignore=()):
        new, upd, same, conflicts = 0, 0, 0, []
        for item in incoming:
            k = key_fn(item)
            ex = existing_map.get(k)
            if ex is None:
                new += 1
                continue
            cur = ser_fn(ex)
            changed = sorted(f for f in item if f in cur and f not in ignore and cur[f] != item[f])
            if changed:
                upd += 1
                conflicts.append({"key": k, "fields": changed[:12]})
            else:
                same += 1
        result[kind] = {"new": new, "update": upd, "unchanged": same, "conflicts": conflicts[:100]}

    compare("clients", data.get("clients", []), {c.name: c for c in db.scalars(select(Client))},
            lambda x: x["name"], ser_client)
    compare("servers", data.get("servers", []), {s.name: s for s in db.scalars(select(Server)).unique()},
            lambda x: x["name"], ser_server)
    compare("domains", data.get("domains", []), {d.name: d for d in db.scalars(select(Domain))},
            lambda x: x["name"], ser_domain)
    compare("services", data.get("services", []),
            {svc_key(s): s for s in db.scalars(select(ApplicationVersion)).unique()}, lambda x: x["key"], ser_service)
    compare("credentials", data.get("credentials", []),
            {cred_key(c): c for c in db.scalars(select(Credential)).unique()}, lambda x: x["key"], ser_credential,
            ignore=("has_secret", "password_changed_at"))
    result["dependencies"] = {"total": len(data.get("dependencies", []))}
    result["architecture_layouts"] = {"total": len(data.get("architecture_layouts", []))}
    result["secrets"] = {"total": len(data.get("secrets", []))}
    return result


def apply(db: Session, data: dict, *, mode: str, restore_secrets: bool, overwrite_secrets: bool, actor: str,
          store_secret_fn) -> dict:
    """Write the inventory. mode: 'merge' (create + update) or 'add_only' (create missing, keep existing)."""
    upd = mode == "merge"
    stats: dict[str, int] = {}

    def bump(k):
        stats[k] = stats.get(k, 0) + 1

    envs = {e.name: e for e in db.scalars(select(Environment))}
    for e in data.get("environments", []):
        if e["name"] not in envs:
            envs[e["name"]] = Environment(**e)
            db.add(envs[e["name"]])
            bump("environments_created")
    tags = {t.name: t for t in db.scalars(select(Tag))}
    for t in data.get("tags", []):
        if t["name"] not in tags:
            tags[t["name"]] = Tag(**t)
            db.add(tags[t["name"]])
    types = {t.name: t for t in db.scalars(select(CredentialType))}
    for t in data.get("credential_types", []):
        if t["name"] not in types:
            types[t["name"]] = CredentialType(**t)
            db.add(types[t["name"]])
    db.flush()

    def env(name):
        if name not in envs:
            raise ImportErrorWithDetail(f"Unknown environment '{name}'")
        return envs[name]

    clients = {c.name: c for c in db.scalars(select(Client))}
    for item in data.get("clients", []):
        c = clients.get(item["name"])
        if c is None:
            c = Client()
            db.add(c)
            clients[item["name"]] = c
            bump("clients_created")
        elif not upd:
            continue
        else:
            bump("clients_updated")
        for f in CLIENT_F:
            if f in item:
                setattr(c, f, item[f])
    db.flush()

    servers = {s.name: s for s in db.scalars(select(Server)).unique()}
    for item in data.get("servers", []):
        s = servers.get(item["name"])
        if s is None:
            s = Server(spec=ServerSpec())
            db.add(s)
            servers[item["name"]] = s
            bump("servers_created")
        elif not upd:
            continue
        else:
            bump("servers_updated")
        for f in SERVER_F:
            if f in item:
                setattr(s, f, item[f])
        s.environment = env(item["environment"])
        s.client = clients.get(item.get("client")) if item.get("client") else None
        if s.spec is None:
            s.spec = ServerSpec()
        for k, v in (item.get("spec") or {}).items():
            setattr(s.spec, k, v)
        s.networks = [ServerNetwork(**n) for n in item.get("networks", [])]
        s.tags = [tags[t] for t in item.get("tags", []) if t in tags]
    db.flush()

    domains = {d.name: d for d in db.scalars(select(Domain))}
    for item in data.get("domains", []):
        d = domains.get(item["name"])
        if d is None:
            d = Domain()
            db.add(d)
            domains[item["name"]] = d
            bump("domains_created")
        elif not upd:
            continue
        else:
            bump("domains_updated")
        for f in DOMAIN_F:
            if f in item:
                setattr(d, f, date.fromisoformat(item[f]) if f == "ssl_expires_at" and item[f] else item[f])
        d.client = clients.get(item.get("client")) if item.get("client") else None
        d.environment = envs.get(item.get("environment")) if item.get("environment") else None
        d.server = servers.get(item.get("server")) if item.get("server") else None
    db.flush()

    apps = {a.name: a for a in db.scalars(select(Application))}
    for item in data.get("applications", []):
        if item["name"] not in apps:
            apps[item["name"]] = Application(**item)
            db.add(apps[item["name"]])
    db.flush()

    svcs = {svc_key(s): s for s in db.scalars(select(ApplicationVersion)).unique()}
    for item in data.get("services", []):
        s = svcs.get(item["key"])
        if s is None:
            if item["application"] not in apps:
                apps[item["application"]] = Application(name=item["application"])
                db.add(apps[item["application"]])
                db.flush()
            s = ApplicationVersion(application_id=apps[item["application"]].id)
            db.add(s)
            bump("services_created")
        elif not upd:
            continue
        else:
            bump("services_updated")
        for f in SERVICE_F:
            if f in item:
                setattr(s, f, item[f])
        s.server_id = servers[item["server"]].id if item.get("server") in servers else None
        s.environment_id = env(item["environment"]).id
        db.flush()
        db.refresh(s)
        svcs[item["key"]] = s

    existing_deps = {(d.from_service_id, d.to_service_id) for d in db.scalars(select(ServiceDependency))}
    for item in data.get("dependencies", []):
        a, b = svcs.get(item["from"]), svcs.get(item["to"])
        if a and b and (a.id, b.id) not in existing_deps:
            db.add(ServiceDependency(from_service_id=a.id, to_service_id=b.id, protocol=item.get("protocol"),
                                     port=item.get("port"), label=item.get("label")))
            existing_deps.add((a.id, b.id))
            bump("dependencies_created")
    db.flush()

    vault_name = get_vault().name
    creds = {cred_key(c): c for c in db.scalars(select(Credential)).unique()}
    for item in data.get("credentials", []):
        c = creds.get(item["key"])
        if c is None:
            c = Credential(secret_provider=vault_name, has_secret=False)
            db.add(c)
            bump("credentials_created")
        elif not upd:
            continue
        else:
            bump("credentials_updated")
        for f in CRED_F:
            if f in item:
                v = item[f]
                if f in ("expires_at", "next_rotation_at") and v:
                    v = date.fromisoformat(v)
                setattr(c, f, v)
        if item["type"] not in types:
            types[item["type"]] = CredentialType(name=item["type"])
            db.add(types[item["type"]])
            db.flush()
        c.credential_type_id = types[item["type"]].id
        c.environment_id = env(item["environment"]).id
        c.client_id = clients[item["client"]].id if item.get("client") in clients else None
        c.server_id = servers[item["server"]].id if item.get("server") in servers else None
        c.service_id = svcs[item["linked_service"]].id if item.get("linked_service") in svcs else None
        c.tags = [tags[t] for t in item.get("tags", []) if t in tags]
        db.flush()
        db.refresh(c)
        creds[item["key"]] = c

    if restore_secrets:
        for sec in data.get("secrets", []):
            c = creds.get(sec["credential"])
            if c is None or (c.has_secret and not overwrite_secrets):
                bump("secrets_skipped")
                continue
            store_secret_fn(db, c, sec["password"], actor, "Restored from recovery bundle", is_change=False)
            bump("secrets_restored")

    for item in data.get("architecture_layouts", []):
        c = clients.get(item["client"])
        if c is None:
            continue
        row = db.get(ArchitectureLayout, c.id)
        if row is None or upd:
            db.merge(ArchitectureLayout(client_id=c.id, layout=item["layout"], updated_by=actor))
            bump("layouts_restored")

    if not db.scalar(select(VersionHistory.id).limit(1)):
        for h in data.get("version_history", []):
            db.add(VersionHistory(application_name=h["application"], component=h["component"],
                                  server_name=h.get("server"), environment_name=h["environment"],
                                  old_version=h.get("old_version"), new_version=h["new_version"],
                                  changed_by=h.get("changed_by"), changed_at=datetime.fromisoformat(h["changed_at"]),
                                  notes=h.get("notes")))
    db.flush()
    return stats
