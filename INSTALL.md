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

One command creates a complete `.env`. It generates every password and key and fills in this server's IP:

```bash
./scripts/init-env.sh                              # auto-detects this server's IP and hostname
# or be explicit:
./scripts/init-env.sh --ip 10.80.0.106 --label srv-106
./scripts/init-env.sh --db-host 10.80.0.13          # PostgreSQL on another server
./scripts/init-env.sh --bundled-db                 # use the bundled PostgreSQL container
```

It prints the first-login password. The file gets permissions `600`. If a `.env` already exists, the script refuses to overwrite it; `--force` replaces it and keeps a backup.

Afterwards, open `.env` and set **`DB_ADMIN_PASSWORD`** (your PostgreSQL superuser password). Check `DB_HOST` if PostgreSQL is not on this server.

`.env` lists **every** setting. An empty value (`KEY=`) means "use the default", or for keys and passwords, "generate automatically".

### Variables reference

**1. This server**

| Variable | Filled by init-env | Meaning |
|---|---|---|
| `SERVER_LABEL` | hostname | Shown in the top bar, login page and browser tab |
| `APP_SERVER_IP` | this server's IP | Informational only |
| `PUBLIC_URL` | `https://<IP>` | Address users open (no trailing slash). Change it if you use a DNS name |
| `HTTPS_BIND` | `0.0.0.0` | Interface nginx listens on. Set the private IP to keep the portal internal |
| `HTTPS_PORT` / `HTTP_PORT` | `443` / `80` | Published ports. HTTP only redirects to HTTPS |

**2. Database server**

| Variable | Default | Meaning |
|---|---|---|
| `DB_HOST` | this server's IP | PostgreSQL IP **as seen from the backend container** (see section 5) |
| `DB_PORT` | `5432` | PostgreSQL port |
| `DB_NAME` / `DB_USER` | `tagid_infra_manager` / `infra_manager_app` | Dedicated database and least-privilege user |
| `DB_PASSWORD` | *(generated)* | Password for `DB_USER`. `setup-db.sh` applies it |
| `DB_SSLMODE` | `prefer` | Use `require` when the DB is on another machine |
| `DB_ADMIN_USER` / `DB_ADMIN_PASSWORD` | `postgres` / **you fill this** | Superuser, only used once by `setup-db.sh`. Delete the password afterwards |
| `DATABASE_URL` | *(empty)* | A full connection URL. If set, it replaces the `DB_*` values |

**3. Application**

| Variable | Default | Meaning |
|---|---|---|
| `APP_NAME` | `TagID Infra Manager` | Footer and browser title |
| `APP_ENV` | `production` | `development` enables `/api/docs` |
| `APP_HOST` / `APP_PORT` | `0.0.0.0` / `8080` | Backend inside its container. **Keep as is**, because nginx expects 8080 |
| `APP_WORKERS` | `2` | Backend worker processes |
| `APP_VERSION` | `1.3.0` | Docker image tag |
| `TZ` | `Asia/Kolkata` | Time zone |
| `DEFAULT_THEME` | `system` | `light`, `dark` or `system`. Each user can change it |

**4. Security / sessions**

| Variable | Default | Meaning |
|---|---|---|
| `APP_SECRET_KEY` | *(generated)* | Protects 2FA secrets. **Keep it the same when moving servers** |
| `SESSION_IDLE_MINUTES` / `SESSION_ABSOLUTE_HOURS` | `30` / `12` | Idle logout / maximum session length |
| `LOGIN_MAX_FAILED_ATTEMPTS` / `LOGIN_LOCKOUT_MINUTES` | `5` / `15` | Account lockout after repeated failed logins |
| `COOKIE_SECURE` | `true` | Only set `false` for plain-HTTP local development |
| `ALLOWED_ORIGINS` | *(empty = `PUBLIC_URL`)* | Extra browser origins to allow |
| `TRUSTED_NETWORKS` | private ranges | Only these CIDRs may use the portal. Empty means no restriction |
| `TRUSTED_PROXIES` | Docker ranges | The nginx container network. Leave the default |

