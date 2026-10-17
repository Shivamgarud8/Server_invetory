from datetime import date, datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    Column,
    Date,
    DateTime,
    ForeignKey,
    Integer,
    LargeBinary,
    Numeric,
    String,
    Table,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import INET, JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


def _ts() -> Mapped[datetime]:
    return mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


def _ts_upd() -> Mapped[datetime]:
    return mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)


# ---------------------------------------------------------------- association tables

user_roles = Table(
    "user_roles",
    Base.metadata,
    Column("user_id", ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
    Column("role_id", ForeignKey("roles.id", ondelete="CASCADE"), primary_key=True),
)

role_permissions = Table(
    "role_permissions",
    Base.metadata,
    Column("role_id", ForeignKey("roles.id", ondelete="CASCADE"), primary_key=True),
    Column("permission_id", ForeignKey("permissions.id", ondelete="CASCADE"), primary_key=True),
)

user_environments = Table(
    "user_environments",
    Base.metadata,
    Column("user_id", ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
    Column("environment_id", ForeignKey("environments.id", ondelete="CASCADE"), primary_key=True),
)

server_tags = Table(
    "server_tags",
    Base.metadata,
    Column("server_id", ForeignKey("servers.id", ondelete="CASCADE"), primary_key=True),
    Column("tag_id", ForeignKey("tags.id", ondelete="CASCADE"), primary_key=True),
)

credential_tags = Table(
    "credential_tags",
    Base.metadata,
    Column("credential_id", ForeignKey("credentials.id", ondelete="CASCADE"), primary_key=True),
    Column("tag_id", ForeignKey("tags.id", ondelete="CASCADE"), primary_key=True),
)


# ---------------------------------------------------------------- identity & access


class Permission(Base):
    __tablename__ = "permissions"
    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(64), unique=True)
    module: Mapped[str] = mapped_column(String(32))
    action: Mapped[str] = mapped_column(String(32))
    description: Mapped[str] = mapped_column(String(255), default="")


class Role(Base):
    __tablename__ = "roles"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(64), unique=True)
    description: Mapped[str] = mapped_column(String(255), default="")
    is_system: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = _ts()
    permissions: Mapped[list[Permission]] = relationship(secondary=role_permissions, lazy="selectin")


class UserPermissionOverride(Base):
    """Per-user custom permission: granted=True adds, granted=False explicitly denies."""

    __tablename__ = "user_permissions"
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    permission_id: Mapped[int] = mapped_column(ForeignKey("permissions.id", ondelete="CASCADE"), primary_key=True)
    granted: Mapped[bool] = mapped_column(Boolean)
    permission: Mapped[Permission] = relationship(lazy="joined")


class User(Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    email: Mapped[str | None] = mapped_column(String(255), unique=True)
    full_name: Mapped[str] = mapped_column(String(128), default="")
    password_hash: Mapped[str] = mapped_column(String(255))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    must_change_password: Mapped[bool] = mapped_column(Boolean, default=False)
    # When False the user only sees records in the environments listed in user_environments
    all_environments: Mapped[bool] = mapped_column(Boolean, default=True)
    totp_secret_enc: Mapped[bytes | None] = mapped_column(LargeBinary)
    totp_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    failed_attempts: Mapped[int] = mapped_column(Integer, default=0)
    locked_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_login_ip: Mapped[str | None] = mapped_column(String(64))
    password_changed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = _ts()
    updated_at: Mapped[datetime] = _ts_upd()

    roles: Mapped[list[Role]] = relationship(secondary=user_roles, lazy="selectin")
    overrides: Mapped[list[UserPermissionOverride]] = relationship(lazy="selectin", cascade="all, delete-orphan")
    environments: Mapped[list["Environment"]] = relationship(secondary=user_environments, lazy="selectin")


class UserSession(Base):
    __tablename__ = "user_sessions"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    created_at: Mapped[datetime] = _ts()
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    ip_address: Mapped[str | None] = mapped_column(String(64))
    user_agent: Mapped[str | None] = mapped_column(String(255))
    revoked: Mapped[bool] = mapped_column(Boolean, default=False)
    user: Mapped[User] = relationship(lazy="joined")


# ---------------------------------------------------------------- lookups


class Environment(Base):
    __tablename__ = "environments"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(32), unique=True)
    color: Mapped[str] = mapped_column(String(16), default="#64748b")
    sort_order: Mapped[int] = mapped_column(Integer, default=100)
    is_production: Mapped[bool] = mapped_column(Boolean, default=False)


