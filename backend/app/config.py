import os
from functools import lru_cache
from urllib.parse import urlsplit

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy.engine import URL


class Settings(BaseSettings):
    # Real environment variables (.env via docker compose) win over the auto-generated secrets file
    model_config = SettingsConfigDict(
        env_file=(os.environ.get("SECRETS_FILE", "/app/secrets/generated.env"), ".env"),
        extra="ignore",
        env_ignore_empty=True,  # KEY= (empty) in .env means "use the default / auto-generated value"
    )

    # Application
    app_name: str = "TagID Infra Manager"
    app_env: str = "production"
    app_host: str = "0.0.0.0"
    app_port: int = 8080
    tz: str = "Asia/Kolkata"

    # Shown in the top bar so you always know which deployment you are on (e.g. "srv-106 · PROD")
    server_label: str = ""
    # Public address users open, e.g. https://10.80.0.106 or https://infra.tagid.internal
    public_url: str = ""
    default_theme: str = "system"  # light | dark | system

    # Database — either the individual DB_* settings (preferred) or a full DATABASE_URL
    db_host: str = "localhost"
    db_port: int = 5432
    db_name: str = "tagid_infra_manager"
    db_user: str = "infra_manager_app"
    db_password: str | None = None
    db_sslmode: str = "prefer"  # disable | prefer | require | verify-full
    database_url: str | None = None

    # Authentication / sessions
    app_secret_key: str
    session_idle_minutes: int = 30
    session_absolute_hours: int = 12
    login_max_failed_attempts: int = 5
    login_lockout_minutes: int = 15
    login_rate_limit_per_minute: int = 20
    cookie_secure: bool = True

    # Credential vault: "local" (AES-256-GCM in PostgreSQL) or "hashicorp" (Vault KV v2)
    vault_provider: str = "local"
    credential_encryption_key: str | None = None  # base64, 32 bytes — required for "local"
    vault_addr: str | None = None
    vault_token: str | None = None
    vault_mount: str = "secret"
    vault_path_prefix: str = "tagid-infra-manager"
    vault_namespace: str | None = None
    vault_ca_cert: str | None = None

    # Network
    allowed_origins: str = ""
    trusted_networks: str = ""  # comma-separated CIDRs; empty = allow all
    trusted_proxies: str = "127.0.0.1/32,172.16.0.0/12,10.0.0.0/8,192.168.0.0/16"

    # Persistent data
    data_dir: str = "/tagid_data/infra-manager"
    backup_dir: str = "/tagid_data/infra-manager/backups"

    # Bootstrap
    # First admin is created automatically when there are no users; a random password is generated
    # (and printed once in the backend log) unless BOOTSTRAP_ADMIN_PASSWORD is set
    bootstrap_admin_enabled: bool = True
    bootstrap_admin_username: str = "admin"
    bootstrap_admin_password: str | None = None
    bootstrap_admin_email: str | None = None

    # Credentials expiring within this many days are flagged
    credential_expiry_warning_days: int = 30

    @field_validator("vault_provider")
    @classmethod
    def _provider(cls, v: str) -> str:
        v = v.lower().strip()
        if v not in {"local", "hashicorp"}:
            raise ValueError("VAULT_PROVIDER must be 'local' or 'hashicorp'")
        return v

    @field_validator("app_secret_key")
    @classmethod
    def _secret(cls, v: str) -> str:
        if len(v) < 32 or v.startswith("REPLACE_"):
            raise ValueError("APP_SECRET_KEY must be a random value of at least 32 characters")
        return v

    @property
    def sqlalchemy_url(self) -> URL | str:
        if self.database_url and not self.database_url.startswith("REPLACE_"):
            raw = self.database_url
            for prefix in ("postgresql://", "postgres://"):
                if raw.startswith(prefix):
                    raw = "postgresql+psycopg://" + raw[len(prefix):]
            return raw
        if not self.db_password or self.db_password.startswith("REPLACE_"):
            raise ValueError("Set DB_PASSWORD (or DATABASE_URL) in .env")
        return URL.create(
            "postgresql+psycopg", username=self.db_user, password=self.db_password, host=self.db_host,
            port=self.db_port, database=self.db_name, query={"sslmode": self.db_sslmode},
        )

    @property
    def origins(self) -> list[str]:
        explicit = [o.strip() for o in self.allowed_origins.split(",") if o.strip() and not o.startswith("REPLACE_")]
        if explicit:
            return explicit
        if self.public_url:
            u = urlsplit(self.public_url)
            return [f"{u.scheme}://{u.netloc}"]
        return []

    @property
    def trusted_network_list(self) -> list[str]:
        return [n.strip() for n in self.trusted_networks.split(",") if n.strip() and not n.strip().startswith("REPLACE_")]

    @property
    def trusted_proxy_list(self) -> list[str]:
        return [n.strip() for n in self.trusted_proxies.split(",") if n.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
