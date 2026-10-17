"""Clients, architecture, password history/rotation, backup & restore, email schedule."""

import json
import socket
import threading
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from app import reports
from app.db import engine
from app.health import check_tcp
from app.main import app

H = {"X-Requested-With": "TagIDPortal"}
ADMIN_PW = "Adm1n!Passw0rd#Test"
NEW_PW = "N3w!AdminPassw0rd#"


@pytest.fixture(scope="module")
def admin():
    with engine.begin() as c:
        c.execute(text(
            "TRUNCATE users, user_sessions, audit_logs, servers, credentials, applications, clients, domains, "
            "application_versions, version_history, config_backups, report_runs, app_settings RESTART IDENTITY CASCADE"))
    with TestClient(app, headers=H) as c:
        assert c.post("/api/auth/login", json={"username": "admin", "password": ADMIN_PW}).status_code == 200
        c.post("/api/auth/change-password", json={"current_password": ADMIN_PW, "new_password": NEW_PW})
        yield c


def ids(c, path):
    return {x["name"]: x["id"] for x in c.get(path).json()}


def test_client_template_architecture(admin):
    envs = ids(admin, "/api/environments")
    r = admin.post("/api/clients", json={"name": "Snitch", "architecture_type": "three_tier"})
    assert r.status_code == 201, r.text
    cid = r.json()["id"]
    body = {
        "template": "three_tier",
        "servers": [
            {"name": "snitch-proxy", "role": "proxy", "environment_id": envs["PROD"], "public_ip": "52.1.1.1",
             "private_ip": "10.10.0.10"},
            {"name": "snitch-app", "role": "application", "environment_id": envs["PROD"], "private_ip": "10.10.0.11",
             "vpn_ip": "100.64.0.11"},
            {"name": "snitch-db", "role": "database", "environment_id": envs["PROD"], "private_ip": "10.10.0.12"},
        ],
        "services": [
            {"server_index": 0, "application": "Nginx", "component": "Reverse proxy", "service_type": "proxy", "port": 443},
            {"server_index": 1, "application": "Snitch UI", "component": "UI", "service_type": "ui", "port": 3000},
            {"server_index": 1, "application": "Snitch API", "component": "API", "service_type": "api", "port": 8080},
            {"server_index": 1, "application": "Redis", "component": "Redis", "service_type": "cache", "port": 6379},
            {"server_index": 2, "application": "PostgreSQL", "component": "PostgreSQL", "service_type": "database", "port": 5432},
        ],
        "dependencies": [{"from_index": 0, "to_index": 1}, {"from_index": 0, "to_index": 2},
                         {"from_index": 2, "to_index": 3}, {"from_index": 2, "to_index": 4}],
    }
    r = admin.post(f"/api/clients/{cid}/apply-template", json=body)
    assert r.json() == {"servers": 3, "services": 5}, r.text
    assert admin.post(f"/api/clients/{cid}/apply-template", json=body).status_code == 409  # names exist

    srv = ids(admin, "/api/servers")
    r = admin.post("/api/domains", json={"name": "Shop.Snitch.com", "server_id": srv["snitch-proxy"]})
    assert r.status_code == 201, r.text
    assert r.json()["name"] == "shop.snitch.com" and r.json()["client"]["name"] == "Snitch"
    assert r.json()["target"] == "52.1.1.1"

    c = admin.get(f"/api/clients/{cid}").json()
    assert (c["server_count"], c["service_count"], c["domain_count"]) == (3, 5, 1)

    g = admin.get(f"/api/clients/{cid}/architecture").json()["generated"]
    node_ids = {n["id"] for n in g["nodes"]}
    assert {"internet", "dom:shop.snitch.com", "srv:snitch-proxy", "srv:snitch-app", "srv:snitch-db"} <= node_ids
    api_node = next(n for n in g["nodes"] if n["data"].get("label") == "API")
    assert api_node["parentId"] == "srv:snitch-app"
    ys = {n["id"]: n["position"]["y"] for n in g["nodes"] if not n.get("parentId")}
    assert ys["internet"] < ys["dom:shop.snitch.com"] < ys["srv:snitch-proxy"] < ys["srv:snitch-app"] < ys["srv:snitch-db"]
    kinds = {e["data"]["kind"] for e in g["edges"]}
    assert {"dns", "route", "dependency"} <= kinds
    assert not any(e["data"]["kind"] == "inferred" and e["source"] == "srv:snitch-app" for e in g["edges"])

    layout = {"nodes": [{"id": "srv:snitch-db", "position": {"x": 5, "y": 900}, "style": {"background": "#fee"}}],
              "edges": [], "viewport": {"x": 0, "y": 0, "zoom": 1}}
    assert admin.put(f"/api/clients/{cid}/architecture", json={"layout": layout}).status_code == 200
    assert admin.get(f"/api/clients/{cid}/architecture").json()["saved"]["nodes"][0]["position"]["y"] == 900


