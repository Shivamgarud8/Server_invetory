"""Startup check: explain configuration / database problems in one clear line instead of a traceback."""

import ipaddress
import re
import socket
import sys
import time

from pydantic import ValidationError
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import OperationalError


def fail(msg: str) -> None:
    print(f"\n✗ STARTUP ERROR: {msg}\n  → fix .env, then run: docker compose up -d\n", file=sys.stderr, flush=True)
    time.sleep(10)  # avoid a tight restart loop flooding the logs
    sys.exit(1)


def main() -> None:
    try:
        from .config import get_settings

        s = get_settings()
        url = s.sqlalchemy_url
    except ValidationError as e:
        first = e.errors()[0]
        fail(f"{'.'.join(str(x) for x in first['loc']).upper()}: {first['msg']}")
    except ValueError as e:
        fail(str(e))

    u = make_url(url) if isinstance(url, str) else url
    host, port = u.host or "localhost", u.port or 5432
    where = "DATABASE_URL" if s.database_url else "DB_HOST"

    if re.fullmatch(r"[\d.]+", host):
        try:
            ipaddress.ip_address(host)
        except ValueError:
            fail(f"{where}={host} is not a valid IP address (typo?)")

    last: OSError | None = None
    for attempt in range(15):
        try:
            socket.create_connection((host, port), timeout=3).close()
            break
        except socket.gaierror:
            fail(f"{where}={host} cannot be resolved. Use the PostgreSQL server's IP address.")
        except OSError as e:
            last = e
            if attempt == 0:
                print(f"Waiting for PostgreSQL at {host}:{port}…", flush=True)
            time.sleep(2)
    else:
        fail(f"cannot reach PostgreSQL at {host}:{port} ({last.strerror if last else 'timeout'}). "
             "Check DB_HOST / DB_PORT, that PostgreSQL listens on that address, and the firewall.")

    try:
        with create_engine(url, pool_pre_ping=False).connect() as c:
            c.execute(text("SELECT 1"))
    except OperationalError as e:
        msg = str(e.orig).strip().splitlines()[0] if e.orig else str(e)
        if "password authentication failed" in msg:
            fail(f"PostgreSQL rejected user '{u.username}' — check DB_USER / DB_PASSWORD, or run ./scripts/setup-db.sh")
        if "does not exist" in msg:
            fail(f"{msg} — run ./scripts/setup-db.sh to create the database and user")
        if "no pg_hba.conf entry" in msg:
            fail(f"PostgreSQL does not allow this server to connect ({msg}). Add it to pg_hba.conf.")
        fail(f"cannot connect to PostgreSQL at {host}:{port}: {msg}")
    print(f"PostgreSQL OK ({host}:{port}/{u.database})", flush=True)


if __name__ == "__main__":
    main()
