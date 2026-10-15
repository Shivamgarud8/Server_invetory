"""End-to-end API tests. Needs a disposable PostgreSQL in DATABASE_URL with migrations applied.

    alembic upgrade head && pytest -q
"""

import io

import pyotp
import pytest
from fastapi.testclient import TestClient
from openpyxl import Workbook
from sqlalchemy import text

from app.db import engine
from app.main import app

H = {"X-Requested-With": "TagIDPortal"}
ADMIN_PW = "Adm1n!Passw0rd#Test"
NEW_PW = "N3w!AdminPassw0rd#"


@pytest.fixture(scope="module", autouse=True)
def clean_db():
    with engine.begin() as c:
        c.execute(text(
            "TRUNCATE users, user_sessions, audit_logs, servers, credentials, applications, "
            "application_versions, version_history RESTART IDENTITY CASCADE"))
    yield


def client() -> TestClient:
    return TestClient(app, headers=H)


def login(c: TestClient, username: str, password: str, code: str | None = None):
    return c.post("/api/auth/login", json={"username": username, "password": password, "totp_code": code})


@pytest.fixture(scope="module")
def admin():
    with client() as c:  # runs lifespan → seed + bootstrap admin
        assert login(c, "admin", ADMIN_PW).status_code == 200
        me = c.get("/api/auth/me").json()
        assert me["must_change_password"] is True
        # Blocked until password is changed
        assert c.get("/api/servers").status_code == 403
        r = c.post("/api/auth/change-password", json={"current_password": ADMIN_PW, "new_password": NEW_PW})
        assert r.status_code == 200, r.text
        yield c


def ids(c, path):
    return {x["name"]: x["id"] for x in c.get(path).json()}


def test_csrf_header_required(admin):
    r = TestClient(app).post("/api/auth/login", json={"username": "x", "password": "y"})
    assert r.status_code == 403


