# Installation Guide — TagID Infra Manager

This guide covers a fresh install, connecting to your PostgreSQL server, day-to-day operations, and **moving the portal from one server to another** (for example from server 106 to a new machine).

---

## 1. What gets deployed

```
                       ┌──────────────── Application server (e.g. srv-106, 10.129.0.106) ────────────────┐
 Browser ── http ────▶ │ :3006  tagid-portal-frontend  (web UI, forwards /api ──▶ backend)               │
 (curl / scripts) ───▶ │ :8090  tagid-portal-backend   (FastAPI)                                          │
 (pgAdmin, backups) ─▶ │ :5269  server-db              (PostgreSQL, this portal's own database)            │
                       └─────────────────────────────────────────────────────────────────────────────────┘
```

| Container | Built from | Host port | Purpose |
|---|---|---|---|
| `tagid-portal-frontend` | `frontend/Dockerfile` (Node build → small static web server) | `FRONTEND_PORT` (3006) | Web UI. Forwards `/api` to the backend, so the browser only ever talks to one address |
| `tagid-portal-backend` | `backend/Dockerfile` (Python 3.12 slim, non-root) | `BACKEND_PORT` (8090) | API. Checks the DB connection and runs migrations automatically on start |
| `tagid-portal-scheduler` | same image as the backend | — | Background worker: scheduled email reports, status checks and daily configuration snapshots. Runs even when nobody is logged in |
| `server-db` | `postgres:18-alpine` (enabled by `COMPOSE_PROFILES=server-db`, the default) | `DB_PORT` (5269) | The portal's **own** database. Your other PostgreSQL servers are never touched. Optional: point the portal at an existing PostgreSQL instead (section 5) |

There is no separate nginx or reverse proxy. You open the portal directly at **`http://<server-ip>:3006`**.

Everything the deployment needs comes from **one file: `.env`**.

---

## 2. Requirements

| | Minimum |
|---|---|
| OS | Ubuntu 22.04/24.04, or any Linux with Docker |
| Docker | Engine 24+ with the Compose v2 plugin (`docker compose version`) |
| Resources | 1 vCPU, 1 GB RAM, 2 GB disk (plus database storage) |
| PostgreSQL | Included (`server-db` container). Or an existing PostgreSQL 13+ |
| Network | Free ports on the server: `FRONTEND_PORT` 3006 (users), `BACKEND_PORT` 8090 (API), `DB_PORT` 5269 (database — keep it firewalled to admins only) |
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
./scripts/init-env.sh --ip 10.129.0.106 --label srv-106
./scripts/init-env.sh --db-host 10.129.0.13 --db-port 5432   # use an existing PostgreSQL instead of server-db
```

It prints the first-login password. The file gets permissions `600`. If a `.env` already exists, the script refuses to overwrite it; `--force` replaces it and keeps a backup.

With the default **server-db** there is nothing else to fill in, so go straight to section 7. Only if you use an existing PostgreSQL (`--db-host`) do you also set `DB_ADMIN_PASSWORD` and run `setup-db.sh` (section 5).

`.env` lists **every** setting. An empty value (`KEY=`) means "use the default", or for keys and passwords, "generate automatically".

### Variables reference

**1. This server**

| Variable | Filled by init-env | Meaning |
|---|---|---|
| `SERVER_LABEL` | hostname | Shown in the top bar, login page and browser tab |
| `APP_SERVER_IP` | this server's IP | Informational only |
| `PUBLIC_URL` | `http://<IP>:3006` | Address users open (no trailing slash). Must match `FRONTEND_PORT` |
| `BIND_IP` | `0.0.0.0` | Interface the ports listen on. Set this server's private IP to keep the portal off other interfaces |
| `FRONTEND_PORT` | `3006` | Web UI port: `http://<IP>:3006` |
| `BACKEND_PORT` | `8090` | API port: `http://<IP>:8090/api/health` |

**2. Database server**

