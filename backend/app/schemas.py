import ipaddress
from datetime import date, datetime

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator


class ORM(BaseModel):
    model_config = ConfigDict(from_attributes=True)


def _blank_to_none(v):
    if isinstance(v, str) and not v.strip():
        return None
    return v.strip() if isinstance(v, str) else v


# ---------------------------------------------------------------- lookups


class EnvironmentIn(BaseModel):
    name: str = Field(min_length=1, max_length=32)
    color: str = "#64748b"
    sort_order: int = 100
    is_production: bool = False

    @field_validator("name")
    @classmethod
    def _upper(cls, v: str) -> str:
        return v.strip().upper()


class EnvironmentOut(ORM):
    id: int
    name: str
    color: str
    sort_order: int
    is_production: bool


class TagIn(BaseModel):
    name: str = Field(min_length=1, max_length=48)
    color: str = "#6366f1"

    @field_validator("name")
    @classmethod
    def _upper(cls, v: str) -> str:
        return v.strip().upper()


class TagOut(ORM):
    id: int
    name: str
    color: str


class CredentialTypeIn(BaseModel):
    name: str = Field(min_length=1, max_length=48)
    default_port: int | None = Field(default=None, ge=1, le=65535)


class CredentialTypeOut(ORM):
    id: int
    name: str
    default_port: int | None


# ---------------------------------------------------------------- auth


class LoginIn(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=256)
    totp_code: str | None = None


class ChangePasswordIn(BaseModel):
    current_password: str
    new_password: str = Field(max_length=256)


class TotpConfirmIn(BaseModel):
    code: str


class TotpDisableIn(BaseModel):
    password: str
    code: str


class MeOut(BaseModel):
    id: int
    username: str
    full_name: str
    email: str | None
    roles: list[str]
    permissions: list[str]
    all_environments: bool
    environments: list[EnvironmentOut]
    totp_enabled: bool
    must_change_password: bool
    session_idle_minutes: int
    vault_provider: str


# ---------------------------------------------------------------- users & roles


class PermissionOut(ORM):
    id: int
    code: str
    module: str
    action: str
    description: str


