from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from fastapi import Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import get_settings
from .db import get_db
from .models import User, UserSession
from .permissions import SUPER_ADMIN
from .security import hash_token

SESSION_COOKIE = "tagid_session"


def effective_permissions(user: User) -> set[str]:
    perms = {p.code for r in user.roles for p in r.permissions}
    for o in user.overrides:
        if o.granted:
            perms.add(o.permission.code)
        else:
            perms.discard(o.permission.code)
    return perms


@dataclass
class Principal:
    user: User
    session: UserSession
    permissions: set[str]

    @property
    def is_super_admin(self) -> bool:
        return any(r.name == SUPER_ADMIN for r in self.user.roles)

    def can(self, code: str) -> bool:
        return code in self.permissions

    def env_ids(self) -> set[int] | None:
        """None = all environments; otherwise the set the user is restricted to."""
        if self.user.all_environments:
            return None
        return {e.id for e in self.user.environments}

    def can_env(self, environment_id: int | None) -> bool:
        ids = self.env_ids()
        return ids is None or environment_id in ids

    def require_env(self, environment_id: int | None) -> None:
        if not self.can_env(environment_id):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "You do not have access to this environment")


def _unauth(detail: str = "Not authenticated") -> HTTPException:
    return HTTPException(status.HTTP_401_UNAUTHORIZED, detail)


def get_principal(request: Request, db: Session = Depends(get_db)) -> Principal:
    token = request.cookies.get(SESSION_COOKIE)
    if not token:
        raise _unauth()
    sess = db.scalar(select(UserSession).where(UserSession.token_hash == hash_token(token)))
    now = datetime.now(timezone.utc)
    s = get_settings()
    if (
        sess is None
        or sess.revoked
        or sess.expires_at <= now
        or sess.last_seen_at + timedelta(minutes=s.session_idle_minutes) <= now
    ):
        raise _unauth("Session expired")
    user = sess.user
    if not user.is_active:
        raise _unauth("Account disabled")
    # Sliding idle timeout; avoid a write on every single request
    if (now - sess.last_seen_at).total_seconds() > 30:
        sess.last_seen_at = now
        db.commit()
    request.state.principal_username = user.username
    return Principal(user=user, session=sess, permissions=effective_permissions(user))


def require(*codes: str):
    """Dependency factory: user must hold every listed permission."""

    def dep(p: Principal = Depends(get_principal)) -> Principal:
        missing = [c for c in codes if not p.can(c)]
        if missing:
            raise HTTPException(status.HTTP_403_FORBIDDEN, f"Missing permission: {', '.join(missing)}")
        if p.user.must_change_password:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Password change required")
        return p

    return dep
