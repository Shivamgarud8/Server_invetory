"""Permission catalog, built-in roles and idempotent seed data."""

from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import CredentialType, Environment, Permission, Role, Tag

# module -> [(action, description)]
CATALOG: dict[str, list[tuple[str, str]]] = {
    "dashboard": [("view", "View dashboard")],
    "credentials": [
        ("view", "View credential records (password hidden)"),
        ("view_password", "Reveal / copy passwords"),
        ("create", "Add credentials"),
        ("update", "Edit credentials and change passwords"),
        ("delete", "Delete credentials"),
        ("export", "Export credential list (never includes passwords)"),
    ],
    "servers": [
        ("view", "View server inventory"),
        ("create", "Add servers"),
        ("update", "Edit servers"),
        ("delete", "Delete servers"),
    ],
    "versions": [
        ("view", "View deployed versions and history"),
        ("create", "Add applications and deployments"),
        ("update", "Record version updates"),
        ("delete", "Delete deployments / applications"),
    ],
    "users": [
        ("view", "View users and sessions"),
        ("create", "Create users"),
        ("update", "Edit users, reset passwords, revoke sessions"),
        ("delete", "Delete users"),
    ],
    "roles": [("manage", "Create and edit roles and their permissions")],
    "audit": [("view", "View audit logs")],
    "settings": [("manage", "Manage environments, tags and credential types")],
    "import": [("run", "Import data from Excel / CSV")],
}

ALL_CODES = [f"{m}.{a}" for m, actions in CATALOG.items() for a, _ in actions]

SUPER_ADMIN = "Super Admin"

BUILTIN_ROLES: dict[str, tuple[str, list[str]]] = {
    SUPER_ADMIN: ("Full access to everything", ALL_CODES),
    "Admin": (
        "Manage servers, versions, credentials and users",
        [c for c in ALL_CODES if c != "roles.manage"],
    ),
    "DevOps": (
        "Manage servers, applications and versions; use credentials",
        [
            "dashboard.view",
            "servers.view", "servers.create", "servers.update", "servers.delete",
            "versions.view", "versions.create", "versions.update", "versions.delete",
            "credentials.view", "credentials.view_password", "credentials.create", "credentials.update",
            "import.run",
        ],
    ),
    "Developer": (
        "View servers and versions; credential list without passwords",
        ["dashboard.view", "servers.view", "versions.view", "credentials.view"],
    ),
    "Auditor": (
        "Read-only access plus audit logs",
        ["dashboard.view", "servers.view", "versions.view", "credentials.view", "users.view", "audit.view"],
    ),
    "Viewer": ("Read-only access to inventory and versions", ["dashboard.view", "servers.view", "versions.view"]),
}

DEFAULT_ENVIRONMENTS = [
    ("PROD", "#dc2626", 10, True),
    ("STAGING", "#d97706", 20, False),
    ("UAT", "#2563eb", 30, False),
    ("TEST", "#7c3aed", 40, False),
    ("DEV", "#059669", 50, False),
]

DEFAULT_CREDENTIAL_TYPES = [
    ("SSH", 22), ("Root", 22), ("Server User", 22), ("Portainer", 9443), ("Harbor", 443),
    ("PostgreSQL", 5432), ("Redis", 6379), ("RabbitMQ", 15672), ("MinIO", 9001), ("Application", None),
    ("API", None), ("Database", None), ("Docker Registry", 443), ("Nginx", 443), ("Other", None),
]

DEFAULT_TAGS = [
    ("DATABASE", "#0891b2"), ("APPLICATION", "#4f46e5"), ("DOCKER", "#2563eb"), ("CRITICAL", "#dc2626"),
    ("ABFRL", "#9333ea"), ("METRO", "#16a34a"), ("CC", "#ca8a04"), ("GC", "#0d9488"),
    ("SNITCH", "#db2777"), ("STYLE-UNION", "#ea580c"),
]


def seed(db: Session) -> None:
    perms = {p.code: p for p in db.scalars(select(Permission))}
    for module, actions in CATALOG.items():
        for action, desc in actions:
            code = f"{module}.{action}"
            if code not in perms:
                perms[code] = Permission(code=code, module=module, action=action, description=desc)
                db.add(perms[code])
            else:
                perms[code].description = desc
    db.flush()

    for name, (desc, codes) in BUILTIN_ROLES.items():
        role = db.scalar(select(Role).where(Role.name == name))
        if role is None:
            db.add(Role(name=name, description=desc, is_system=True, permissions=[perms[c] for c in codes]))
        elif name == SUPER_ADMIN:
            role.permissions = [perms[c] for c in ALL_CODES]  # always complete

    if db.scalar(select(Environment).limit(1)) is None:
        for name, color, order, prod in DEFAULT_ENVIRONMENTS:
            db.add(Environment(name=name, color=color, sort_order=order, is_production=prod))

    if db.scalar(select(CredentialType).limit(1)) is None:
        for name, port in DEFAULT_CREDENTIAL_TYPES:
            db.add(CredentialType(name=name, default_port=port))

    if db.scalar(select(Tag).limit(1)) is None:
        for name, color in DEFAULT_TAGS:
            db.add(Tag(name=name, color=color))

    db.flush()