class Tag(Base):
    __tablename__ = "tags"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(48), unique=True)
    color: Mapped[str] = mapped_column(String(16), default="#6366f1")


class CredentialType(Base):
    __tablename__ = "credential_types"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(48), unique=True)
    default_port: Mapped[int | None] = mapped_column(Integer)


# ---------------------------------------------------------------- clients


class Client(Base):
    """A customer / project workspace (e.g. Snitch) owning servers, domains, services and credentials."""

    __tablename__ = "clients"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(128), unique=True, index=True)
    code: Mapped[str | None] = mapped_column(String(32))
    description: Mapped[str | None] = mapped_column(Text)
    # single | three_tier | shared_db | custom
    architecture_type: Mapped[str] = mapped_column(String(32), default="custom")
    color: Mapped[str] = mapped_column(String(16), default="#6366f1")
    contact: Mapped[str | None] = mapped_column(String(255))
    notes: Mapped[str | None] = mapped_column(Text)
    runbook: Mapped[str | None] = mapped_column(Text)
    backup_policy: Mapped[str | None] = mapped_column(Text)
    recovery_plan: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = _ts()
    updated_at: Mapped[datetime] = _ts_upd()


# ---------------------------------------------------------------- servers


class Server(Base):
    __tablename__ = "servers"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(128), unique=True, index=True)
    hostname: Mapped[str | None] = mapped_column(String(255))
    environment_id: Mapped[int] = mapped_column(ForeignKey("environments.id"), index=True)
    client_id: Mapped[int | None] = mapped_column(ForeignKey("clients.id", ondelete="SET NULL"), index=True)
    server_type: Mapped[str] = mapped_column(String(64), default="")
    # application | database | proxy | monitoring | storage | combined | other
    role: Mapped[str] = mapped_column(String(32), default="combined")
    ssh_user: Mapped[str | None] = mapped_column(String(64))
    ssh_port: Mapped[int | None] = mapped_column(Integer)
    ssh_auth_method: Mapped[str | None] = mapped_column(String(32))  # password | key | key+password
    ssh_key_ref: Mapped[str | None] = mapped_column(String(255))  # where the private key lives — never the key
    mount_points: Mapped[str | None] = mapped_column(Text)
    exposed_ports: Mapped[str | None] = mapped_column(Text)
    firewall_notes: Mapped[str | None] = mapped_column(Text)
    backup_policy: Mapped[str | None] = mapped_column(Text)
    recovery_instructions: Mapped[str | None] = mapped_column(Text)
    # Last reachability check: healthy | warning | critical | offline | unknown
    health_status: Mapped[str] = mapped_column(String(16), default="unknown")
    health_detail: Mapped[str | None] = mapped_column(String(255))
    health_checked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    provider: Mapped[str | None] = mapped_column(String(64))
    location: Mapped[str | None] = mapped_column(String(128))
    os_name: Mapped[str | None] = mapped_column(String(64))
    os_version: Mapped[str | None] = mapped_column(String(64))
    kernel_version: Mapped[str | None] = mapped_column(String(64))
    architecture: Mapped[str | None] = mapped_column(String(32))
    docker_version: Mapped[str | None] = mapped_column(String(32))
    compose_version: Mapped[str | None] = mapped_column(String(32))
    status: Mapped[str] = mapped_column(String(32), default="Active")
    owner: Mapped[str | None] = mapped_column(String(128))
    purpose: Mapped[str | None] = mapped_column(Text)
    notes: Mapped[str | None] = mapped_column(Text)
    created_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    updated_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = _ts()
    updated_at: Mapped[datetime] = _ts_upd()

    environment: Mapped[Environment] = relationship(lazy="joined")
    client: Mapped[Client | None] = relationship(lazy="joined")
    spec: Mapped["ServerSpec | None"] = relationship(
        lazy="joined", uselist=False, cascade="all, delete-orphan", back_populates="server"
    )
    networks: Mapped[list["ServerNetwork"]] = relationship(
        lazy="selectin", cascade="all, delete-orphan", order_by="ServerNetwork.id"
    )
    tags: Mapped[list[Tag]] = relationship(secondary=server_tags, lazy="selectin")