**5. Credential vault**

| Variable | Default | Meaning |
|---|---|---|
| `VAULT_PROVIDER` | `local` | `local`: passwords encrypted in PostgreSQL. `hashicorp`: stored in HashiCorp Vault |
| `CREDENTIAL_ENCRYPTION_KEY` | *(generated)* | Encrypts stored passwords. **If you lose this key, every stored password is lost.** Keep it the same when moving servers |
| `VAULT_ADDR`, `VAULT_TOKEN` | *(empty)* | Required for `hashicorp` |
| `VAULT_MOUNT`, `VAULT_PATH_PREFIX`, `VAULT_NAMESPACE`, `VAULT_CA_CERT` | `secret`, `tagid-infra-manager` | Advanced Vault settings |

**6. Data & backups**

| Variable | Default | Meaning |
|---|---|---|
| `DATA_DIR` | `/tagid_data/infra-manager` | Data folder for the bundled PostgreSQL container |
| `BACKUP_DIR` | `backups` | Where `backup.sh` writes dumps. A relative path means inside the project folder |
| `BACKUP_RETENTION_DAYS` | `30` | Older dumps are deleted |
| `CREDENTIAL_EXPIRY_WARNING_DAYS` | `30` | How far ahead the dashboard flags expiring credentials |

**7. First admin**

| Variable | Default | Meaning |
|---|---|---|
| `BOOTSTRAP_ADMIN_ENABLED` | `true` | Create the first admin when there are no users (harmless afterwards) |
| `BOOTSTRAP_ADMIN_USERNAME` | `admin` | First admin's username |
| `BOOTSTRAP_ADMIN_PASSWORD` | *(generated)* | Must be changed at first login. If empty, a random password is printed in the backend log |
| `BOOTSTRAP_ADMIN_EMAIL` | *(empty)* | Optional |

> If `APP_SECRET_KEY` or `CREDENTIAL_ENCRYPTION_KEY` is left empty, it is generated on first start and kept in the `portal-secrets` Docker volume. `./scripts/show-secrets.sh` prints it. A value in `.env` always wins.
>
> `.env` values are read literally. Don't wrap them in quotes and don't use `$` in passwords (Docker Compose treats `$` as a variable).

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

1. Open `PUBLIC_URL` and sign in as `admin` with the password `init-env.sh` printed. You'll also find it as `BOOTSTRAP_ADMIN_PASSWORD` in `.env`. If you left it empty, run `docker compose logs tagid-portal-backend | grep "FIRST ADMIN"`.
2. Set a new password when prompted.
3. Go to **Profile → Set up 2FA**.
4. **Back up** `APP_SECRET_KEY` and `CREDENTIAL_ENCRYPTION_KEY` from `.env` in a password manager, not next to the DB backups.
5. In `.env`, empty `DB_ADMIN_PASSWORD` and `BOOTSTRAP_ADMIN_PASSWORD`. Neither is needed any more.
6. Go to **User Management → Add User** to create the team's logins. Pick roles, and optionally restrict each user to certain environments.
7. Go to **Excel Import** and import the sheets in this order: servers, then credentials, then versions.

### Post-install checklist

- [ ] `.env` has permissions `600` and is not in Git
- [ ] `DB_ADMIN_PASSWORD` and `BOOTSTRAP_ADMIN_PASSWORD` emptied in `.env`
- [ ] `APP_SECRET_KEY` and `CREDENTIAL_ENCRYPTION_KEY` saved in a password manager
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
| Show auto-generated keys | `./scripts/show-secrets.sh` (only needed if the keys were left empty in `.env`) |
| Restore | `docker compose stop tagid-portal-backend && ./scripts/restore.sh <file.dump> && docker compose up -d` |

Nightly backup (`crontab -e`):

```cron
15 2 * * * /opt/tagid-infra-manager/scripts/backup.sh >> /var/log/tagid-infra-backup.log 2>&1
```

