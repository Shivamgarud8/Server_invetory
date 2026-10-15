import ipaddress

from fastapi import Request

from .config import get_settings


def _in(ip: str, networks: list[str]) -> bool:
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    return any(addr in ipaddress.ip_network(n, strict=False) for n in networks)


def client_ip(request: Request) -> str:
    """Real client IP; X-Forwarded-For is honoured only when the direct peer is a trusted proxy."""
    peer = request.client.host if request.client else ""
    if _in(peer, get_settings().trusted_proxy_list):
        xff = request.headers.get("x-real-ip") or request.headers.get("x-forwarded-for", "").split(",")[0]
        if xff.strip():
            return xff.strip()
    return peer


def ip_allowed(ip: str) -> bool:
    networks = get_settings().trusted_network_list
    return not networks or _in(ip, networks)
