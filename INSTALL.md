# Installation Guide — TagID Infra Manager

This guide covers a fresh install, connecting to your PostgreSQL server, day-to-day operations, and **moving the portal from one server to another** (for example from server 106 to a new machine).

---

## 1. What gets deployed

```
                    ┌───────────────────── Application server (e.g. srv-106) ─────────────────────┐
 Browser ──HTTPS──▶ │ tagid-portal-nginx :443 ──▶ tagid-portal-frontend (React, static)            │
                    │                          └─▶ tagid-portal-backend  (FastAPI :8080)           │
                    └──────────────────────────────────────│───────────────────────────────────────┘
                                                           ▼
                                   PostgreSQL (DB_HOST:DB_PORT, same box or a separate DB server)
```

| Container | Built from | Purpose |
|---|---|---|
| `tagid-portal-nginx` | `nginx:1.27-alpine` + `nginx/default.conf.template` | TLS, security headers, rate limits, routing |
| `tagid-portal-frontend` | `frontend/Dockerfile` (Node build → unprivileged nginx) | Web UI |
| `tagid-portal-backend` | `backend/Dockerfile` (Python 3.12 slim, non-root) | API. Runs database migrations automatically on start |
| `tagid-portal-postgres` | `postgres:18-alpine` (optional, `--profile bundled-db`) | Only if you don't use an existing PostgreSQL |

Everything the deployment needs comes from **one file: `.env`**.

---

## 2. Requirements

| | Minimum |
|---|---|
| OS | Ubuntu 22.04/24.04, or any Linux with Docker |
| Docker | Engine 24+ with the Compose v2 plugin (`docker compose version`) |
| Resources | 1 vCPU, 1 GB RAM, 2 GB disk (plus database storage) |
| PostgreSQL | 13 or newer (existing server, or the bundled container) |
| Network | Port 443 (and 80 for the redirect) reachable by users. The DB port must be reachable **from the app server only** |
| Tools | `git`, `openssl` |

---

## 3. Get the code

```bash
sudo mkdir -p /opt/tagid-infra-manager && sudo chown "$USER" /opt/tagid-infra-manager
git clone https://github.com/<your-github-user>/tagid-infra-manager.git /opt/tagid-infra-manager
cd /opt/tagid-infra-manager
```

---

## 4. Create `.env`

```bash
cp .env.example .env
chmod 600 .env
./scripts/generate-secrets.sh      # prints DB_PASSWORD, APP_SECRET_KEY, CREDENTIAL_ENCRYPTION_KEY, BOOTSTRAP_ADMIN_PASSWORD
nano .env                          # paste the values and fill in the sections below
```

### Variables reference

**Section 1 — This server** (where the containers run)

| Variable | Example | Meaning |
|---|---|---|
| `SERVER_LABEL` | `srv-106` | Shown in the top bar, the login page and the browser tab, so you always know which deployment you're on |
| `APP_SERVER_IP` | `10.80.0.106` | This machine's IP. For reference only |
| `PUBLIC_URL` | `https://10.80.0.106` or `https://infra.tagid.internal` | The address users type. Also used as the allowed browser origin |
| `HTTPS_BIND` | `10.80.0.106` | Interface nginx listens on. `0.0.0.0` means all interfaces. A private IP keeps the portal internal |
| `HTTPS_PORT` / `HTTP_PORT` | `443` / `80` | Published ports. HTTP only redirects to HTTPS |

**Section 2 — Database server**

| Variable | Example | Meaning |
|---|---|---|
| `DB_HOST` | `10.80.0.106` | PostgreSQL IP or hostname **as seen from the backend container**. See section 5 |
| `DB_PORT` | `5432` | PostgreSQL port |
| `DB_NAME` | `tagid_infra_manager` | Dedicated database for the portal |
| `DB_USER` | `infra_manager_app` | Application user. It owns only `DB_NAME` and is never a superuser |
| `DB_PASSWORD` | *(generated)* | Password for `DB_USER`. Special characters are fine |
| `DB_SSLMODE` | `prefer` | `disable`, `prefer`, `require` or `verify-full`. Use `require` when the DB is on another machine |
| `DB_ADMIN_USER` | `postgres` | PostgreSQL superuser ("root"). **Only** used by `scripts/setup-db.sh` |
| `DB_ADMIN_PASSWORD` | *(your postgres password)* | Superuser password. **Delete it from `.env` after setup** |
| `DATABASE_URL` | *(optional)* | A full connection URL. If set, it overrides the `DB_*` values |

**Section 3 — Application**