Copy the backup directory off the server, e.g. with rsync or your `dbackup` tool.

---

## 9. Move to another server (e.g. 106 → new server)

Everything lives in PostgreSQL, plus `.env`. Copy the old `.env`, keep its keys, and change only the server and DB lines.

**Never change these when moving:** `APP_SECRET_KEY`, `CREDENTIAL_ENCRYPTION_KEY`, and `DB_PASSWORD` (when restoring a backup).
If you started with empty keys, get the generated values with `./scripts/show-secrets.sh` on the old server and paste them into `.env`.

### Case 1 — Only the app moves, the database stays where it is

```bash
# on the NEW server
git clone https://github.com/Shivamgarud8/Server_invetory.git /opt/tagid-infra-manager && cd /opt/tagid-infra-manager
scp srv-106:/opt/tagid-infra-manager/.env .
scp srv-106:/opt/tagid-infra-manager/nginx/certs/tls.* nginx/certs/
nano .env      # change SERVER_LABEL, APP_SERVER_IP, PUBLIC_URL, HTTPS_BIND
# allow the new server's IP in the DB server's pg_hba.conf and firewall
docker compose up -d --build
# check everything works, then on 106: docker compose down
```

### Case 2 — Both the app and the database move

```bash
# 1. on 106
docker compose stop tagid-portal-backend    # stop changes during the dump
./scripts/backup.sh                         # → backups/<file>.dump

# 2. on the NEW server
git clone https://github.com/Shivamgarud8/Server_invetory.git /opt/tagid-infra-manager && cd /opt/tagid-infra-manager
scp srv-106:/opt/tagid-infra-manager/.env .
scp srv-106:/opt/tagid-infra-manager/nginx/certs/tls.* nginx/certs/
scp srv-106:/opt/tagid-infra-manager/backups/<file>.dump /tmp/

nano .env      # change: SERVER_LABEL, APP_SERVER_IP, PUBLIC_URL, HTTPS_BIND, DB_HOST, DB_PORT,
               #         DB_ADMIN_PASSWORD (the new server's postgres password)
               # keep:   DB_NAME, DB_USER, DB_PASSWORD, APP_SECRET_KEY, CREDENTIAL_ENCRYPTION_KEY

./scripts/setup-db.sh                       # creates the empty DB and user on the new DB server
./scripts/restore.sh /tmp/<file>.dump       # type the DB name to confirm
docker compose up -d --build

# 3. check: log in, open a credential, click Show — the password must decrypt.
#    Then point users at the new PUBLIC_URL and on 106: docker compose down
```

This procedure was tested end to end. Every stored password decrypted correctly on the new database.

---

## 10. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Backend restarts with `Set DB_PASSWORD (or DATABASE_URL)` | `DB_PASSWORD` is empty or still a `REPLACE_` value |
| `connection refused` / timeout to the DB | `DB_HOST` must be reachable **from inside Docker**. Don't use `localhost`; use the server's IP. Check PostgreSQL `listen_addresses`, `pg_hba.conf` and the firewall |
| `password authentication failed for user "infra_manager_app"` | Run `./scripts/setup-db.sh` again. It resets the password to `DB_PASSWORD` |
| `setup-db.sh`: `password authentication failed for user "postgres"` | Wrong `DB_ADMIN_PASSWORD` |
| Lost the first admin password | It's `BOOTSTRAP_ADMIN_PASSWORD` in `.env`. If that was empty: `docker compose logs tagid-portal-backend \| grep "FIRST ADMIN"` |
| "Unable to decrypt secret" after a move | `CREDENTIAL_ENCRYPTION_KEY` differs from the old server's. Copy the old value into `.env` |
| 2FA codes rejected after a move | `APP_SECRET_KEY` wasn't carried over. Restore it in `.env`, or have an admin use **Reset 2FA** on each user |
| `Access denied from this network` | Your IP isn't in `TRUSTED_NETWORKS` |
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
