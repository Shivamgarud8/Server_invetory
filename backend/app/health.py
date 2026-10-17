"""Non-intrusive reachability checks (no agents, nothing installed on the servers).

A failed check is not proof that a server is down: a timeout is reported as "unknown"
(firewall, VPN, routing), only a clear answer changes the status.
"""

import socket
import ssl
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import Domain, Server

PREFERRED_IPS = ("private", "vpn", "public", "network", "management")


def _ip(s: Server) -> str | None:
    for kind in PREFERRED_IPS:
        for n in s.networks:
            if n.ip_type == kind:
                return str(n.ip_address).split("/")[0]
    return s.hostname


def check_tcp(host: str | None, port: int) -> tuple[str, str]:
    if not host:
        return "unknown", "No IP address or hostname recorded"
    try:
        with socket.create_connection((host, port), timeout=3):
            return "healthy", f"Port {port} reachable on {host}"
    except ConnectionRefusedError:
        return "warning", f"{host} answered but port {port} is closed"
    except socket.gaierror:
        return "critical", f"Cannot resolve {host}"
    except (TimeoutError, socket.timeout):
        return "unknown", f"No answer from {host}:{port} (firewall, VPN or host down?)"
    except OSError as e:
        return "unknown", f"{host}:{port} unreachable ({e.strerror or e})"


def check_domain(name: str) -> tuple[str, str]:
    try:
        r = httpx.get(f"https://{name}/", timeout=6, follow_redirects=True)
        if r.status_code >= 500:
            return "critical", f"HTTPS {r.status_code}"
        return "healthy", f"HTTPS {r.status_code}"
    except httpx.ConnectError as e:
        msg = str(e)
        if "Name or service not known" in msg or "nodename nor servname" in msg or "No address" in msg:
            return "critical", "DNS does not resolve"
        if isinstance(e.__cause__, ssl.SSLError) or "SSL" in msg or "certificate" in msg:
            return "warning", "TLS/certificate problem"
        return "unknown", "Connection failed"
    except httpx.TimeoutException:
        return "unknown", "Timed out"
    except httpx.HTTPError as e:
        return "unknown", type(e).__name__


def run_checks(db: Session, server_ids: list[int] | None = None, domain_ids: list[int] | None = None) -> dict:
    servers = list(db.scalars(select(Server)).unique())
    domains = list(db.scalars(select(Domain)))
    if server_ids is not None:
        servers = [s for s in servers if s.id in server_ids]
    if domain_ids is not None:
        domains = [d for d in domains if d.id in domain_ids]
    now = datetime.now(timezone.utc)
    with ThreadPoolExecutor(max_workers=16) as pool:
        s_res = list(pool.map(lambda s: check_tcp(_ip(s), s.ssh_port or 22), servers))
        d_res = list(pool.map(lambda d: check_domain(d.name), domains))
    for s, (st, detail) in zip(servers, s_res):
        s.health_status, s.health_detail, s.health_checked_at = st, detail[:255], now
    for d, (st, detail) in zip(domains, d_res):
        d.health_status, d.health_detail, d.health_checked_at = st, detail[:255], now
    return {"servers": len(servers), "domains": len(domains)}
