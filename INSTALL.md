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
git clone https://github.com/Shivamgarud8/Server_invetory.git /opt/tagid-infra-manager
cd /opt/tagid-infra-manager
```

---

## 4. Create `.env`

`.env` only contains **where things are**: this server, and the database server.

```bash
cp .env.example .env
chmod 600 .env
./scripts/generate-secrets.sh      # prints a strong DB_PASSWORD
nano .env
```

| Variable | Example | Meaning |
|---|---|---|
| `SERVER_LABEL` | `srv-106` | Shown in the top bar, login page and browser tab, so you know which deployment you're on |
| `PUBLIC_URL` | `https://10.80.0.106` | The address users open (no trailing slash) |
| `HTTPS_BIND` | `10.80.0.106` | Interface nginx listens on. `0.0.0.0` means all interfaces; a private IP keeps the portal internal |
| `HTTPS_PORT` / `HTTP_PORT` | `443` / `80` | Published ports. HTTP only redirects to HTTPS |
| `DB_HOST` | `10.80.0.106` | PostgreSQL IP or hostname **as seen from the backend container** (see section 5) |
| `DB_PORT` | `5432` | PostgreSQL port |
| `DB_NAME` | `tagid_infra_manager` | Dedicated database for the portal |
| `DB_USER` | `infra_manager_app` | Application user. It owns only `DB_NAME` and is never a superuser |
| `DB_PASSWORD` | *(generated)* | Password for `DB_USER` |
| `DB_ADMIN_USER` / `DB_ADMIN_PASSWORD` | `postgres` / … | PostgreSQL superuser ("root"). **Only** used once by `scripts/setup-db.sh`. Delete the password afterwards |
| `APP_NAME` | `TagID Infra Manager` | Shown in the footer and browser title |
| `TZ` | `Asia/Kolkata` | Time zone |
| `DEFAULT_THEME` | `system` | `light`, `dark` or `system`. Each user can change it in the top bar |

### What is automatic (nothing to configure)

| | How it works |
|---|---|
| **Security keys** | `APP_SECRET_KEY` (protects 2FA secrets) and `CREDENTIAL_ENCRYPTION_KEY` (encrypts stored passwords) are generated on first start. They are saved in the Docker volume `portal-secrets`, never in the database. **Back them up** with `./scripts/show-secrets.sh` (see section 8) |
| **First admin** | When there are no users, the user `admin` is created with a random password, printed once in the backend log. You must change it at first login |
| **Backups** | `./scripts/backup.sh` writes to `./backups/`, which is git-ignored |
| **Security defaults** | 30 min idle logout, 12 h maximum session, lockout after 5 failed logins for 15 min, secure cookies, `PUBLIC_URL` as the only allowed origin |

### Optional overrides (not in `.env.example`)

Add a line to `.env` only if you need to change one of these defaults.