def test_password_history_and_rotation(admin):
    envs = ids(admin, "/api/environments")
    types = ids(admin, "/api/credential-types")
    srv = ids(admin, "/api/servers")
    r = admin.post("/api/credentials", json={
        "name": "snitch-db postgres", "credential_type_id": types["PostgreSQL"], "server_id": srv["snitch-db"],
        "environment_id": envs["PROD"], "username": "postgres", "password": "Pw-0!initial",
        "rotation_policy": "periodic", "rotation_interval_days": 90})
    assert r.status_code == 201, r.text
    cred = r.json()
    assert cred["client"]["name"] == "Snitch"  # inherited from the server
    assert cred["next_rotation_at"] == (datetime.now(timezone.utc).date() + timedelta(days=90)).isoformat()
    assert cred["pending_verification"] is False
    cid = cred["id"]

    for i in range(1, 8):
        r = admin.post(f"/api/credentials/{cid}/password", json={"password": f"Pw-{i}!rotated", "reason": f"rotation {i}"})
        assert r.status_code == 200, r.text
    assert r.json()["pending_verification"] is True and r.json()["history_count"] == 5
    assert admin.post(f"/api/credentials/{cid}/reveal", json={"purpose": "view"}).json()["password"] == "Pw-7!rotated"

    hist = admin.get(f"/api/credentials/{cid}/history").json()
    assert [h["reason"] for h in hist] == [f"rotation {i}" for i in (7, 6, 5, 4, 3)]  # oldest dropped, max 5
    assert "password" not in json.dumps(hist).lower().replace("pw-", "")

    url = f"/api/credentials/{cid}/history/{hist[0]['id']}/reveal"
    assert admin.post(url, json={"current_password": "wrong"}).status_code == 403
    assert admin.post(url, json={"current_password": NEW_PW}).json()["password"] == "Pw-6!rotated"
    assert admin.post(f"/api/credentials/{cid}/history/{hist[-1]['id']}/reveal",
                      json={"current_password": NEW_PW}).json()["password"] == "Pw-2!rotated"

    assert admin.post(f"/api/credentials/{cid}/verify").json()["pending_verification"] is False
    with engine.connect() as c:
        blobs = c.execute(text("SELECT secret_enc FROM credential_secret_history")).scalars().all()
    assert all(b"Pw-" not in bytes(b) for b in blobs)
    actions = {a["action"] for a in admin.get("/api/audit-logs", params={"page_size": 200}).json()["items"]}
    assert {"PASSWORD_HISTORY_VIEWED", "REAUTH_FAILED", "PASSWORD_ROTATION_VERIFIED"} <= actions


def test_backup_export_bundle_restore(admin):
    inv = admin.get("/api/backup/inventory")
    assert inv.status_code == 200
    doc = inv.json()
    assert doc["manifest"]["format"] == "tagid-inventory" and doc["manifest"]["includes_secrets"] is False
    raw = json.dumps(doc)
    assert "Pw-7!rotated" not in raw and "secrets" not in doc["data"]
    assert any(s["name"] == "snitch-app" for s in doc["data"]["servers"])

    # Tampered file is rejected
    bad = json.loads(raw)
    bad["data"]["servers"][0]["name"] = "evil"
    r = admin.post("/api/backup/import/preview", files={"file": ("x.json", json.dumps(bad))})
    assert r.status_code == 400 and "Checksum" in r.text

    # Preview against the same DB: nothing new
    plan = admin.post("/api/backup/import/preview", files={"file": ("x.json", raw)}).json()["plan"]
    assert plan["servers"]["new"] == 0 and plan["servers"]["unchanged"] == 3

    # Encrypted bundle: needs re-auth, includes secrets
    assert admin.post("/api/backup/bundle", json={"passphrase": "correct horse battery", "current_password": "x"}).status_code == 403
    b = admin.post("/api/backup/bundle", json={"passphrase": "correct horse battery", "current_password": NEW_PW})
    assert b.status_code == 200 and "Pw-7" not in b.text
    bundle = b.text

    # Simulate a lost server: wipe inventory, restore from the bundle
    with engine.begin() as c:
        c.execute(text("TRUNCATE servers, credentials, applications, clients, domains, application_versions, "
                       "service_dependencies, architecture_layouts RESTART IDENTITY CASCADE"))
    assert admin.get("/api/servers").json() == []
    r = admin.post("/api/backup/import/preview", files={"file": ("b.json", bundle)}, data={"passphrase": "nope-nope-nope"})
    assert r.status_code == 400
    r = admin.post("/api/backup/import/preview", files={"file": ("b.json", bundle)}, data={"passphrase": "correct horse battery"})
    assert r.json()["encrypted"] is True and r.json()["plan"]["servers"]["new"] == 3
    r = admin.post("/api/backup/import/apply", files={"file": ("b.json", bundle)},
                   data={"passphrase": "correct horse battery", "mode": "merge", "restore_secrets": "true",
                         "current_password": NEW_PW})
    assert r.status_code == 200, r.text
    assert r.json()["stats"]["servers_created"] == 3 and r.json()["stats"]["secrets_restored"] == 1

    srv = {s["name"]: s for s in admin.get("/api/servers").json()}
    assert srv["snitch-app"]["client"]["name"] == "Snitch"
    assert {n["ip_type"] for n in srv["snitch-app"]["networks"]} == {"private", "vpn"}
    cred = admin.get("/api/credentials", params={"q": "snitch-db postgres"}).json()[0]
    assert admin.post(f"/api/credentials/{cred['id']}/reveal", json={"purpose": "view"}).json()["password"] == "Pw-7!rotated"
    cid = ids(admin, "/api/clients")["Snitch"]
    arch = admin.get(f"/api/clients/{cid}/architecture").json()
    assert arch["saved"]["nodes"][0]["id"] == "srv:snitch-db"
    assert any(e["data"]["kind"] == "dependency" for e in arch["generated"]["edges"])
    assert len(admin.get("/api/backup/snapshots").json()) >= 1  # pre-import snapshot


