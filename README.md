# TagID Infra Manager

A private web portal that replaces the three infrastructure spreadsheets (`Password.xlsx`, `Server Inventory.xlsx`, `Version.xlsx`). It keeps credentials, servers and deployed versions in one place, with role-based access and a full audit trail.

```
Browser ──http──▶ :3006 tagid-portal-frontend (React UI, forwards /api) ──▶ :8090 tagid-portal-backend (FastAPI)
                                                                                 ├─▶ :5269 server-db (own PostgreSQL)
                                                                                 └─▶ HashiCorp Vault (or local AES-256-GCM)
```

## Modules

| Module | What it does |
|---|---|
| **Clients & Architecture** | One workspace per client (e.g. Snitch) with its servers, services, domains, credentials, runbook and disaster-recovery plan. An **interactive architecture diagram** is generated automatically from the inventory (Internet → domains → proxy → application servers with their services → databases). You can drag, resize, recolour and rename nodes, add boxes, notes and manual connections, switch between a Technical (dark) and a Professional (light) theme, save the layout per client, and export it as PNG or PDF. **Double-click** a server or service to see its IPs, SSH command, services and credentials (with Show/Copy, subject to permissions). A **template wizard** (single server / three-tier / shared database / custom) pre-fills servers and services for you to edit before anything is created. |
| **Domains & DNS** | Domains mapped to clients and servers, with record type, target, DNS/SSL provider, SSL expiry and HTTPS status. |
| **Monitoring** | Agent-free reachability checks run by the scheduler or on demand: TCP to each server's SSH port, HTTPS to each domain. A timeout counts as *unknown*, not as down. |
| **Backup & Recovery** | Inventory JSON download (no passwords) with manifest, format version and SHA-256 checksum. **Encrypted recovery bundle** with passwords (AES-256-GCM, scrypt passphrase, requires re-authentication). Daily automatic snapshots. **Restore** with validation, a preview of new / changed / unchanged records, a pre-import snapshot, and optional secret restore. Nothing is ever executed on real servers. |
| **Email & Reports** | SMTP settings (Gmail, Microsoft 365, Zoho, SES presets; app password stored encrypted). Schedules: every N days (e.g. **every 15 days at 10:00 IST**), weekly or daily. The report covers inventory, open issues, upcoming rotations and the last backup, with the inventory JSON attached (and optionally the encrypted bundle). Test email, send now, and delivery history. Sent by a background scheduler even when nobody is logged in. |
| **Dashboard** | Server counts per environment, credentials expiring or expired, passwords older than 90 days, recent version updates, failed logins, password views, and users without 2FA. Each card only appears when the user has permission for it. |
| **Password Management** | Credentials linked to servers. Passwords are encrypted and never included in list or detail responses. **Show** and **Copy** each make a separate, audited request. Revealed passwords hide again after 20 s, and the clipboard is cleared after 30 s. The detail view builds a ready-to-copy `ssh` command. CSV export never contains passwords. |
| **Password rotation & history** | Click the 🔑 on any credential to generate a password (keyword suggestions such as `tagid cloud` always include at least 12 random characters) and assign it with a reason. The previous password moves to an **encrypted 5-version history**: a timeline shows when, by whom and why each change happened, and revealing an old version needs re-authentication. Each credential is either *static* or *periodic* (with an interval and next-rotation date), and overdue or upcoming rotations show on the dashboard and in reports. A change is marked **awaiting verification** until someone confirms it was also changed on the real system (✅). |
| **Server Inventory** | Servers with multiple IPs (private, public, network, management), CPU, RAM and disk (with a usage bar), OS and kernel, Docker and Compose versions, tags, owner and purpose. Each server has a detail page showing its credentials, its deployed apps and its change history. **Paste server facts**: you run a read-only one-liner on the server and paste its output to fill in the form. |
| **Version Management** | Records what version runs on which server and in which environment. Includes one-click **Update version**, **Rollback** to the previous version, the full version history, and an **environment comparison matrix** that highlights drift (for example PROD running an older version than STAGING). |
| **User Management** | Several logins, each with one or more roles. Per-user **allow/deny overrides** for single permissions. **Environment restriction**: a user limited to STAGING + UAT cannot see PROD servers, credentials or deployments at all. Also: reset passwords, unlock accounts, reset 2FA, and view or revoke active sessions. |
| **Roles & Permissions** | Built-in roles plus custom roles, edited through a permission grid. |
| **Password Generator** | Runs in the browser using the Web Crypto CSPRNG. Options: length, character sets, excluded characters, avoid look-alike characters, and keyword (memorable) mode. Includes a strength meter and **Use password** to fill a credential form. Open it from the top-bar button, with Ctrl+Shift+G, or by **triple-clicking 🔑**. Generated passwords are never sent to the server. |
| **Audit Logs** | Records logins and failed logins, account lockouts, every create/update/delete (with field-level diffs), and every `PASSWORD_VIEWED` and `PASSWORD_COPIED`, along with IP and user agent. Filterable and exportable to CSV. |
| **Excel Import** | Imports the three existing sheets. Column headers are matched flexibly, every import can be dry-run first, and the real import is all-or-nothing. Templates can be downloaded. |
| **Settings** | Environments (with colours), tags (ABFRL, METRO, CC, GC, SNITCH, STYLE-UNION…) and credential types (with default ports). |
| **Profile** | Change your own password, enroll in TOTP 2FA (QR code), and pick a theme. Shows exactly which permissions you have. |
| **Themes** | Light, Dark or System (follows the OS). The switcher is in the top bar and on the login page. The default for new users comes from `DEFAULT_THEME`. |