| Variable | Default | Meaning |
|---|---|---|
| `COMPOSE_PROFILES` | `server-db` | Starts the portal's own database container. Leave it empty to use an existing PostgreSQL |
| `DB_HOST` | `server-db` | `server-db`, or the IP of an existing PostgreSQL **as seen from the backend container** |
| `DB_PORT` | `5269` | Port of `server-db` (inside Docker and on the server). For an existing PostgreSQL, its port |
| `DB_NAME` / `DB_USER` | `tagid_infra_manager` / `infra_manager_app` | Dedicated database and least-privilege user |
| `DB_PASSWORD` | *(generated)* | Password for `DB_USER`. `server-db` is created with it on first start |
| `DB_SSLMODE` | `prefer` | Use `require` when the DB is on another machine |
| `DB_ADMIN_USER` / `DB_ADMIN_PASSWORD` | `postgres` / *(empty)* | Existing PostgreSQL only: superuser used once by `setup-db.sh`. Not needed with `server-db` |
| `DATABASE_URL` | *(empty)* | A full connection URL. If set, it replaces the `DB_*` values |

**3. Application**

| Variable | Default | Meaning |
|---|---|---|
| `APP_NAME` | `TagID Infra Manager` | Footer and browser title |
| `APP_ENV` | `production` | `development` enables `/api/docs` |
| `APP_WORKERS` | `2` | Backend worker processes |
| `APP_VERSION` | `1.5.0` | Docker image tag |
| `TZ` | `Asia/Kolkata` | Time zone |
| `DEFAULT_THEME` | `system` | `light`, `dark` or `system`. Each user can change it |

**4. Security / sessions**

| Variable | Default | Meaning |
|---|---|---|
| `APP_SECRET_KEY` | *(generated)* | Protects 2FA secrets. **Keep it the same when moving servers** |
| `SESSION_IDLE_MINUTES` / `SESSION_ABSOLUTE_HOURS` | `30` / `12` | Idle logout / maximum session length |
| `LOGIN_MAX_FAILED_ATTEMPTS` / `LOGIN_LOCKOUT_MINUTES` | `5` / `15` | Account lockout after repeated failed logins |
| `COOKIE_SECURE` | *(empty = automatic)* | Secure cookies only when `PUBLIC_URL` is `https://`. **Must be empty or `false` for `http://` access**, otherwise login fails |
| `ALLOWED_ORIGINS` | *(empty = `PUBLIC_URL`)* | Extra browser origins to allow |
| `TRUSTED_NETWORKS` | private ranges | Only these CIDRs may use the portal. Empty means no restriction |
| `TRUSTED_PROXIES` | Docker ranges | The frontend container network. Leave the default |

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
| `DATA_DIR` | `/tagid_data/infra-manager` | `server-db` stores its database files in `DATA_DIR/postgres` |
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

## 5. Database

### Default — the portal's own `server-db` container

Nothing to prepare. With `COMPOSE_PROFILES=server-db`, `DB_HOST=server-db` and `DB_PORT=5269` (what `init-env.sh` writes), `docker compose up -d` also starts **`server-db`**:

- a dedicated PostgreSQL 18 that creates `DB_NAME` and `DB_USER` with `DB_PASSWORD` on first start
- listening on **port 5269**, inside Docker and on the server (`BIND_IP:5269`), for pgAdmin or `psql`
- data stored in `${DATA_DIR}/postgres` on the server, so it survives restarts and upgrades
- your other PostgreSQL servers and ports are **not touched**

Connect from the server: `psql -h 127.0.0.1 -p 5269 -U infra_manager_app tagid_infra_manager`. Firewall port 5269 so only admins can reach it.

### Optional — use an existing PostgreSQL instead

Empty `COMPOSE_PROFILES`, then pick the case that matches.

#### A. Existing PostgreSQL on the same server

The backend runs in its own Docker network, so `localhost` would point at the backend container itself. Use the **server's private IP** instead:

```ini
DB_HOST=10.129.0.106        # this server's private IP
DB_PORT=5432
DB_ADMIN_USER=postgres
DB_ADMIN_PASSWORD=<postgres superuser password>
```

#### B. PostgreSQL on a separate database server