class ServerSpec(Base):
    __tablename__ = "server_specs"
    server_id: Mapped[int] = mapped_column(ForeignKey("servers.id", ondelete="CASCADE"), primary_key=True)
    cpu_cores: Mapped[int | None] = mapped_column(Integer)
    ram_gb: Mapped[float | None] = mapped_column(Numeric(10, 2))
    disk_gb: Mapped[float | None] = mapped_column(Numeric(12, 2))
    disk_usage_pct: Mapped[float | None] = mapped_column(Numeric(5, 2))
    server: Mapped[Server] = relationship(back_populates="spec")


class ServerNetwork(Base):
    __tablename__ = "server_networks"
    id: Mapped[int] = mapped_column(primary_key=True)
    server_id: Mapped[int] = mapped_column(ForeignKey("servers.id", ondelete="CASCADE"), index=True)
    ip_type: Mapped[str] = mapped_column(String(16))  # private | public | vpn | network | management
    ip_address: Mapped[str] = mapped_column(INET, index=True)
    label: Mapped[str | None] = mapped_column(String(64))


class Domain(Base):
    __tablename__ = "domains"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    client_id: Mapped[int | None] = mapped_column(ForeignKey("clients.id", ondelete="SET NULL"), index=True)
    environment_id: Mapped[int | None] = mapped_column(ForeignKey("environments.id", ondelete="SET NULL"))
    server_id: Mapped[int | None] = mapped_column(ForeignKey("servers.id", ondelete="SET NULL"), index=True)
    record_type: Mapped[str] = mapped_column(String(8), default="A")
    target: Mapped[str | None] = mapped_column(String(255))
    dns_provider: Mapped[str | None] = mapped_column(String(64))
    ssl_provider: Mapped[str | None] = mapped_column(String(64))
    ssl_expires_at: Mapped[date | None] = mapped_column(Date)
    purpose: Mapped[str | None] = mapped_column(String(255))
    notes: Mapped[str | None] = mapped_column(Text)
    health_status: Mapped[str] = mapped_column(String(16), default="unknown")
    health_detail: Mapped[str | None] = mapped_column(String(255))
    health_checked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = _ts()
    updated_at: Mapped[datetime] = _ts_upd()

    client: Mapped[Client | None] = relationship(lazy="joined")
    environment: Mapped[Environment | None] = relationship(lazy="joined")
    server: Mapped["Server | None"] = relationship(lazy="joined")


# ---------------------------------------------------------------- credentials