## Permissions

"View Password" is a **separate permission** from "View". A user can browse credentials without ever being able to reveal one.

| Permission | Super Admin | Admin | DevOps | Developer | Auditor | Viewer |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| Dashboard | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Credentials: view | ✓ | ✓ | ✓ | ✓ | ✓ | |
| Credentials: **view password** | ✓ | ✓ | ✓ | | | |
| Credentials: add / edit | ✓ | ✓ | ✓ | | | |
| Credentials: delete / export | ✓ | ✓ | | | | |
| Servers: view | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Servers: add / edit / delete | ✓ | ✓ | ✓ | | | |
| Versions: view | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Versions: add / edit / delete | ✓ | ✓ | ✓ | | | |
| Users: view | ✓ | ✓ | | | ✓ | |
| Users: add / edit / delete | ✓ | ✓ | | | | |
| Roles: manage | ✓ | | | | | |
| Audit logs | ✓ | ✓ | | | ✓ | |
| Settings / Import | ✓ | ✓ | DevOps: import | | | |

Rules that are always enforced:

- Nobody can grant a role or permission they do not hold themselves.
- Only a Super Admin can modify another Super Admin.
- The last active Super Admin cannot be removed.
- Disabling a user ends all of their sessions immediately.

## Deploy

**Full step-by-step guide: [INSTALL.md](INSTALL.md)**. It covers every `.env` variable, the built-in `server-db` database or an existing PostgreSQL, ports, backups, troubleshooting, and how to move the portal to another server.

Quick version:

```bash
./scripts/init-env.sh                    # writes a complete .env: all passwords/keys generated, this server's IP filled in
docker compose up -d --build             # starts server-db (:5269), API (:8090), UI (:3006)
                                         # open http://<server-ip>:3006 and log in as admin with the printed password
```

Everything that differs between servers lives in `.env`: this server's label, URL, bind IP and ports, plus the DB host, port, name, user, password and superuser password. Moving from one server to another is a matter of copying `.env`, editing a few lines, and restoring a backup (`scripts/backup.sh` / `scripts/restore.sh`).

### Credential storage (`VAULT_PROVIDER`)

| | `hashicorp` (recommended) | `local` |
|---|---|---|
| Where passwords live | Vault KV v2 at `secret/tagid-infra-manager/credentials/<id>` (versioned by Vault) | AES-256-GCM ciphertext in PostgreSQL, bound to the credential ID |
| Key | Vault token in `.env` (scope it with a policy limited to that path) | `CREDENTIAL_ENCRYPTION_KEY` in `.env` (generated by `init-env.sh`) |
| What PostgreSQL holds | Nothing secret | Ciphertext only, useless without the key |

