import logging
import secrets
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import delete, select, text

from .config import get_settings
from .db import SessionLocal
from .models import Role, User, UserSession
from .netutil import client_ip, ip_allowed
from .permissions import SUPER_ADMIN, seed
from .routers import audit_logs, auth, credentials, dashboard, importer, lookups, servers, users, versions
from .security import get_vault, hash_password, password_policy_errors

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("tagid")
settings = get_settings()


def bootstrap() -> None:
    get_vault()  # fail fast on bad vault configuration
    with SessionLocal() as db:
        # Serialise across uvicorn workers / replicas; released at commit
        db.execute(text("SELECT pg_advisory_xact_lock(7240011)"))
        seed(db)
        db.execute(delete(UserSession).where(UserSession.expires_at < datetime.now(timezone.utc)))
        db.commit()
        db.execute(text("SELECT pg_advisory_xact_lock(7240011)"))
        if not settings.bootstrap_admin_enabled or db.scalar(select(User.id).limit(1)) is not None:
            db.commit()
            return
        username = settings.bootstrap_admin_username or "admin"
        password = settings.bootstrap_admin_password
        generated = not password or password.startswith("REPLACE_")
        if generated:
            password = secrets.token_urlsafe(12) + "Aa1!"
        elif password_policy_errors(password):
            log.error("BOOTSTRAP_ADMIN_PASSWORD does not meet the password policy; no admin created")
            db.commit()
            return
        role = db.scalar(select(Role).where(Role.name == SUPER_ADMIN))
        db.add(User(username=username, email=settings.bootstrap_admin_email or None, full_name="Administrator",
                    password_hash=hash_password(password), roles=[role], must_change_password=True))
        db.commit()
        if generated:
            log.warning("=" * 64)
            log.warning("FIRST ADMIN CREATED  —  username: %s   password: %s", username, password)
            log.warning("You must change this password at first login.")
            log.warning("=" * 64)
        else:
            log.warning("First admin '%s' created with BOOTSTRAP_ADMIN_PASSWORD (must change at first login)", username)


@asynccontextmanager
async def lifespan(_: FastAPI):
    bootstrap()
    yield


is_prod = settings.app_env == "production"
app = FastAPI(
    title=settings.app_name,
    lifespan=lifespan,
    docs_url=None if is_prod else "/api/docs",
    redoc_url=None,
    openapi_url=None if is_prod else "/api/openapi.json",
)

if settings.origins:
    app.add_middleware(
        CORSMiddleware, allow_origins=settings.origins, allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "DELETE"], allow_headers=["Content-Type", "X-Requested-With"],
    )

_SAFE = {"GET", "HEAD", "OPTIONS"}


@app.middleware("http")
async def guard(request: Request, call_next):
    if not ip_allowed(client_ip(request)):
        return JSONResponse({"detail": "Access denied from this network"}, status_code=403)
    # CSRF: browsers cannot send this custom header cross-site without a CORS preflight we do not allow
    if request.method not in _SAFE and request.headers.get("x-requested-with") != "TagIDPortal":
        return JSONResponse({"detail": "Missing request header"}, status_code=403)
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-store"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    return response


@app.get("/api/config")
def public_config():
    """Non-sensitive settings the login page needs before authentication."""
    theme = settings.default_theme if settings.default_theme in ("light", "dark", "system") else "system"
    return {"app_name": settings.app_name, "server_label": settings.server_label, "default_theme": theme}


@app.get("/api/health")
def health():
    with SessionLocal() as db:
        db.execute(text("SELECT 1"))
    return {"status": "ok", "vault": get_vault().name, "vault_ok": get_vault().health()}


for r in (auth, users, lookups, servers, credentials, versions, dashboard, audit_logs, importer):
    app.include_router(r.router)