```ini
DB_HOST=10.129.0.13         # DB server IP
DB_PORT=5432
DB_SSLMODE=require         # optional, recommended for a remote DB
```

On the DB server, allow connections from the app server only:

```conf
# postgresql.conf
listen_addresses = '*'          # or the DB server's private IP

# pg_hba.conf  (replace with your app server's IP)
host  tagid_infra_manager  infra_manager_app  10.129.0.106/32  scram-sha-256
```

Then reload PostgreSQL and open the firewall for that IP only, e.g. `sudo ufw allow from 10.129.0.106 to any port 5432 proto tcp`.

#### Create the database and user (A and B)

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

---

## 6. Ports & access

| What | URL |
|---|---|
| Web UI | `http://<server-ip>:FRONTEND_PORT`, e.g. `http://10.129.0.106:3006` |
| API health check | `http://<server-ip>:BACKEND_PORT/api/health`, e.g. `http://10.129.0.106:8090/api/health` |
| Database (server-db) | `<server-ip>:DB_PORT`, e.g. `10.129.0.106:5269` |

- To change ports, edit `FRONTEND_PORT` / `BACKEND_PORT` / `DB_PORT`. If you change the frontend port, **also update `PUBLIC_URL`**.
- Check that a port is free before using it: `sudo ss -ltnp | grep -E ':(3006|8090|5269)\b'` should print nothing.
- Don't add `APP_PORT` to `.env`. The backend always uses 8080 inside its container, and `BACKEND_PORT` decides the port on the server.
- Open the ports in the server firewall if needed, e.g. `sudo ufw allow from 10.129.0.0/16 to any port 3006 proto tcp`.

> **Security note:** on plain `http://`, traffic, including passwords you reveal, crosses the network unencrypted. Only use it on a trusted internal network or VPN. If you later put a reverse proxy with HTTPS in front, set `PUBLIC_URL=https://…` and secure cookies switch on automatically.

---

## 7. Start

```bash
docker compose up -d --build                         # starts server-db (if enabled), backend, frontend

docker compose ps
docker compose logs -f tagid-portal-backend          # look for "PostgreSQL OK" and "Application startup complete"
curl http://127.0.0.1:8090/api/health               # {"status":"ok",...}
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

## 8a. Email reports (e.g. every 15 days)

1. Go to **Email & Reports**. Pick a preset (Gmail, Microsoft 365, Zoho or SES), or enter the SMTP host, port and encryption.
2. **Gmail:** turn on 2-Step Verification, then create an app password at Google Account → Security → *App passwords*. Use your Gmail address as the username and the 16-character app password.
3. Fill in the sender, the recipients and the schedule, e.g. *Every N days* = 15, time `10:00`, zone `Asia/Kolkata`, first send date.
4. Click **Send test email**, then **Send report now** to check what arrives.
5. Tick **Send reports automatically**. The `tagid-portal-scheduler` container then sends them, and the dashboard shows the next date.

The app password is stored encrypted and never appears in emails or exports. If you attach the encrypted recovery bundle, its passphrase is never put in the email; keep it in a password manager.

## 8b. Disaster recovery for the inventory

- **Backup & Recovery → Download inventory**: everything except passwords. Safe to store in the usual places.
- **Create recovery bundle**: includes the current passwords, encrypted with a passphrase you choose. Store the file and the passphrase **separately**.
- **Restore** on a fresh portal (for example after the server is lost): upload the file (plus the passphrase for a bundle) → review the preview → confirm with your password. A pre-import snapshot is taken first. Restoring only writes inventory records; it never runs commands or changes passwords on real servers.
- The scheduler also stores a daily snapshot (the last 30 are kept, visible on the same page).

## 9. Move to another server (e.g. 106 → new server)

Everything lives in PostgreSQL, plus `.env`. Copy the old `.env`, keep its keys, and change only the server and DB lines.

**Never change these when moving:** `APP_SECRET_KEY`, `CREDENTIAL_ENCRYPTION_KEY`, and `DB_PASSWORD` (when restoring a backup).
If you started with empty keys, get the generated values with `./scripts/show-secrets.sh` on the old server and paste them into `.env`.

### With `server-db` (default)

```bash
# 1. on 106
docker compose stop tagid-portal-backend    # stop changes during the dump
./scripts/backup.sh                         # → backups/<file>.dump