Minimal Vault policy:

```hcl
path "secret/data/tagid-infra-manager/*"     { capabilities = ["create", "update", "read"] }
path "secret/metadata/tagid-infra-manager/*" { capabilities = ["delete"] }
```

**With `local`: if you lose `CREDENTIAL_ENCRYPTION_KEY`, you lose every stored password.** Back it up separately from the database dumps (sealed envelope or offline password manager), and never store the two together.

## Security controls

- Argon2id password hashing and a password policy (12+ characters, mixed character classes).
- Login lockout after 5 failures (15 min), per-IP login rate limits, and constant-time handling of unknown usernames.
- Optional TOTP 2FA, with the secret encrypted at rest.
- Server-side sessions stored hashed in the DB, sent as an `HttpOnly; SameSite=Strict` cookie (`Secure` too when served over HTTPS). 30 min idle timeout (enforced on both server and client) and a 12 h absolute limit. Sessions can be revoked.
- CSRF protection via a required custom header. Strict CSP, `X-Frame-Options: DENY`, `no-store` on API responses.
- Optional `TRUSTED_NETWORKS` CIDR allow-list. API docs are disabled in production.
- Passwords never appear in logs, audit entries, exports, list responses, or browser storage.
- Containers are read-only, run as non-root, with `cap_drop: ALL` and `no-new-privileges`. The DB network is `internal`.

**Your existing `tagid-postgres` currently publishes `0.0.0.0:5432`.** Bind it to `127.0.0.1` or a private IP, or firewall it, so PostgreSQL is not reachable from outside.

## Migrating the Excel sheets

1. Go to **Excel Import → Server Inventory**, upload the file, click **Validate**, fix any errors it reports, then click **Import**.
2. Do the same for **Password Management**. Credentials link to servers by name, and passwords are encrypted on import.
3. Do the same for **Version Management**. Applications are created automatically and each row is recorded in the version history.
4. Spot-check the imported data, then **securely delete `Password.xlsx`** from shared drives and laptops. Keep the other two files as read-only reference copies.

Environment names are mapped automatically: `Production`/`PRD` become PROD, `Stage`/`STG` become STAGING, and `QA` becomes TEST. Numbers such as "4 Core" or "16 GB" are parsed into numeric values. Any column the importer does not recognise is listed in the result rather than silently dropped.

## Operations

```bash
./scripts/backup.sh                                       # pg_dump (custom format) to ./backups, 30-day retention
docker compose pull && docker compose up -d --build      # upgrade (migrations run automatically)
docker compose exec tagid-portal-backend alembic current # migration state
```

## Development

```bash
# Backend: needs a disposable PostgreSQL
cd backend && python -m venv .venv && . .venv/bin/activate && pip install -r requirements.txt pytest
export DB_HOST=127.0.0.1 DB_PORT=55432 DB_USER=postgres DB_PASSWORD=pw DB_NAME=tagid_dev APP_SECRET_KEY=$(openssl rand -hex 32) \
       VAULT_PROVIDER=local CREDENTIAL_ENCRYPTION_KEY=$(openssl rand -base64 32) APP_ENV=development COOKIE_SECURE=false
alembic upgrade head && pytest -q          # end-to-end tests: RBAC, env scoping, encryption, audit, lockout, 2FA, import
uvicorn app.main:app --port 8080 --reload  # API docs at /api/docs in development

# Frontend
cd frontend && npm install && npm run dev  # http://localhost:5173, proxies /api to :8080
```

Schema changes: edit `app/models.py`, then run `alembic revision --autogenerate -m "..."` and review the generated file.

## Roadmap (the design leaves room for these)

**Phase 3:** automatic server and Docker version discovery (a push agent that reuses the server-facts collector), Prometheus/Grafana/Uptime Kuma links per server, password-expiry and stale-password alerts by email or Telegram, API tokens for CI to record deployments automatically (`POST /api/deployments/{id}/version`), SSO (OIDC), secret rotation workflows, and backup verification.

---

Designed & developed by [Shivam Garud](https://shivam-garud.vercel.app/).