def test_full_flow(admin):
    envs = ids(admin, "/api/environments")
    types = ids(admin, "/api/credential-types")
    tags = ids(admin, "/api/tags")

    # Servers
    r = admin.post("/api/servers", json={
        "name": "srv-p-03-db", "environment_id": envs["PROD"], "server_type": "Database Server",
        "os_name": "Ubuntu", "os_version": "24.04", "spec": {"cpu_cores": 4, "ram_gb": 16, "disk_gb": 300},
        "networks": [{"ip_type": "private", "ip_address": "10.80.0.13"}], "tag_ids": [tags["DATABASE"]],
        "purpose": "PostgreSQL / Redis / RabbitMQ / MinIO",
    })
    assert r.status_code == 201, r.text
    prod_srv = r.json()["id"]
    r = admin.post("/api/servers", json={"name": "srv-s-01-app", "environment_id": envs["STAGING"], "server_type": "App"})
    stg_srv = r.json()["id"]
    assert admin.get("/api/servers", params={"q": "10.80.0"}).json()[0]["name"] == "srv-p-03-db"

    # Credentials — password encrypted at rest
    r = admin.post("/api/credentials", json={
        "name": "srv-p-03-db Root", "credential_type_id": types["SSH"], "server_id": prod_srv,
        "environment_id": envs["PROD"], "host": "10.80.0.13", "port": 22, "username": "root",
        "password": "S3cr3t!RootPass",
    })
    assert r.status_code == 201, r.text
    cred = r.json()
    assert "password" not in cred and cred["has_secret"] is True
    with engine.connect() as c:
        blob = c.execute(text("SELECT secret_enc FROM credentials WHERE id=:i"), {"i": cred["id"]}).scalar()
    assert b"S3cr3t" not in bytes(blob)
    assert admin.post(f"/api/credentials/{cred['id']}/reveal", json={"purpose": "view"}).json()["password"] == "S3cr3t!RootPass"
    r = admin.post("/api/credentials", json={
        "name": "staging redis", "credential_type_id": types["Redis"], "environment_id": envs["STAGING"],
        "username": "default", "password": "R3dis!pass"})
    stg_cred = r.json()["id"]

    # Update without password keeps the secret
    body = {"name": "srv-p-03-db Root", "credential_type_id": types["SSH"], "server_id": prod_srv,
            "environment_id": envs["PROD"], "username": "root", "port": 22, "notes": "rotated quarterly"}
    assert admin.put(f"/api/credentials/{cred['id']}", json=body).status_code == 200
    assert admin.post(f"/api/credentials/{cred['id']}/reveal", json={"purpose": "copy"}).json()["password"] == "S3cr3t!RootPass"

    # Versions
    r = admin.post("/api/applications", json={"name": "TagID API"})
    app_id = r.json()["id"]
    r = admin.post("/api/deployments", json={"application_id": app_id, "component": "Admin API",
                                              "server_id": prod_srv, "environment_id": envs["PROD"], "current_version": "v3.33.3"})
    dep = r.json()["id"]
    admin.post("/api/deployments", json={"application_id": app_id, "component": "Admin API",
                                         "server_id": stg_srv, "environment_id": envs["STAGING"], "current_version": "v3.33.5"})
    r = admin.post(f"/api/deployments/{dep}/version", json={"new_version": "v3.33.4"})
    assert r.json()["previous_version"] == "v3.33.3"
    hist = admin.get("/api/version-history", params={"deployment_id": dep}).json()
    assert [h["new_version"] for h in hist] == ["v3.33.4", "v3.33.3"]
    matrix = admin.get("/api/version-matrix").json()
    row = matrix["rows"][0]
    assert row["latest"] == "v3.33.5" and row["drift"] is True
    assert admin.post(f"/api/deployments/{dep}/rollback").json()["current_version"] == "v3.33.3"

    # Developer restricted to STAGING, no password permission
    dev_role = ids(admin, "/api/roles")["Developer"]
    r = admin.post("/api/users", json={
        "username": "rahul", "password": "Rahul!Passw0rd#1", "must_change_password": False,
        "role_ids": [dev_role], "all_environments": False, "environment_ids": [envs["STAGING"]]})
    assert r.status_code == 201, r.text
    rahul_id = r.json()["id"]
    with client() as dev:
        assert login(dev, "rahul", "Rahul!Passw0rd#1").status_code == 200
        names = [s["name"] for s in dev.get("/api/servers").json()]
        assert names == ["srv-s-01-app"]
        assert [e["name"] for e in dev.get("/api/environments").json()] == ["STAGING"]
        assert dev.get(f"/api/servers/{prod_srv}").status_code == 404
        assert [c["id"] for c in dev.get("/api/credentials").json()] == [stg_cred]
        assert dev.post(f"/api/credentials/{stg_cred}/reveal", json={"purpose": "view"}).status_code == 403
        assert dev.post("/api/servers", json={"name": "x", "environment_id": envs["STAGING"], "server_type": "x"}).status_code == 403
        assert dev.get("/api/audit-logs").status_code == 403
        assert dev.get("/api/users").status_code == 403

        # Custom override: grant view_password to this one user
        u = admin.get(f"/api/users/{rahul_id}").json()
        r = admin.put(f"/api/users/{rahul_id}", json={
            "full_name": "Rahul", "is_active": True, "role_ids": u["role_ids"], "all_environments": False,
            "environment_ids": [envs["STAGING"]], "overrides": [{"code": "credentials.view_password", "granted": True}]})
        assert r.status_code == 200, r.text
        assert dev.post(f"/api/credentials/{stg_cred}/reveal", json={"purpose": "view"}).json()["password"] == "R3dis!pass"
        assert dev.post(f"/api/credentials/{cred['id']}/reveal", json={"purpose": "view"}).status_code == 404  # PROD

        # Disabling the user kills their session
        u = admin.get(f"/api/users/{rahul_id}").json()
        admin.put(f"/api/users/{rahul_id}", json={**{k: u[k] for k in ("full_name", "role_ids", "overrides", "all_environments", "environment_ids")}, "is_active": False})
        assert dev.get("/api/auth/me").status_code == 401

    # Audit trail contains password views, never the password
    logs = admin.get("/api/audit-logs", params={"page_size": 200}).json()["items"]
    actions = {l["action"] for l in logs}
    assert {"PASSWORD_VIEWED", "PASSWORD_COPIED", "CREDENTIAL_CREATED", "SERVER_CREATED", "VERSION_UPDATED",
            "USER_CREATED", "LOGIN"} <= actions
    assert "S3cr3t" not in str(logs) and "R3dis" not in str(logs)

    dash = admin.get("/api/dashboard").json()
    assert dash["cards"]["servers"] == 2 and dash["cards"]["credentials"] == 2

    # CSV export never includes passwords
    csv = admin.get("/api/credentials/export").text
    assert "srv-p-03-db Root" in csv and "S3cr3t" not in csv