| Variable | Default | Meaning |
|---|---|---|
| `DB_SSLMODE` | `prefer` | `disable`, `prefer`, `require` or `verify-full`. Use `require` when the DB is on another machine |
| `DATABASE_URL` | — | A full connection URL. If set, it replaces all the `DB_*` values |
| `TRUSTED_NETWORKS` | *(no restriction)* | Only these CIDRs may use the portal, e.g. `10.80.0.0/16,10.8.0.0/24` |
| `SESSION_IDLE_MINUTES` / `SESSION_ABSOLUTE_HOURS` | `30` / `12` | Idle logout / maximum session length |
| `LOGIN_MAX_FAILED_ATTEMPTS` / `LOGIN_LOCKOUT_MINUTES` | `5` / `15` | Account lockout after repeated failed logins |
| `ALLOWED_ORIGINS` | `PUBLIC_URL` | Extra browser origins to allow (comma-separated) |
| `BACKUP_DIR` / `BACKUP_RETENTION_DAYS` | `./backups` / `30` | Where `backup.sh` writes dumps, and how long they are kept |
| `DATA_DIR` | `/tagid_data/infra-manager` | Data folder for the bundled PostgreSQL container |
| `CREDENTIAL_EXPIRY_WARNING_DAYS` | `30` | How far ahead the dashboard flags expiring credentials |
| `BOOTSTRAP_ADMIN_USERNAME` / `BOOTSTRAP_ADMIN_PASSWORD` | `admin` / *(random)* | Pick the first admin's name and password yourself |
| `APP_SECRET_KEY` / `CREDENTIAL_ENCRYPTION_KEY` | *(auto-generated)* | Set these only when moving servers (section 9). A value in `.env` always wins over the generated one |
| `VAULT_PROVIDER`, `VAULT_ADDR`, `VAULT_TOKEN` | `local` | Use `hashicorp` to keep passwords in HashiCorp Vault instead of encrypted in PostgreSQL |
| `VAULT_MOUNT`, `VAULT_PATH_PREFIX`, `VAULT_NAMESPACE`, `VAULT_CA_CERT` | `secret`, `tagid-infra-manager` | Advanced Vault settings |
| `APP_WORKERS` / `APP_VERSION` / `APP_ENV` | `2` / `1.0.0` / `production` | Worker processes / image tag / `development` turns on the API docs at `/api/docs` |

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
DB_SSLMODE=require         # optional, recommended for a remote DB
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

1. Get the generated admin password:
   ```bash
   docker compose logs tagid-portal-backend | grep "FIRST ADMIN"
   # FIRST ADMIN CREATED  —  username: admin   password: xxxxxxxxxxxxxxxx
   ```
2. Open `PUBLIC_URL`, sign in as `admin`, and set a new password when prompted.
3. Go to **Profile → Set up 2FA**.
4. **Back up the security keys** (one time): `./scripts/show-secrets.sh`. Store the output in a password manager, not next to the DB backups.
5. Remove `DB_ADMIN_PASSWORD` from `.env`.
6. Go to **User Management → Add User** to create the team's logins. Pick roles, and optionally restrict each user to certain environments.
7. Go to **Excel Import** and import the sheets in this order: servers, then credentials, then versions.

### Post-install checklist

- [ ] `.env` has permissions `600` and is not in Git
- [ ] `DB_ADMIN_PASSWORD` removed from `.env`
- [ ] Output of `./scripts/show-secrets.sh` saved in a password manager
- [ ] PostgreSQL port firewalled so only the app server can reach it
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
| Backup now | `./scripts/backup.sh` → `./backups/tagid_infra_manager-<timestamp>.dump` |
| Show security keys | `./scripts/show-secrets.sh` (back these up once) |
| Restore | `docker compose stop tagid-portal-backend && ./scripts/restore.sh <file.dump> && docker compose up -d` |

Nightly backup (`crontab -e`):

```cron
15 2 * * * /opt/tagid-infra-manager/scripts/backup.sh >> /var/log/tagid-infra-backup.log 2>&1
```

Copy the backup directory off the server, e.g. with rsync or your `dbackup` tool.

---

## 9. Move to another server (e.g. 106 → new server)

Everything lives in PostgreSQL, plus the two auto-generated security keys. On the new server you put those keys into `.env`. A value in `.env` always wins, so nothing new gets generated.

### Case 1 — Only the app moves, the database stays where it is

```bash
# on 106: print the keys
./scripts/show-secrets.sh            # APP_SECRET_KEY=…  CREDENTIAL_ENCRYPTION_KEY=…

# on the NEW server
git clone https://github.com/Shivamgarud8/Server_invetory.git /opt/tagid-infra-manager && cd /opt/tagid-infra-manager
scp srv-106:/opt/tagid-infra-manager/.env .
scp srv-106:/opt/tagid-infra-manager/nginx/certs/tls.* nginx/certs/
nano .env      # change SERVER_LABEL, PUBLIC_URL, HTTPS_BIND
               # paste the two lines from show-secrets.sh at the end
# allow the new server's IP in the DB server's pg_hba.conf and firewall
docker compose up -d --build
# check everything works, then on 106: docker compose down
```