| Variable | Default | Meaning |
|---|---|---|
| `APP_NAME` | `TagID Infra Manager` | Shown in the footer and browser title |
| `APP_ENV` | `production` | `development` enables the API docs at `/api/docs` |
| `APP_PORT` / `APP_WORKERS` | `8080` / `2` | Backend's internal port and number of worker processes |
| `APP_VERSION` | `1.0.0` | Docker image tag |
| `TZ` | `Asia/Kolkata` | Time zone |
| `DEFAULT_THEME` | `system` | `light`, `dark` or `system`. Each user can override it in the top bar or under Profile |

**Section 4 — Security**

| Variable | Default | Meaning |
|---|---|---|
| `APP_SECRET_KEY` | *(generated)* | 32+ random characters. Encrypts users' 2FA secrets. **Keep it the same when moving servers** |
| `SESSION_IDLE_MINUTES` | `30` | Users are logged out after this long without activity |
| `SESSION_ABSOLUTE_HOURS` | `12` | Maximum session length, active or not |
| `LOGIN_MAX_FAILED_ATTEMPTS` / `LOGIN_LOCKOUT_MINUTES` | `5` / `15` | Account lockout after repeated failed logins |
| `COOKIE_SECURE` | `true` | Keep `true`. Only set `false` for plain-HTTP local development |
| `ALLOWED_ORIGINS` | *(empty)* | Extra browser origins to allow. Empty means `PUBLIC_URL` only |
| `TRUSTED_NETWORKS` | private ranges | Only these CIDRs can reach the portal, e.g. `10.80.0.0/16,10.8.0.0/24` (office + VPN). Empty means no restriction |
| `TRUSTED_PROXIES` | Docker ranges | The nginx container network. Leave the default |

**Section 5 — Credential vault**

| Variable | Meaning |
|---|---|
| `VAULT_PROVIDER` | `local`: passwords encrypted with AES-256-GCM and stored in PostgreSQL. `hashicorp`: passwords stored in HashiCorp Vault |
| `CREDENTIAL_ENCRYPTION_KEY` | Required for `local`. **If you lose this key, every stored password is lost.** Copy it with `.env` when moving, and keep an offline backup |
| `VAULT_ADDR`, `VAULT_TOKEN`, `VAULT_MOUNT`, `VAULT_PATH_PREFIX` | Required for `hashicorp` (KV v2) |

**Section 6 — Data & backups:** `DATA_DIR`, `BACKUP_DIR`, `BACKUP_RETENTION_DAYS`, `CREDENTIAL_EXPIRY_WARNING_DAYS`.

**Section 7 — First admin:** `BOOTSTRAP_ADMIN_ENABLED`, `BOOTSTRAP_ADMIN_USERNAME`, `BOOTSTRAP_ADMIN_PASSWORD`, `BOOTSTRAP_ADMIN_EMAIL`. The admin is only created when the users table is empty.

> `.env` values are read literally. Don't wrap them in quotes and don't use `$` in passwords (Docker Compose treats `$` as a variable). `generate-secrets.sh` only outputs safe characters.

---

## 5. Prepare the database

Choose the scenario that matches your setup.

### A. Existing PostgreSQL on the same server (for example the `tagid-postgres` container on 106)

The backend runs in its own Docker network, so `localhost` would point at the backend container itself. Use the **server's private IP** instead:

```ini
DB_HOST=10.80.0.106        # this server's private IP
DB_PORT=5432
DB_ADMIN_USER=postgres
DB_ADMIN_PASSWORD=<postgres superuser password>
```

### B. PostgreSQL on a separate database server

```ini
DB_HOST=10.80.0.13         # DB server IP
DB_PORT=5432
DB_SSLMODE=require
```

On the DB server, allow connections from the app server only:

```conf
# postgresql.conf
listen_addresses = '*'          # or the DB server's private IP

# pg_hba.conf  (replace with your app server's IP)
host  tagid_infra_manager  infra_manager_app  10.80.0.106/32  scram-sha-256
```

Then reload PostgreSQL and open the firewall for that IP only, e.g. `sudo ufw allow from 10.80.0.106 to any port 5432 proto tcp`.

### Create the database and user (A and B)

```bash
./scripts/setup-db.sh
```

The script connects as `DB_ADMIN_USER`, creates `DB_USER` and `DB_NAME` with least privileges, then tests logging in as `DB_USER`. It is safe to run again, and doing so also resets `DB_USER`'s password to `DB_PASSWORD`. It only needs Docker, not a local `psql`.

Once it prints `ok: connected…`, **remove `DB_ADMIN_PASSWORD` from `.env`**.

<details><summary>Manual alternative (psql)</summary>

