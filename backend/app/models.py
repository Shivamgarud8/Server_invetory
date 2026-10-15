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


# ---------------------------------------------------------------- servers


class Server(Base):
    __tablename__ = "servers"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(128), unique=True, index=True)
    hostname: Mapped[str | None] = mapped_column(String(255))
    environment_id: Mapped[int] = mapped_column(ForeignKey("environments.id"), index=True)
    server_type: Mapped[str] = mapped_column(String(64), default="")
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
    ip_type: Mapped[str] = mapped_column(String(16))  # private | public | network | management
    ip_address: Mapped[str] = mapped_column(INET, index=True)
    label: Mapped[str | None] = mapped_column(String(64))


# ---------------------------------------------------------------- credentials


class Credential(Base):
    __tablename__ = "credentials"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(160), index=True)
    credential_type_id: Mapped[int] = mapped_column(ForeignKey("credential_types.id"))
    category: Mapped[str | None] = mapped_column(String(64))
    server_id: Mapped[int | None] = mapped_column(ForeignKey("servers.id", ondelete="SET NULL"), index=True)
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
    created_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    updated_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = _ts()
    updated_at: Mapped[datetime] = _ts_upd()

    credential_type: Mapped[CredentialType] = relationship(lazy="joined")
    environment: Mapped[Environment] = relationship(lazy="joined")
    server: Mapped[Server | None] = relationship(lazy="joined")
    tags: Mapped[list[Tag]] = relationship(secondary=credential_tags, lazy="selectin")


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
