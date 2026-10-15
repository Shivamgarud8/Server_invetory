from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..audit import audit, diff
from ..db import get_db
from ..deps import Principal, effective_permissions, require
from ..models import Environment, Permission, Role, User, UserPermissionOverride, UserSession, user_roles
from ..permissions import SUPER_ADMIN
from ..schemas import (
    OverrideIn,
    PermissionOut,
    ResetPasswordIn,
    RoleIn,
    RoleOut,
    SessionOut,
    UserCreate,
    UserOut,
    UserUpdate,
)
from ..security import hash_password, password_policy_errors

router = APIRouter(prefix="/api", tags=["users"])


def role_out(r: Role, user_count: int = 0) -> RoleOut:
    return RoleOut(
        id=r.id, name=r.name, description=r.description, is_system=r.is_system,
        permissions=sorted(p.code for p in r.permissions), user_count=user_count,
    )


def user_out(u: User) -> UserOut:
    now = datetime.now(timezone.utc)
    return UserOut(
        id=u.id, username=u.username, email=u.email, full_name=u.full_name, is_active=u.is_active,
        must_change_password=u.must_change_password, totp_enabled=u.totp_enabled,
        locked=bool(u.locked_until and u.locked_until > now), last_login_at=u.last_login_at,
        last_login_ip=u.last_login_ip, created_at=u.created_at,
        roles=[role_out(r) for r in u.roles], role_ids=[r.id for r in u.roles],
        overrides=[OverrideIn(code=o.permission.code, granted=o.granted) for o in u.overrides],
        all_environments=u.all_environments, environment_ids=[e.id for e in u.environments],
        effective_permissions=sorted(effective_permissions(u)),
    )


def _is_super(u: User) -> bool:
    return any(r.name == SUPER_ADMIN for r in u.roles)


def _super_admin_count(db: Session) -> int:
    return db.scalar(
        select(func.count(func.distinct(User.id)))
        .join(user_roles, user_roles.c.user_id == User.id)
        .join(Role, Role.id == user_roles.c.role_id)
        .where(Role.name == SUPER_ADMIN, User.is_active.is_(True))
    ) or 0


def _check_password(pw: str) -> None:
    errors = password_policy_errors(pw)
    if errors:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Password needs " + ", ".join(errors))


def _apply_access(db: Session, p: Principal, user: User, role_ids, overrides, all_envs, env_ids) -> None:
    """Assign roles, overrides and environment scope — refusing anything the actor could not hold themselves."""
    roles = list(db.scalars(select(Role).where(Role.id.in_(role_ids)))) if role_ids else []
    if len(roles) != len(set(role_ids)):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Unknown role")
    perms = {pp.code: pp for pp in db.scalars(select(Permission))}
    for o in overrides:
        if o.code not in perms:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Unknown permission {o.code}")

    if not p.is_super_admin:
        granted = {pp.code for r in roles for pp in r.permissions} | {o.code for o in overrides if o.granted}
        beyond = granted - p.permissions
        if beyond or any(r.name == SUPER_ADMIN for r in roles):
            raise HTTPException(
                status.HTTP_403_FORBIDDEN, f"You cannot grant permissions you do not have: {', '.join(sorted(beyond)) or SUPER_ADMIN}"
            )
        own_envs = p.env_ids()
        if own_envs is not None and (all_envs or not set(env_ids) <= own_envs):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "You cannot grant access to environments you do not have")

    user.roles = roles
    user.overrides = [UserPermissionOverride(permission_id=perms[o.code].id, granted=o.granted) for o in overrides]
    user.all_environments = all_envs
    user.environments = list(db.scalars(select(Environment).where(Environment.id.in_(env_ids)))) if env_ids else []
    if not all_envs and not user.environments:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Select at least one environment or allow all")


def _guard_target(p: Principal, target: User) -> None:
    if _is_super(target) and not p.is_super_admin:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only a Super Admin can modify a Super Admin")


def _get_user(db: Session, user_id: int) -> User:
    u = db.get(User, user_id)
    if not u:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "User not found")
    return u


def _access_snapshot(u: User) -> dict:
    return {
        "email": u.email, "full_name": u.full_name, "is_active": u.is_active,
        "roles": sorted(r.name for r in u.roles),
        "overrides": sorted(f"{'+' if o.granted else '-'}{o.permission.code}" for o in u.overrides),
        "environments": "ALL" if u.all_environments else sorted(e.name for e in u.environments),
    }


# ---------------------------------------------------------------- users