```sql
CREATE ROLE infra_manager_app LOGIN PASSWORD '<DB_PASSWORD>' NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE DATABASE tagid_infra_manager OWNER infra_manager_app ENCODING 'UTF8' TEMPLATE template0;
REVOKE ALL ON DATABASE tagid_infra_manager FROM PUBLIC;
\c tagid_infra_manager
ALTER SCHEMA public OWNER TO infra_manager_app;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
```
</details>

### C. Bundled PostgreSQL container (no existing server)

```ini
DB_HOST=tagid-portal-postgres
DB_PORT=5432
```

Start everything with `--profile bundled-db` (see step 7). The container creates `DB_NAME` and `DB_USER` on its own, stores its data in `${DATA_DIR}/postgres`, and is never exposed outside Docker.

> **Security:** your current `tagid-postgres` publishes `0.0.0.0:5432`. Firewall that port so only the app server(s) can reach it.

---

## 6. TLS certificate

Put a certificate and its key at `nginx/certs/tls.crt` and `nginx/certs/tls.key`.

- **Internal CA or a real domain (recommended):** copy your certificate files there.
- **Self-signed (quick start):** `./scripts/gen-self-signed-cert.sh infra.tagid.internal`. Browsers will show a warning until users trust the certificate.

---

## 7. Start

```bash
docker compose up -d --build                         # existing PostgreSQL (A/B)
docker compose --profile bundled-db up -d --build    # bundled PostgreSQL (C)

docker compose ps
docker compose logs -f tagid-portal-backend          # look for "Application startup complete"
curl -k https://127.0.0.1/api/health                 # {"status":"ok",...}
```

Database migrations run on their own every time the backend starts.

### First login

1. Open `PUBLIC_URL` and sign in with `BOOTSTRAP_ADMIN_USERNAME` / `BOOTSTRAP_ADMIN_PASSWORD`.
2. Set a new password when prompted.
3. Go to **Profile → Set up 2FA**.
4. In `.env`, set `BOOTSTRAP_ADMIN_ENABLED=false` and delete the `BOOTSTRAP_ADMIN_PASSWORD` line. Then run `docker compose up -d`.
5. Go to **User Management → Add User** to create the team's logins. Pick roles, and optionally restrict each user to certain environments.
6. Go to **Excel Import** and import the sheets in this order: servers, then credentials, then versions.

### Post-install checklist

- [ ] `.env` has permissions `600` and is not in Git
- [ ] `DB_ADMIN_PASSWORD` and `BOOTSTRAP_ADMIN_PASSWORD` are removed from `.env`
- [ ] `CREDENTIAL_ENCRYPTION_KEY` and `APP_SECRET_KEY` are backed up offline, separately from the DB dumps
- [ ] PostgreSQL port firewalled so only the app server can reach it
- [ ] `TRUSTED_NETWORKS` limited to office and VPN ranges
- [ ] Backup cron installed (section 8)
- [ ] Every admin has 2FA enabled

---

## 8. Operations

| Task | Command |
|---|---|
| Status | `docker compose ps` |
| Logs | `docker compose logs -f tagid-portal-backend` |
| Restart | `docker compose restart` |
| Update to the latest code | `git pull && docker compose up -d --build` |
| Stop | `docker compose down` (data stays in PostgreSQL) |
| Migration status | `docker compose exec tagid-portal-backend alembic current` |
| Backup now | `./scripts/backup.sh` → `$BACKUP_DIR/tagid_infra_manager-<timestamp>.dump` |
| Restore | `docker compose stop tagid-portal-backend && ./scripts/restore.sh <file.dump> && docker compose up -d` |

Nightly backup (`crontab -e`):

```cron
15 2 * * * /opt/tagid-infra-manager/scripts/backup.sh >> /var/log/tagid-infra-backup.log 2>&1
```

Copy the backup directory off the server, e.g. with rsync or your `dbackup` tool.

---

## 9. Move to another server (e.g. 106 → new server)

The portal keeps no state of its own on the app server. Everything lives in PostgreSQL plus three secrets in `.env`.

**The three values you must carry over unchanged:**
- `CREDENTIAL_ENCRYPTION_KEY`, otherwise stored passwords can't be decrypted
- `APP_SECRET_KEY`, otherwise users' 2FA stops working
- `VAULT_*`, only if you use HashiCorp Vault

### Case 1 — Only the app moves, the database stays where it is