### Case 2 — Both the app and the database move

```bash
# 1. on 106
./scripts/show-secrets.sh                   # copy the two lines
docker compose stop tagid-portal-backend    # stop changes during the dump
./scripts/backup.sh                         # → backups/<file>.dump

# 2. on the NEW server
git clone https://github.com/Shivamgarud8/Server_invetory.git /opt/tagid-infra-manager && cd /opt/tagid-infra-manager
scp srv-106:/opt/tagid-infra-manager/.env .
scp srv-106:/opt/tagid-infra-manager/nginx/certs/tls.* nginx/certs/
scp srv-106:/opt/tagid-infra-manager/backups/<file>.dump /tmp/

nano .env      # change: SERVER_LABEL, PUBLIC_URL, HTTPS_BIND, DB_HOST, DB_PORT,
               #         DB_ADMIN_PASSWORD (the new server's postgres password)
               # keep:   DB_NAME, DB_USER, DB_PASSWORD
               # add:    the two lines from show-secrets.sh

./scripts/setup-db.sh                       # creates the empty DB and user on the new DB server
./scripts/restore.sh /tmp/<file>.dump       # type the DB name to confirm
docker compose up -d --build

# 3. check: log in, open a credential, click Show — the password must decrypt.
#    Then point users at the new PUBLIC_URL and on 106: docker compose down
```

This procedure was tested end to end, including deleting the key volume and restoring the keys from `.env`. Every stored password decrypted correctly afterwards.

---

## 10. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Backend restarts with `Set DB_PASSWORD (or DATABASE_URL)` | `DB_PASSWORD` is empty or still a `REPLACE_` value |
| `connection refused` / timeout to the DB | `DB_HOST` must be reachable **from inside Docker**. Don't use `localhost`; use the server's IP. Check PostgreSQL `listen_addresses`, `pg_hba.conf` and the firewall |
| `password authentication failed for user "infra_manager_app"` | Run `./scripts/setup-db.sh` again. It resets the password to `DB_PASSWORD` |
| `setup-db.sh`: `password authentication failed for user "postgres"` | Wrong `DB_ADMIN_PASSWORD` |
| Lost the first admin password | `docker compose logs tagid-portal-backend \| grep "FIRST ADMIN"` |
| "Unable to decrypt secret" after a move | The keys from the old server weren't carried over. Put the old `CREDENTIAL_ENCRYPTION_KEY` (from `show-secrets.sh`) in `.env` |
| 2FA codes rejected after a move | `APP_SECRET_KEY` wasn't carried over. Restore it in `.env`, or have an admin use **Reset 2FA** on each user |
| `Access denied from this network` | You set `TRUSTED_NETWORKS` and your IP isn't in it |
| Login works but you're immediately logged out | You're on plain HTTP with `COOKIE_SECURE=true`. Use HTTPS |
| nginx won't start | `nginx/certs/tls.crt` or `tls.key` is missing |
| Port 443 already in use | Change `HTTPS_PORT`/`HTTP_PORT`, or set `HTTPS_BIND` to a specific IP |

---

## 11. GitHub repository

The code lives at **https://github.com/Shivamgarud8/Server_invetory** (keep it **private**: it holds no secrets, but it describes your internal infrastructure).

`.gitignore` keeps `.env`, TLS certificates, backups, `node_modules` and build output out of Git. Before every push, check:

```bash
git status --short      # .env, nginx/certs/tls.*, node_modules must NOT appear
```

Publishing your changes:

```bash
git add -A
git commit -m "describe the change"
git push                # password prompt = a GitHub Personal Access Token, or use an SSH remote
```

On a server you only pull: `git pull && docker compose up -d --build`.

> When copying the project folder by hand, use `cp -a` (or `rsync -a`). A plain `cp -r dir/*` skips hidden files like `.gitignore` and `.env.example`.