@router.get("/users", response_model=list[UserOut])
def list_users(db: Session = Depends(get_db), _: Principal = Depends(require("users.view"))):
    return [user_out(u) for u in db.scalars(select(User).order_by(User.username))]


@router.get("/users/{user_id}", response_model=UserOut)
def get_user(user_id: int, db: Session = Depends(get_db), _: Principal = Depends(require("users.view"))):
    return user_out(_get_user(db, user_id))


@router.post("/users", response_model=UserOut, status_code=201)
def create_user(
    body: UserCreate, request: Request, db: Session = Depends(get_db), p: Principal = Depends(require("users.create"))
):
    _check_password(body.password)
    user = User(
        username=body.username.strip(), email=body.email, full_name=body.full_name.strip(),
        password_hash=hash_password(body.password), is_active=body.is_active,
        must_change_password=body.must_change_password,
    )
    db.add(user)
    _apply_access(db, p, user, body.role_ids, body.overrides, body.all_environments, body.environment_ids)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, "Username or email already exists")
    audit(db, request, "USER_CREATED", p.user, entity_type="user", entity_id=user.id, entity_label=user.username,
          details=_access_snapshot(user))
    db.commit()
    return user_out(user)


@router.put("/users/{user_id}", response_model=UserOut)
def update_user(
    user_id: int, body: UserUpdate, request: Request, db: Session = Depends(get_db),
    p: Principal = Depends(require("users.update")),
):
    user = _get_user(db, user_id)
    _guard_target(p, user)
    before = _access_snapshot(user)
    was_super = _is_super(user)
    user.email = body.email
    user.full_name = body.full_name.strip()
    user.is_active = body.is_active
    _apply_access(db, p, user, body.role_ids, body.overrides, body.all_environments, body.environment_ids)
    db.flush()
    if was_super and (not _is_super(user) or not user.is_active) and _super_admin_count(db) == 0:
        db.rollback()
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "At least one active Super Admin must remain")
    if user.id == p.user.id and not user.is_active:
        db.rollback()
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "You cannot disable your own account")
    if not user.is_active:
        for s in db.scalars(select(UserSession).where(UserSession.user_id == user.id)):
            s.revoked = True
    audit(db, request, "USER_UPDATED", p.user, entity_type="user", entity_id=user.id, entity_label=user.username,
          details=diff(before, _access_snapshot(user)))
    db.commit()
    return user_out(user)


@router.delete("/users/{user_id}", status_code=204)
def delete_user(user_id: int, request: Request, db: Session = Depends(get_db), p: Principal = Depends(require("users.delete"))):
    user = _get_user(db, user_id)
    _guard_target(p, user)
    if user.id == p.user.id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "You cannot delete your own account")
    if _is_super(user) and _super_admin_count(db) <= 1:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "At least one active Super Admin must remain")
    audit(db, request, "USER_DELETED", p.user, entity_type="user", entity_id=user.id, entity_label=user.username)
    db.delete(user)
    db.commit()


@router.post("/users/{user_id}/reset-password")
def reset_password(
    user_id: int, body: ResetPasswordIn, request: Request, db: Session = Depends(get_db),
    p: Principal = Depends(require("users.update")),
):
    user = _get_user(db, user_id)
    _guard_target(p, user)
    _check_password(body.new_password)
    user.password_hash = hash_password(body.new_password)
    user.must_change_password = body.must_change_password
    user.password_changed_at = datetime.now(timezone.utc)
    user.failed_attempts = 0
    user.locked_until = None
    for s in db.scalars(select(UserSession).where(UserSession.user_id == user.id)):
        s.revoked = True
    audit(db, request, "USER_PASSWORD_RESET", p.user, entity_type="user", entity_id=user.id, entity_label=user.username)
    db.commit()
    return {"ok": True}


@router.post("/users/{user_id}/unlock")
def unlock_user(user_id: int, request: Request, db: Session = Depends(get_db), p: Principal = Depends(require("users.update"))):
    user = _get_user(db, user_id)
    user.failed_attempts = 0
    user.locked_until = None
    audit(db, request, "USER_UNLOCKED", p.user, entity_type="user", entity_id=user.id, entity_label=user.username)
    db.commit()
    return {"ok": True}


@router.post("/users/{user_id}/reset-mfa")
def reset_mfa(user_id: int, request: Request, db: Session = Depends(get_db), p: Principal = Depends(require("users.update"))):
    user = _get_user(db, user_id)
    _guard_target(p, user)
    user.totp_enabled = False
    user.totp_secret_enc = None
    audit(db, request, "MFA_RESET", p.user, entity_type="user", entity_id=user.id, entity_label=user.username)
    db.commit()
    return {"ok": True}