# 2. on the NEW server
git clone https://github.com/Shivamgarud8/Server_invetory.git /opt/tagid-infra-manager && cd /opt/tagid-infra-manager
scp srv-106:/opt/tagid-infra-manager/.env .
scp srv-106:/opt/tagid-infra-manager/backups/<file>.dump /tmp/
nano .env      # change: SERVER_LABEL, APP_SERVER_IP, PUBLIC_URL, BIND_IP
               # keep:   DB_*, APP_SECRET_KEY, CREDENTIAL_ENCRYPTION_KEY

docker compose up -d server-db              # start only the database
./scripts/restore.sh /tmp/<file>.dump       # type the DB name to confirm
docker compose up -d --build

# 3. check: log in, open a credential, click Show — the password must decrypt.
#    Then point users at the new PUBLIC_URL and on 106: docker compose down
```

### With an existing PostgreSQL

**Only the app moves (the database stays):** copy `.env`, change `SERVER_LABEL`, `APP_SERVER_IP`, `PUBLIC_URL` and `BIND_IP`, allow the new server's IP in the DB server's `pg_hba.conf` and firewall, then run `docker compose up -d --build`.

**The database moves too:** as above, but on the new server set `DB_HOST`, `DB_PORT` and `DB_ADMIN_PASSWORD`, then run `./scripts/setup-db.sh` → `./scripts/restore.sh /tmp/<file>.dump` → `docker compose up -d --build`.

This procedure was tested end to end. Every stored password decrypted correctly on the new database.

---

## 9b. Upgrading

```bash
cd ~/DevOps/Server_invetory
git checkout main && git pull
docker compose up -d --build        # migrations run automatically; the new scheduler container starts too
docker compose ps                   # backend, frontend, scheduler (+ server-db)
```

Your data, users and `.env` are kept. **v2.1.0** adds the clients, domains, architecture, password-history, report and backup tables (migration `0002`). Existing built-in roles automatically receive the new permissions; custom roles keep what you gave them.

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
| `STARTUP ERROR: DB_HOST=… is not a valid IP address` | Typo in `DB_HOST` (e.g. `10.8129.0.106` instead of `10.129.0.106`) |
| `STARTUP ERROR: cannot reach PostgreSQL at …` | Wrong `DB_HOST`/`DB_PORT`, PostgreSQL not listening on that IP, or a firewall in between. Test from the server: `nc -zv <DB_HOST> <DB_PORT>` |
| Login seems to work but you're sent back to the login page | `COOKIE_SECURE=true` while using `http://`. Leave `COOKIE_SECURE` empty |
| Browser can't open `http://<ip>:3006` | Check `docker compose ps`, that `FRONTEND_PORT` is open in the firewall, and that `BIND_IP` isn't `127.0.0.1` |
| Scheduler log shows `relation … does not exist` once at start | Normal on the very first start: it retries every 30 s, after the backend has run the migrations |
| No email arrives | Check **Email & Reports → Delivery history** for the SMTP error. For Gmail you need an *app password*, not your normal password |
| `port is already allocated` | Another service uses that port. Change `FRONTEND_PORT` / `BACKEND_PORT` (and `PUBLIC_URL`) |

---

## 11. GitHub repository

The code lives at **https://github.com/Shivamgarud8/Server_invetory** (keep it **private**: it holds no secrets, but it describes your internal infrastructure).

`.gitignore` keeps `.env`, backups, `node_modules` and build output out of Git. Before every push, check:

```bash
git status --short      # .env and node_modules must NOT appear
```

Publishing your changes:

```bash
git add -A
git commit -m "describe the change"
git push                # password prompt = a GitHub Personal Access Token, or use an SSH remote
```

On a server you only pull: `git pull && docker compose up -d --build`.

> When copying the project folder by hand, use `cp -a` (or `rsync -a`). A plain `cp -r dir/*` skips hidden files like `.gitignore` and `.env.example`.