class RoleIn(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    description: str = ""
    permissions: list[str] = []


class RoleOut(ORM):
    id: int
    name: str
    description: str
    is_system: bool
    permissions: list[str]
    user_count: int = 0


class OverrideIn(BaseModel):
    code: str
    granted: bool


class UserCreate(BaseModel):
    username: str = Field(min_length=3, max_length=64, pattern=r"^[a-zA-Z0-9._-]+$")
    email: EmailStr | None = None
    full_name: str = ""
    password: str = Field(max_length=256)
    is_active: bool = True
    must_change_password: bool = True
    role_ids: list[int] = []
    overrides: list[OverrideIn] = []
    all_environments: bool = True
    environment_ids: list[int] = []

    _e = field_validator("email", mode="before")(_blank_to_none)


class UserUpdate(BaseModel):
    email: EmailStr | None = None
    full_name: str = ""
    is_active: bool = True
    role_ids: list[int] = []
    overrides: list[OverrideIn] = []
    all_environments: bool = True
    environment_ids: list[int] = []

    _e = field_validator("email", mode="before")(_blank_to_none)


class ResetPasswordIn(BaseModel):
    new_password: str = Field(max_length=256)
    must_change_password: bool = True


class UserOut(BaseModel):
    id: int
    username: str
    email: str | None
    full_name: str
    is_active: bool
    must_change_password: bool
    totp_enabled: bool
    locked: bool
    last_login_at: datetime | None
    last_login_ip: str | None
    created_at: datetime
    roles: list[RoleOut]
    role_ids: list[int]
    overrides: list[OverrideIn]
    all_environments: bool
    environment_ids: list[int]
    effective_permissions: list[str]


class SessionOut(BaseModel):
    id: int
    user_id: int
    username: str
    created_at: datetime
    last_seen_at: datetime
    expires_at: datetime
    ip_address: str | None
    user_agent: str | None
    current: bool = False


# ---------------------------------------------------------------- clients

ARCH_TYPES = r"^(single|three_tier|shared_db|custom)$"


class ClientIn(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    code: str | None = None
    description: str | None = None
    architecture_type: str = Field(default="custom", pattern=ARCH_TYPES)
    color: str = "#6366f1"
    contact: str | None = None
    notes: str | None = None
    runbook: str | None = None
    backup_policy: str | None = None
    recovery_plan: str | None = None

    _b = field_validator("code", "description", "contact", "notes", "runbook", "backup_policy", "recovery_plan",
                         mode="before")(_blank_to_none)


class ClientBrief(ORM):
    id: int
    name: str
    color: str


class ClientOut(ORM):
    id: int
    name: str
    code: str | None
    description: str | None
    architecture_type: str
    color: str
    contact: str | None
    notes: str | None
    runbook: str | None
    backup_policy: str | None
    recovery_plan: str | None
    created_at: datetime
    updated_at: datetime
    server_count: int = 0
    service_count: int = 0
    domain_count: int = 0
    credential_count: int = 0
    environments: list[str] = []
    health: dict[str, int] = {}


# ---------------------------------------------------------------- servers


class NetworkIn(BaseModel):
    ip_type: str = Field(pattern=r"^(private|public|vpn|network|management)$")
    ip_address: str
    label: str | None = None

    @field_validator("ip_address")
    @classmethod
    def _ip(cls, v: str) -> str:
        v = v.strip()
        ipaddress.ip_interface(v)  # accepts 10.0.0.1 or 10.0.0.1/24
        return v


class NetworkOut(ORM):
    id: int
    ip_type: str
    ip_address: str
    label: str | None

    @field_validator("ip_address", mode="before")
    @classmethod
    def _s(cls, v):
        return str(v)


class SpecIn(ORM):
    cpu_cores: int | None = Field(default=None, ge=0, le=4096)
    ram_gb: float | None = Field(default=None, ge=0)
    disk_gb: float | None = Field(default=None, ge=0)
    disk_usage_pct: float | None = Field(default=None, ge=0, le=100)


SERVER_ROLES = r"^(application|database|proxy|monitoring|storage|combined|other)$"


class ServerIn(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    hostname: str | None = None
    environment_id: int
    client_id: int | None = None
    server_type: str = Field(min_length=1, max_length=64)
    role: str = Field(default="combined", pattern=SERVER_ROLES)
    ssh_user: str | None = None
    ssh_port: int | None = Field(default=None, ge=1, le=65535)
    ssh_auth_method: str | None = None
    ssh_key_ref: str | None = None
    mount_points: str | None = None
    exposed_ports: str | None = None
    firewall_notes: str | None = None
    backup_policy: str | None = None
    recovery_instructions: str | None = None
    provider: str | None = None
    location: str | None = None
    os_name: str | None = None
    os_version: str | None = None
    kernel_version: str | None = None
    architecture: str | None = None
    docker_version: str | None = None
    compose_version: str | None = None
    status: str = "Active"
    owner: str | None = None
    purpose: str | None = None
    notes: str | None = None
    spec: SpecIn = SpecIn()
    networks: list[NetworkIn] = []
    tag_ids: list[int] = []

    _b = field_validator(
        "hostname", "provider", "location", "os_name", "os_version", "kernel_version", "architecture",
        "docker_version", "compose_version", "owner", "purpose", "notes", "ssh_user", "ssh_auth_method",
        "ssh_key_ref", "mount_points", "exposed_ports", "firewall_notes", "backup_policy", "recovery_instructions",
        mode="before",
    )(_blank_to_none)


class ServerBrief(ORM):
    id: int
    name: str


class ServerOut(ORM):
    id: int
    name: str
    hostname: str | None
    environment: EnvironmentOut
    client: ClientBrief | None
    server_type: str
    role: str
    ssh_user: str | None
    ssh_port: int | None
    ssh_auth_method: str | None
    ssh_key_ref: str | None
    mount_points: str | None
    exposed_ports: str | None
    firewall_notes: str | None
    backup_policy: str | None
    recovery_instructions: str | None
    health_status: str
    health_detail: str | None
    health_checked_at: datetime | None
    provider: str | None
    location: str | None
    os_name: str | None
    os_version: str | None
    kernel_version: str | None
    architecture: str | None
    docker_version: str | None
    compose_version: str | None
    status: str
    owner: str | None
    purpose: str | None
    notes: str | None
    spec: SpecIn | None
    networks: list[NetworkOut]
    tags: list[TagOut]
    created_at: datetime
    updated_at: datetime
    credential_count: int = 0
    deployment_count: int = 0


# ---------------------------------------------------------------- credentials


class CredentialIn(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    credential_type_id: int
    category: str | None = None
    server_id: int | None = None
    client_id: int | None = None
    service_id: int | None = None
    rotation_policy: str = Field(default="static", pattern=r"^(static|periodic)$")
    rotation_interval_days: int | None = Field(default=None, ge=1, le=3650)
    next_rotation_at: date | None = None
    change_reason: str | None = Field(default=None, max_length=255)
    environment_id: int
    host: str | None = None
    port: int | None = Field(default=None, ge=1, le=65535)
    username: str | None = None
    # None on update = keep the existing password
    password: str | None = Field(default=None, max_length=4096)
    url: str | None = None
    service: str | None = None
    description: str | None = None
    owner: str | None = None
    status: str = "Active"
    expires_at: date | None = None
    notes: str | None = None
    tag_ids: list[int] = []

    _b = field_validator(
        "category", "host", "username", "url", "service", "description", "owner", "notes", mode="before"
    )(_blank_to_none)


class ServiceBrief(BaseModel):
    id: int
    label: str


class CredentialOut(ORM):
    id: int
    name: str
    credential_type: CredentialTypeOut
    category: str | None
    server: ServerBrief | None
    client: ClientBrief | None
    linked_service: ServiceBrief | None = None
    rotation_policy: str
    rotation_interval_days: int | None
    next_rotation_at: date | None
    pending_verification: bool
    last_change_reason: str | None
    history_count: int = 0

    @field_validator("linked_service", mode="before")
    @classmethod
    def _svc(cls, v):
        if v is None or isinstance(v, (dict, ServiceBrief)):
            return v
        return {"id": v.id, "label": f"{v.application.name} / {v.component}" + (f" @ {v.server.name}" if v.server else "")}
    environment: EnvironmentOut
    host: str | None
    port: int | None
    username: str | None
    url: str | None
    service: str | None
    description: str | None
    owner: str | None
    status: str
    notes: str | None
    has_secret: bool
    secret_provider: str
    password_changed_at: datetime | None
    expires_at: date | None
    tags: list[TagOut]
    created_at: datetime
    updated_at: datetime


class RevealOut(BaseModel):
    password: str


class SetSecretIn(BaseModel):
    password: str = Field(min_length=1, max_length=4096)
    reason: str = Field(min_length=1, max_length=255)


class HistoryEntryOut(BaseModel):
    id: int
    valid_from: datetime | None
    replaced_at: datetime
    replaced_by: str | None
    reason: str | None


class ReauthIn(BaseModel):
    current_password: str = Field(min_length=1, max_length=256)


class RevealIn(BaseModel):
    purpose: str = Field(default="view", pattern=r"^(view|copy)$")


# ---------------------------------------------------------------- versions


class ApplicationIn(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    category: str | None = None
    description: str | None = None
    repository_url: str | None = None

    _b = field_validator("category", "description", "repository_url", mode="before")(_blank_to_none)


class ApplicationOut(ORM):
    id: int
    name: str
    category: str | None
    description: str | None
    repository_url: str | None
    deployment_count: int = 0


SERVICE_TYPES = r"^(ui|api|worker|database|cache|queue|storage|proxy|monitoring|other)$"


class DeploymentIn(BaseModel):
    application_id: int
    component: str = Field(min_length=1, max_length=128)
    server_id: int | None = None
    environment_id: int
    current_version: str = Field(default="-", min_length=1, max_length=64)
    image: str | None = None
    service_type: str = Field(default="other", pattern=SERVICE_TYPES)
    port: int | None = Field(default=None, ge=1, le=65535)
    protocol: str | None = None
    health_url: str | None = None
    deployed_at: datetime | None = None
    notes: str | None = None

    _b = field_validator("image", "notes", "protocol", "health_url", mode="before")(_blank_to_none)


class VersionUpdateIn(BaseModel):
    new_version: str = Field(min_length=1, max_length=64)
    deployed_at: datetime | None = None
    image: str | None = None
    notes: str | None = None


class DeploymentOut(ORM):
    id: int
    application: ApplicationOut
    component: str
    server: ServerBrief | None
    environment: EnvironmentOut
    current_version: str
    previous_version: str | None
    image: str | None
    deployed_at: datetime
    updated_by_name: str | None = None
    notes: str | None
    service_type: str
    port: int | None
    protocol: str | None
    health_url: str | None


class HistoryOut(ORM):
    id: int
    application_version_id: int | None
    application_name: str
    component: str
    server_name: str | None
    environment_name: str
    old_version: str | None
    new_version: str
    changed_by: str | None
    changed_at: datetime
    notes: str | None


class DependencyIn(BaseModel):
    from_service_id: int
    to_service_id: int
    protocol: str | None = None
    port: int | None = Field(default=None, ge=1, le=65535)
    label: str | None = None


class DependencyOut(ORM):
    id: int
    from_service_id: int
    to_service_id: int
    protocol: str | None
    port: int | None
    label: str | None


# ---------------------------------------------------------------- domains


class DomainIn(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    client_id: int | None = None
    environment_id: int | None = None
    server_id: int | None = None
    record_type: str = Field(default="A", pattern=r"^(A|AAAA|CNAME|ALIAS|MX|TXT|NS|SRV|OTHER)$")
    target: str | None = None
    dns_provider: str | None = None
    ssl_provider: str | None = None
    ssl_expires_at: date | None = None
    purpose: str | None = None
    notes: str | None = None

    _b = field_validator("target", "dns_provider", "ssl_provider", "purpose", "notes", mode="before")(_blank_to_none)

    @field_validator("name")
    @classmethod
    def _lower(cls, v: str) -> str:
        return v.strip().lower()


class DomainOut(ORM):
    id: int
    name: str
    client: ClientBrief | None
    environment: EnvironmentOut | None
    server: ServerBrief | None
    record_type: str
    target: str | None
    dns_provider: str | None
    ssl_provider: str | None
    ssl_expires_at: date | None
    purpose: str | None
    notes: str | None
    health_status: str
    health_detail: str | None
    health_checked_at: datetime | None


# ---------------------------------------------------------------- audit


class AuditOut(ORM):
    id: int
    created_at: datetime
    username: str | None
    action: str
    entity_type: str | None
    entity_id: int | None
    entity_label: str | None
    ip_address: str | None
    user_agent: str | None
    details: dict | None


class Page(BaseModel):
    total: int
    items: list