class Credential(Base):
    __tablename__ = "credentials"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(160), index=True)
    credential_type_id: Mapped[int] = mapped_column(ForeignKey("credential_types.id"))
    category: Mapped[str | None] = mapped_column(String(64))
    server_id: Mapped[int | None] = mapped_column(ForeignKey("servers.id", ondelete="SET NULL"), index=True)
    client_id: Mapped[int | None] = mapped_column(ForeignKey("clients.id", ondelete="SET NULL"), index=True)
    service_id: Mapped[int | None] = mapped_column(ForeignKey("application_versions.id", ondelete="SET NULL"), index=True)
    environment_id: Mapped[int] = mapped_column(ForeignKey("environments.id"), index=True)
    host: Mapped[str | None] = mapped_column(String(255))
    port: Mapped[int | None] = mapped_column(Integer)
    username: Mapped[str | None] = mapped_column(String(255))
    url: Mapped[str | None] = mapped_column(String(512))
    service: Mapped[str | None] = mapped_column(String(64))
    description: Mapped[str | None] = mapped_column(Text)
    owner: Mapped[str | None] = mapped_column(String(128))
    status: Mapped[str] = mapped_column(String(32), default="Active")
    notes: Mapped[str | None] = mapped_column(Text)
    # Secret storage: ciphertext for the local provider; NULL when kept in HashiCorp Vault
    secret_enc: Mapped[bytes | None] = mapped_column(LargeBinary)
    secret_provider: Mapped[str] = mapped_column(String(16))
    has_secret: Mapped[bool] = mapped_column(Boolean, default=False)
    password_changed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    expires_at: Mapped[date | None] = mapped_column(Date)
    # static = never rotates automatically; periodic = must rotate every rotation_interval_days
    rotation_policy: Mapped[str] = mapped_column(String(16), default="static")
    rotation_interval_days: Mapped[int | None] = mapped_column(Integer)
    next_rotation_at: Mapped[date | None] = mapped_column(Date)
    # Set when the password is changed in the portal, cleared once someone confirms it was changed on the target
    pending_verification: Mapped[bool] = mapped_column(Boolean, default=False)
    last_change_reason: Mapped[str | None] = mapped_column(String(255))
    created_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    updated_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = _ts()
    updated_at: Mapped[datetime] = _ts_upd()

    credential_type: Mapped[CredentialType] = relationship(lazy="joined")
    client: Mapped[Client | None] = relationship(lazy="joined")
    linked_service: Mapped["ApplicationVersion | None"] = relationship(lazy="joined", foreign_keys=[service_id])
    environment: Mapped[Environment] = relationship(lazy="joined")
    server: Mapped[Server | None] = relationship(lazy="joined")
    tags: Mapped[list[Tag]] = relationship(secondary=credential_tags, lazy="selectin")


class CredentialSecretHistory(Base):
    """Previous secret versions (max 5 per credential). Encrypted with a separate key; never exported in inventory."""

    __tablename__ = "credential_secret_history"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    credential_id: Mapped[int] = mapped_column(ForeignKey("credentials.id", ondelete="CASCADE"), index=True)
    secret_enc: Mapped[bytes | None] = mapped_column(LargeBinary)  # local provider
    vault_version: Mapped[int | None] = mapped_column(Integer)  # hashicorp provider (KV v2 version)
    provider: Mapped[str] = mapped_column(String(16))
    valid_from: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    replaced_at: Mapped[datetime] = _ts()
    replaced_by: Mapped[str | None] = mapped_column(String(64))
    reason: Mapped[str | None] = mapped_column(String(255))


# ---------------------------------------------------------------- versions


class Application(Base):
    __tablename__ = "applications"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(128), unique=True)
    category: Mapped[str | None] = mapped_column(String(64))
    description: Mapped[str | None] = mapped_column(Text)
    repository_url: Mapped[str | None] = mapped_column(String(512))
    created_at: Mapped[datetime] = _ts()


