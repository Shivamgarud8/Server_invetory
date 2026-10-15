import io
import time
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone

import segno
from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..audit import audit
from ..config import get_settings
from ..db import get_db
from ..deps import SESSION_COOKIE, Principal, effective_permissions, get_principal
from ..models import User, UserSession
from ..netutil import client_ip
from ..schemas import ChangePasswordIn, EnvironmentOut, LoginIn, MeOut, TotpConfirmIn, TotpDisableIn
from ..security import (
    decrypt_totp_secret,
    encrypt_totp_secret,
    hash_password,
    hash_token,
    new_session_token,
    new_totp_secret,
    password_policy_errors,
    totp_uri,
    verify_password,
    verify_totp,
)

router = APIRouter(prefix="/api/auth", tags=["auth"])

_attempts: dict[str, deque] = defaultdict(deque)


def _rate_limit(ip: str) -> None:
    """Simple per-IP sliding window for the login endpoint (per backend process)."""
    window = _attempts[ip]
    now = time.monotonic()
    while window and now - window[0] > 60:
        window.popleft()
    if len(window) >= get_settings().login_rate_limit_per_minute:
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Too many login attempts, try again in a minute")
    window.append(now)


def me_out(p: Principal) -> MeOut:
    u = p.user
    s = get_settings()
    return MeOut(
        id=u.id,
        username=u.username,
        full_name=u.full_name,
        email=u.email,
        roles=[r.name for r in u.roles],
        permissions=sorted(p.permissions),
        all_environments=u.all_environments,
        environments=[EnvironmentOut.model_validate(e) for e in u.environments],
        totp_enabled=u.totp_enabled,
        must_change_password=u.must_change_password,
        session_idle_minutes=s.session_idle_minutes,
        vault_provider=s.vault_provider,
    )


@router.post("/login")
def login(body: LoginIn, request: Request, response: Response, db: Session = Depends(get_db)):
    s = get_settings()
    ip = client_ip(request)
    _rate_limit(ip)
    now = datetime.now(timezone.utc)
    user = db.scalar(select(User).where(User.username == body.username.strip()))

    def fail(reason: str):
        if user is not None:
            user.failed_attempts += 1
            if user.failed_attempts >= s.login_max_failed_attempts:
                user.locked_until = now + timedelta(minutes=s.login_lockout_minutes)
                user.failed_attempts = 0
                audit(db, request, "ACCOUNT_LOCKED", user, entity_type="user", entity_id=user.id,
                      entity_label=user.username)
        audit(db, request, "LOGIN_FAILED", user, username=body.username[:64], details={"reason": reason})
        db.commit()
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid username, password or code")

    password_ok = verify_password(body.password, user.password_hash if user else None)
    if user is None:
        fail("unknown user")
    if user.locked_until and user.locked_until > now:
        audit(db, request, "LOGIN_FAILED", user, details={"reason": "locked"})
        db.commit()
        raise HTTPException(status.HTTP_423_LOCKED, "Account temporarily locked after failed attempts")
    if not password_ok:
        fail("bad password")
    if not user.is_active:
        fail("disabled")

    if user.totp_enabled:
        if not body.totp_code:
            return {"totp_required": True}
        secret = decrypt_totp_secret(user.id, user.totp_secret_enc)
        if not verify_totp(secret, body.totp_code):
            fail("bad totp")

    token = new_session_token()
    db.add(
        UserSession(
            user_id=user.id,
            token_hash=hash_token(token),
            last_seen_at=now,
            expires_at=now + timedelta(hours=s.session_absolute_hours),
            ip_address=ip,
            user_agent=request.headers.get("user-agent", "")[:255],
        )
    )
    user.failed_attempts = 0
    user.locked_until = None
    user.last_login_at = now
    user.last_login_ip = ip
    audit(db, request, "LOGIN", user)
    db.commit()

    response.set_cookie(
        SESSION_COOKIE,
        token,
        httponly=True,
        secure=s.cookie_secure,
        samesite="strict",
        max_age=s.session_absolute_hours * 3600,
        path="/",
    )
    return {"ok": True}


@router.post("/logout")
def logout(request: Request, response: Response, db: Session = Depends(get_db)):
    token = request.cookies.get(SESSION_COOKIE)
    if token:
        sess = db.scalar(select(UserSession).where(UserSession.token_hash == hash_token(token)))
        if sess and not sess.revoked:
            sess.revoked = True
            audit(db, request, "LOGOUT", sess.user)
            db.commit()
    response.delete_cookie(SESSION_COOKIE, path="/")
    return {"ok": True}


@router.get("/me", response_model=MeOut)
def me(p: Principal = Depends(get_principal)):
    return me_out(p)


@router.post("/change-password")
def change_password(
    body: ChangePasswordIn, request: Request, p: Principal = Depends(get_principal), db: Session = Depends(get_db)
):
    user = p.user
    if not verify_password(body.current_password, user.password_hash):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Current password is incorrect")
    errors = password_policy_errors(body.new_password)
    if errors:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Password needs " + ", ".join(errors))
    if verify_password(body.new_password, user.password_hash):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "New password must differ from the current one")
    user.password_hash = hash_password(body.new_password)
    user.password_changed_at = datetime.now(timezone.utc)
    user.must_change_password = False
    # Sign out every other session
    for sess in db.scalars(select(UserSession).where(UserSession.user_id == user.id, UserSession.id != p.session.id)):
        sess.revoked = True
    audit(db, request, "PASSWORD_CHANGED", user, entity_type="user", entity_id=user.id, entity_label=user.username)
    db.commit()
    return {"ok": True}


@router.post("/totp/setup")
def totp_setup(p: Principal = Depends(get_principal), db: Session = Depends(get_db)):
    user = p.user
    if user.totp_enabled:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "2FA is already enabled")
    secret = new_totp_secret()
    user.totp_secret_enc = encrypt_totp_secret(user.id, secret)
    db.commit()
    uri = totp_uri(secret, user.username)
    buf = io.BytesIO()
    segno.make(uri, error="m").save(buf, kind="svg", scale=5, border=2, dark="#000", light="#fff")
    return {"secret": secret, "otpauth_uri": uri, "qr_svg": buf.getvalue().decode()}


@router.post("/totp/confirm")
def totp_confirm(
    body: TotpConfirmIn, request: Request, p: Principal = Depends(get_principal), db: Session = Depends(get_db)
):
    user = p.user
    if user.totp_enabled or not user.totp_secret_enc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Start 2FA setup first")
    if not verify_totp(decrypt_totp_secret(user.id, user.totp_secret_enc), body.code):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid code")
    user.totp_enabled = True
    audit(db, request, "MFA_ENABLED", user, entity_type="user", entity_id=user.id, entity_label=user.username)
    db.commit()
    return {"ok": True}


@router.post("/totp/disable")
def totp_disable(
    body: TotpDisableIn, request: Request, p: Principal = Depends(get_principal), db: Session = Depends(get_db)
):
    user = p.user
    if not user.totp_enabled:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "2FA is not enabled")
    if not verify_password(body.password, user.password_hash) or not verify_totp(
        decrypt_totp_secret(user.id, user.totp_secret_enc), body.code
    ):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid password or code")
    user.totp_enabled = False
    user.totp_secret_enc = None
    audit(db, request, "MFA_DISABLED", user, entity_type="user", entity_id=user.id, entity_label=user.username)
    db.commit()
    return {"ok": True}


__all__ = ["router", "me_out", "effective_permissions"]