```bash
# on the NEW server
git clone https://github.com/<you>/tagid-infra-manager.git /opt/tagid-infra-manager && cd /opt/tagid-infra-manager
scp srv-106:/opt/tagid-infra-manager/.env .            # copy the config (contains secrets — use scp/ssh only)
scp -r srv-106:/opt/tagid-infra-manager/nginx/certs/* nginx/certs/
nano .env      # change: SERVER_LABEL, APP_SERVER_IP, PUBLIC_URL, HTTPS_BIND
               # DB_HOST stays the DB server's IP. If the DB was on 106 itself, DB_HOST stays 106's IP
# allow the new server's IP in the DB server's pg_hba.conf and firewall
docker compose up -d --build
# check everything works, then on 106: docker compose down
```

### Case 2 — Both the app and the database move

```bash
# 1. on 106: final backup (stop the backend first so nothing changes mid-dump)
docker compose stop tagid-portal-backend
./scripts/backup.sh

# 2. on the NEW server
git clone https://github.com/<you>/tagid-infra-manager.git /opt/tagid-infra-manager && cd /opt/tagid-infra-manager
scp srv-106:/opt/tagid-infra-manager/.env .
scp -r srv-106:/opt/tagid-infra-manager/nginx/certs/* nginx/certs/
scp srv-106:/tagid_data/infra-manager/backups/<latest>.dump /tmp/

nano .env      # change: SERVER_LABEL, APP_SERVER_IP, PUBLIC_URL, HTTPS_BIND,
               #         DB_HOST / DB_PORT (new DB server), DB_ADMIN_PASSWORD (new server's postgres password)
               # keep:   CREDENTIAL_ENCRYPTION_KEY, APP_SECRET_KEY, DB_NAME, DB_USER, DB_PASSWORD
               # set:    BOOTSTRAP_ADMIN_ENABLED=false  (users come from the backup)

./scripts/setup-db.sh                         # creates the empty DB and user on the new DB server
./scripts/restore.sh /tmp/<latest>.dump       # type the DB name to confirm
docker compose up -d --build

# 3. check: log in, open a credential, click Show — the password must decrypt.
#    Then point DNS / users at the new PUBLIC_URL and shut down 106: docker compose down
```

This exact procedure was tested end to end: backup, new DB server, `setup-db`, restore, start. All servers, users, version history and encrypted passwords came across intact.

---

## 10. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Backend restarts with `Set DB_PASSWORD (or DATABASE_URL)` | `DB_PASSWORD` is empty or still a `REPLACE_` value |
| `connection refused` / timeout to the DB | `DB_HOST` must be reachable **from inside Docker**. Don't use `localhost`; use the server's IP. Check PostgreSQL `listen_addresses`, `pg_hba.conf` and the firewall |
| `password authentication failed for user "infra_manager_app"` | Run `./scripts/setup-db.sh` again. It resets the password to `DB_PASSWORD` |
| `setup-db.sh`: `password authentication failed for user "postgres"` | Wrong `DB_ADMIN_PASSWORD` |
| `APP_SECRET_KEY must be…` | It must be at least 32 random characters |
| `CREDENTIAL_ENCRYPTION_KEY is required` / `must be 32 bytes` | Generate one with `openssl rand -base64 32` |
| "Unable to decrypt secret" after a move | `CREDENTIAL_ENCRYPTION_KEY` differs from the old server's. Copy the original key back |
| 2FA codes rejected after a move | `APP_SECRET_KEY` changed. Restore the old value, or have an admin use **Reset 2FA** on each user |
| `Access denied from this network` | Your IP isn't in `TRUSTED_NETWORKS` |
| Login works but you're immediately logged out | You're on plain HTTP with `COOKIE_SECURE=true`. Use HTTPS |
| nginx won't start | `nginx/certs/tls.crt` or `tls.key` is missing |
| Port 443 already in use | Change `HTTPS_PORT`/`HTTP_PORT`, or set `HTTPS_BIND` to a specific IP |

---

## 11. Push this repository to GitHub

`.gitignore` already excludes `.env`, certificates, backups, `node_modules` and build output. Check before pushing:

```bash
cd /opt/tagid-infra-manager          # or wherever the project is
git status --short                   # .env and nginx/certs/tls.* must NOT be listed
```

Create an **empty private** repository on GitHub named `tagid-infra-manager` (no README or .gitignore), then:

```bash
# HTTPS (you'll be asked for a Personal Access Token as the password)
git remote add origin https://github.com/<your-github-user>/tagid-infra-manager.git
# — or SSH, if your key is added to GitHub —
# git remote add origin git@github.com:<your-github-user>/tagid-infra-manager.git

git push -u origin main
```

Or use the GitHub CLI: `gh auth login`, then `gh repo create tagid-infra-manager --private --source . --push`.

Keep the repository **private**. It doesn't contain secrets, but it does describe your internal infrastructure layout.