def test_privilege_escalation_blocked(admin):
    roles = ids(admin, "/api/roles")
    envs = ids(admin, "/api/environments")
    admin.post("/api/users", json={"username": "ops", "password": "Ops!Passw0rd#123", "must_change_password": False,
                                   "role_ids": [roles["Admin"]]})
    with client() as ops:
        assert login(ops, "ops", "Ops!Passw0rd#123").status_code == 200
        r = ops.post("/api/users", json={"username": "evil", "password": "Evil!Passw0rd#1", "role_ids": [roles["Super Admin"]]})
        assert r.status_code == 403
        r = ops.post("/api/users", json={"username": "evil2", "password": "Evil!Passw0rd#1",
                                         "overrides": [{"code": "roles.manage", "granted": True}]})
        assert r.status_code == 403
        assert ops.post("/api/roles", json={"name": "x", "permissions": []}).status_code == 403
        admin_id = next(u["id"] for u in admin.get("/api/users").json() if u["username"] == "admin")
        assert ops.delete(f"/api/users/{admin_id}").status_code == 403
        # but a normal scoped user is fine
        r = ops.post("/api/users", json={"username": "viewer1", "password": "View!Passw0rd#1",
                                         "role_ids": [roles["Viewer"]], "all_environments": False,
                                         "environment_ids": [envs["UAT"]]})
        assert r.status_code == 201, r.text


def test_lockout_and_totp(admin):
    roles = ids(admin, "/api/roles")
    admin.post("/api/users", json={"username": "lock", "password": "Lock!Passw0rd#1", "must_change_password": False,
                                   "role_ids": [roles["Viewer"]]})
    with client() as c:
        for _ in range(5):
            assert login(c, "lock", "wrong").status_code == 401
        assert login(c, "lock", "Lock!Passw0rd#1").status_code == 423

    admin.post("/api/users", json={"username": "mfa", "password": "Mfa!Passw0rd#12", "must_change_password": False,
                                   "role_ids": [roles["Viewer"]]})
    with client() as c:
        login(c, "mfa", "Mfa!Passw0rd#12")
        secret = c.post("/api/auth/totp/setup").json()["secret"]
        assert c.post("/api/auth/totp/confirm", json={"code": pyotp.TOTP(secret).now()}).status_code == 200
        c.post("/api/auth/logout")
        assert login(c, "mfa", "Mfa!Passw0rd#12").json() == {"totp_required": True}
        assert c.get("/api/auth/me").status_code == 401
        assert login(c, "mfa", "Mfa!Passw0rd#12", "000000").status_code == 401
        assert login(c, "mfa", "Mfa!Passw0rd#12", pyotp.TOTP(secret).now()).status_code == 200


def _xlsx(rows):
    wb = Workbook()
    for r in rows:
        wb.active.append(r)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def test_excel_import(admin):
    servers = _xlsx([["Server Name", "Environment", "Private IP", "CPU", "RAM", "Disk", "Tags"],
                     ["srv-u-01-app", "UAT", "10.80.1.5", "4 Core", "16 GB", "200 GB", "METRO NEWTAG"],
                     ["srv-bad", "NOPE", "", "", "", "", ""]])
    files = {"file": ("servers.xlsx", servers)}
    r = admin.post("/api/import/servers", files=files, data={"dry_run": "false"}).json()
    assert r["dry_run"] is True and r["errors"][0]["row"] == 3  # all-or-nothing
    servers = _xlsx([["Server Name", "Environment", "Private IP", "CPU", "RAM", "Disk", "Tags"],
                     ["srv-u-01-app", "UAT", "10.80.1.5", "4 Core", "16 GB", "200 GB", "METRO NEWTAG"]])
    r = admin.post("/api/import/servers", files={"file": ("s.xlsx", servers)}, data={"dry_run": "false"}).json()
    assert r["counts"]["create"] == 1 and not r["errors"], r
    s = admin.get("/api/servers", params={"q": "srv-u-01"}).json()[0]
    assert s["spec"]["cpu_cores"] == 4 and float(s["spec"]["ram_gb"]) == 16

    creds = _xlsx([["Credential Name", "Type", "Server", "Environment", "Username", "Password"],
                   ["uat root", "SSH", "srv-u-01-app", "uat", "root", "Uat!R00tPass"]])
    r = admin.post("/api/import/credentials", files={"file": ("c.xlsx", creds)}, data={"dry_run": "false"}).json()
    assert r["counts"]["create"] == 1, r
    cid = admin.get("/api/credentials", params={"q": "uat root"}).json()[0]["id"]
    assert admin.post(f"/api/credentials/{cid}/reveal", json={"purpose": "view"}).json()["password"] == "Uat!R00tPass"

    vers = _xlsx([["Application", "Component", "Server", "Environment", "Version"],
                  ["TagID UI", "UI", "srv-u-01-app", "UAT", "v4.7.1"]])
    r = admin.post("/api/import/versions", files={"file": ("v.xlsx", vers)}, data={"dry_run": "false"}).json()
    assert r["counts"]["create"] == 1, r