# ---------------------------------------------------------------- sessions


@router.get("/sessions", response_model=list[SessionOut])
def list_sessions(db: Session = Depends(get_db), p: Principal = Depends(require("users.view"))):
    now = datetime.now(timezone.utc)
    rows = db.scalars(
        select(UserSession)
        .where(UserSession.revoked.is_(False), UserSession.expires_at > now)
        .order_by(UserSession.last_seen_at.desc())
    )
    return [
        SessionOut(
            id=s.id, user_id=s.user_id, username=s.user.username, created_at=s.created_at,
            last_seen_at=s.last_seen_at, expires_at=s.expires_at, ip_address=s.ip_address,
            user_agent=s.user_agent, current=s.id == p.session.id,
        )
        for s in rows
    ]


@router.delete("/sessions/{session_id}", status_code=204)
def revoke_session(session_id: int, request: Request, db: Session = Depends(get_db), p: Principal = Depends(require("users.update"))):
    s = db.get(UserSession, session_id)
    if not s:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Session not found")
    _guard_target(p, s.user)
    s.revoked = True
    audit(db, request, "SESSION_REVOKED", p.user, entity_type="user", entity_id=s.user_id, entity_label=s.user.username)
    db.commit()


# ---------------------------------------------------------------- roles & permissions


@router.get("/permissions", response_model=list[PermissionOut])
def list_permissions(db: Session = Depends(get_db), _: Principal = Depends(require("users.view"))):
    return list(db.scalars(select(Permission).order_by(Permission.id)))


@router.get("/roles", response_model=list[RoleOut])
def list_roles(db: Session = Depends(get_db), _: Principal = Depends(require("users.view"))):
    counts = dict(db.execute(select(user_roles.c.role_id, func.count()).group_by(user_roles.c.role_id)).all())
    return [role_out(r, counts.get(r.id, 0)) for r in db.scalars(select(Role).order_by(Role.id))]


def _role_perms(db: Session, p: Principal, codes: list[str]) -> list[Permission]:
    perms = list(db.scalars(select(Permission).where(Permission.code.in_(codes)))) if codes else []
    if len(perms) != len(set(codes)):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Unknown permission")
    beyond = set(codes) - p.permissions
    if beyond and not p.is_super_admin:
        raise HTTPException(status.HTTP_403_FORBIDDEN, f"You cannot grant permissions you do not have: {', '.join(sorted(beyond))}")
    return perms


@router.post("/roles", response_model=RoleOut, status_code=201)
def create_role(body: RoleIn, request: Request, db: Session = Depends(get_db), p: Principal = Depends(require("roles.manage"))):
    role = Role(name=body.name.strip(), description=body.description, permissions=_role_perms(db, p, body.permissions))
    db.add(role)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, "Role name already exists")
    audit(db, request, "ROLE_CREATED", p.user, entity_type="role", entity_id=role.id, entity_label=role.name,
          details={"permissions": sorted(body.permissions)})
    db.commit()
    return role_out(role)


@router.put("/roles/{role_id}", response_model=RoleOut)
def update_role(role_id: int, body: RoleIn, request: Request, db: Session = Depends(get_db), p: Principal = Depends(require("roles.manage"))):
    role = db.get(Role, role_id)
    if not role:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Role not found")
    if role.name == SUPER_ADMIN:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "The Super Admin role cannot be modified")
    before = sorted(pp.code for pp in role.permissions)
    if not role.is_system:
        role.name = body.name.strip()
    role.description = body.description
    role.permissions = _role_perms(db, p, body.permissions)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, "Role name already exists")
    audit(db, request, "ROLE_UPDATED", p.user, entity_type="role", entity_id=role.id, entity_label=role.name,
          details={"added": sorted(set(body.permissions) - set(before)), "removed": sorted(set(before) - set(body.permissions))})
    db.commit()
    return role_out(role)


@router.delete("/roles/{role_id}", status_code=204)
def delete_role(role_id: int, request: Request, db: Session = Depends(get_db), p: Principal = Depends(require("roles.manage"))):
    role = db.get(Role, role_id)
    if not role:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Role not found")
    if role.is_system:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Built-in roles cannot be deleted")
    audit(db, request, "ROLE_DELETED", p.user, entity_type="role", entity_id=role.id, entity_label=role.name)
    db.delete(role)
    db.commit()
