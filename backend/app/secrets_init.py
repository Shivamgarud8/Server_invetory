"""Generate APP_SECRET_KEY and CREDENTIAL_ENCRYPTION_KEY on first start.

Runs once from docker-entrypoint.sh (single process, before the workers start). The values are
stored in SECRETS_FILE on a dedicated Docker volume, never in PostgreSQL. A value set in the
environment (.env) always wins and is never overwritten.
"""

import base64
import os
import secrets
from pathlib import Path

PATH = Path(os.environ.get("SECRETS_FILE", "/app/secrets/generated.env"))

GENERATORS = {
    "APP_SECRET_KEY": lambda: secrets.token_urlsafe(48),
    "CREDENTIAL_ENCRYPTION_KEY": lambda: base64.b64encode(os.urandom(32)).decode(),
}


def _read() -> dict[str, str]:
    if not PATH.exists():
        return {}
    pairs = (line.split("=", 1) for line in PATH.read_text().splitlines() if "=" in line and not line.startswith("#"))
    return {k.strip(): v.strip() for k, v in pairs}


def _set_in_env(name: str) -> bool:
    v = os.environ.get(name, "")
    return bool(v) and not v.startswith("REPLACE_")


def main() -> None:
    stored = _read()
    missing = [k for k in GENERATORS if not _set_in_env(k) and not stored.get(k)]
    if not missing:
        return
    for k in missing:
        stored[k] = GENERATORS[k]()
    PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = PATH.with_suffix(".tmp")
    tmp.write_text("# Auto-generated on first start. Back this file up; never edit or delete it.\n"
                   + "".join(f"{k}={v}\n" for k, v in stored.items()))
    tmp.chmod(0o600)
    tmp.replace(PATH)
    print(f"Generated {', '.join(missing)} → {PATH}")
    print("BACK THESE UP (needed to read stored passwords after a server move):")
    print("  docker compose exec tagid-portal-backend cat " + str(PATH))


if __name__ == "__main__":
    main()