def test_schedule_maths():
    cfg = {**reports.DEFAULT_EMAIL, "enabled": True, "frequency": "every_n_days", "interval_days": 15,
           "send_time": "10:00", "timezone": "Asia/Kolkata", "anchor_date": "2026-10-01"}
    now = datetime(2026, 10, 17, 3, 0, tzinfo=timezone.utc)  # 08:30 IST
    nr = reports.next_run(cfg, now)
    assert nr.isoformat() == "2026-10-31T10:00:00+05:30"
    on_time = datetime(2026, 10, 16, 4, 31, tzinfo=timezone.utc)  # 10:01 IST on day 15
    assert reports.due_slot(cfg, on_time).isoformat() == "2026-10-16T10:00:00+05:30"
    assert reports.due_slot({**cfg, "last_slot": "2026-10-16T10:00:00+05:30"}, on_time) is None  # never twice
    weekly = {**cfg, "frequency": "weekly", "weekday": 0}
    assert reports.next_run(weekly, now).isoformat() == "2026-10-19T10:00:00+05:30"
    assert reports.next_run({**cfg, "enabled": False}, now) is None


def test_health_check_tcp():
    srv = socket.socket()
    srv.bind(("127.0.0.1", 0))
    srv.listen()
    port = srv.getsockname()[1]
    assert check_tcp("127.0.0.1", port)[0] == "healthy"
    srv.close()
    assert check_tcp("127.0.0.1", port)[0] == "warning"  # refused = host up, port closed
    assert check_tcp(None, 22)[0] == "unknown"


class _MiniSMTP(threading.Thread):
    """Tiny SMTP sink so delivery can be tested end-to-end without a real mail server."""

    def __init__(self):
        super().__init__(daemon=True)
        self.sock = socket.socket()
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen()
        self.port = self.sock.getsockname()[1]
        self.messages: list[str] = []

    def run(self):
        while True:
            try:
                conn, _ = self.sock.accept()
            except OSError:
                return
            f = conn.makefile("rwb")

            def say(s):
                f.write((s + "\r\n").encode())
                f.flush()

            say("220 mini")
            data, buf = False, []
            for raw in f:
                line = raw.decode().rstrip("\r\n")
                if data:
                    if line == ".":
                        self.messages.append("\n".join(buf))
                        data, buf = False, []
                        say("250 queued")
                    else:
                        buf.append(line)
                    continue
                cmd = line[:4].upper()
                if cmd in ("EHLO", "HELO"):
                    say("250 mini")
                elif cmd == "DATA":
                    data = True
                    say("354 go")
                elif cmd == "QUIT":
                    say("221 bye")
                    break
                else:
                    say("250 ok")
            conn.close()


def test_email_settings_and_send(admin):
    smtp = _MiniSMTP()
    smtp.start()
    body = {"enabled": True, "smtp_host": "127.0.0.1", "smtp_port": smtp.port, "smtp_security": "none",
            "smtp_username": "", "smtp_password": "app-password-123", "from_address": "infra@example.com",
            "recipients": ["shivam@example.com"], "frequency": "every_n_days", "interval_days": 15,
            "send_time": "10:00", "timezone": "Asia/Kolkata"}
    r = admin.put("/api/reports/email", json=body)
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["smtp_password_set"] is True and "app-password" not in json.dumps(out)
    assert out["schedule_text"] == "every 15 days at 10:00 (Asia/Kolkata)" and out["next_run_at"]
    with engine.connect() as c:
        assert b"app-password" not in bytes(c.execute(text("SELECT secret_enc FROM app_settings WHERE key='email'")).scalar())

    assert admin.post("/api/reports/test").status_code == 200
    r = admin.post("/api/reports/send-now")
    assert r.status_code == 200, r.text
    assert len(smtp.messages) == 2
    report = smtp.messages[1]
    assert "Infrastructure report" in report and "tagid-inventory-" in report and "Pw-7!rotated" not in report
    runs = admin.get("/api/reports/runs").json()
    assert [x["status"] for x in runs[:2]] == ["sent", "sent"]

    # unreachable SMTP gives a readable error and a failed run
    admin.put("/api/reports/email", json={**body, "smtp_port": 1, "smtp_password": None})
    r = admin.post("/api/reports/test")
    assert r.status_code == 502 and "Error" in r.text
    smtp.sock.close()