class ApplicationVersion(Base):
    """What is currently deployed: one row per application/component/server/environment."""

    __tablename__ = "application_versions"
    __table_args__ = (UniqueConstraint("application_id", "component", "server_id", "environment_id"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    application_id: Mapped[int] = mapped_column(ForeignKey("applications.id", ondelete="CASCADE"), index=True)
    component: Mapped[str] = mapped_column(String(128))
    server_id: Mapped[int | None] = mapped_column(ForeignKey("servers.id", ondelete="SET NULL"), index=True)
    environment_id: Mapped[int] = mapped_column(ForeignKey("environments.id"), index=True)
    current_version: Mapped[str] = mapped_column(String(64))
    previous_version: Mapped[str | None] = mapped_column(String(64))
    image: Mapped[str | None] = mapped_column(String(255))
    # ui | api | worker | database | cache | queue | storage | proxy | monitoring | other
    service_type: Mapped[str] = mapped_column(String(16), default="other")
    port: Mapped[int | None] = mapped_column(Integer)
    protocol: Mapped[str | None] = mapped_column(String(16))
    health_url: Mapped[str | None] = mapped_column(String(512))
    deployed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    notes: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = _ts()
    updated_at: Mapped[datetime] = _ts_upd()

    application: Mapped[Application] = relationship(lazy="joined")
    server: Mapped[Server | None] = relationship(lazy="joined")
    environment: Mapped[Environment] = relationship(lazy="joined")
    updated_by: Mapped[User | None] = relationship(lazy="joined")


class VersionHistory(Base):
    __tablename__ = "version_history"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    application_version_id: Mapped[int | None] = mapped_column(
        ForeignKey("application_versions.id", ondelete="SET NULL"), index=True
    )
    # Snapshot columns so history survives deletes/renames
    application_name: Mapped[str] = mapped_column(String(128))
    component: Mapped[str] = mapped_column(String(128))
    server_name: Mapped[str | None] = mapped_column(String(128))
    environment_name: Mapped[str] = mapped_column(String(32))
    old_version: Mapped[str | None] = mapped_column(String(64))
    new_version: Mapped[str] = mapped_column(String(64))
    changed_by: Mapped[str | None] = mapped_column(String(64))
    changed_at: Mapped[datetime] = _ts()
    notes: Mapped[str | None] = mapped_column(Text)


class ServiceDependency(Base):
    """Directed connection between two services (e.g. API → PostgreSQL)."""

    __tablename__ = "service_dependencies"
    __table_args__ = (UniqueConstraint("from_service_id", "to_service_id"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    from_service_id: Mapped[int] = mapped_column(ForeignKey("application_versions.id", ondelete="CASCADE"), index=True)
    to_service_id: Mapped[int] = mapped_column(ForeignKey("application_versions.id", ondelete="CASCADE"), index=True)
    protocol: Mapped[str | None] = mapped_column(String(16))
    port: Mapped[int | None] = mapped_column(Integer)
    label: Mapped[str | None] = mapped_column(String(64))


class ArchitectureLayout(Base):
    """Saved diagram per client: node positions/sizes/colours/labels, manual nodes and edges (React Flow JSON)."""

    __tablename__ = "architecture_layouts"
    client_id: Mapped[int] = mapped_column(ForeignKey("clients.id", ondelete="CASCADE"), primary_key=True)
    layout: Mapped[dict] = mapped_column(JSONB)
    updated_at: Mapped[datetime] = _ts_upd()
    updated_by: Mapped[str | None] = mapped_column(String(64))


# ---------------------------------------------------------------- settings, reports, backups


class AppSetting(Base):
    __tablename__ = "app_settings"
    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[dict] = mapped_column(JSONB)
    secret_enc: Mapped[bytes | None] = mapped_column(LargeBinary)
    updated_at: Mapped[datetime] = _ts_upd()


class ReportRun(Base):
    __tablename__ = "report_runs"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    created_at: Mapped[datetime] = _ts()
    kind: Mapped[str] = mapped_column(String(16))  # scheduled | manual | test
    status: Mapped[str] = mapped_column(String(16))  # sent | failed
    recipients: Mapped[str | None] = mapped_column(Text)
    detail: Mapped[str | None] = mapped_column(Text)
    triggered_by: Mapped[str | None] = mapped_column(String(64))


class ConfigBackup(Base):
    """Inventory snapshot (no secrets) taken by the scheduler or on demand."""

    __tablename__ = "config_backups"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    created_at: Mapped[datetime] = _ts()
    kind: Mapped[str] = mapped_column(String(16))  # scheduled | manual | pre-import
    checksum: Mapped[str] = mapped_column(String(64))
    size_bytes: Mapped[int] = mapped_column(Integer)
    summary: Mapped[dict | None] = mapped_column(JSONB)
    content: Mapped[dict] = mapped_column(JSONB)
    created_by: Mapped[str | None] = mapped_column(String(64))


# ---------------------------------------------------------------- audit


class AuditLog(Base):
    __tablename__ = "audit_logs"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), index=True)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), index=True)
    username: Mapped[str | None] = mapped_column(String(64))
    action: Mapped[str] = mapped_column(String(48), index=True)
    entity_type: Mapped[str | None] = mapped_column(String(32))
    entity_id: Mapped[int | None] = mapped_column(Integer)
    entity_label: Mapped[str | None] = mapped_column(String(255))
    ip_address: Mapped[str | None] = mapped_column(String(64))
    user_agent: Mapped[str | None] = mapped_column(String(255))
    details: Mapped[dict | None] = mapped_column(JSONB)
