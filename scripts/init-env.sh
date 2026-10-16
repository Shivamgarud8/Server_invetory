#!/usr/bin/env bash
# Creates a complete, ready-to-use .env from .env.example:
#   - generates DB_PASSWORD, APP_SECRET_KEY, CREDENTIAL_ENCRYPTION_KEY, BOOTSTRAP_ADMIN_PASSWORD
#   - fills SERVER_LABEL / APP_SERVER_IP / PUBLIC_URL with this server's IP
#   - default database: the portal's own container "server-db" (port 5269)
#
# Usage:
#   ./scripts/init-env.sh                         # auto-detect this server's IP
#   ./scripts/init-env.sh --ip 10.129.0.106 --label srv-106
#   ./scripts/init-env.sh --db-host 10.129.0.13 --db-port 5432   # use an existing PostgreSQL instead
#   ./scripts/init-env.sh --force                 # overwrite an existing .env (old one is kept as a backup)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

IP="" LABEL="" DB_HOST_ARG="" DB_PORT_ARG="" FORCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --ip) IP="$2"; shift 2 ;;
    --label) LABEL="$2"; shift 2 ;;
    --db-host) DB_HOST_ARG="$2"; shift 2 ;;
    --db-port) DB_PORT_ARG="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

if [ -f .env ] && [ "$FORCE" -ne 1 ]; then
  echo ".env already exists — not touching it. Use --force to replace it (a backup is kept)." >&2
  exit 1
fi
if [ -f .env ]; then
  cp -p .env ".env.bak.$(date +%Y%m%d-%H%M%S)"
  echo "Existing .env backed up. NOTE: new keys are generated — copy APP_SECRET_KEY and"
  echo "CREDENTIAL_ENCRYPTION_KEY from the backup if this portal already holds data."
fi

[ -n "$IP" ] || IP="$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p')"
[ -n "$IP" ] || IP="$(hostname -I | awk '{print $1}')"
[ -n "$LABEL" ] || LABEL="$(hostname -s)"
if [ -n "$DB_HOST_ARG" ]; then EXTERNAL=1; DBH="$DB_HOST_ARG"; DBP="${DB_PORT_ARG:-5432}"; PROFILES=""
else EXTERNAL=0; DBH="server-db"; DBP="${DB_PORT_ARG:-5269}"; PROFILES="server-db"; fi

alnum() { openssl rand -base64 96 | tr -dc 'A-Za-z0-9' | cut -c1-"$1"; }

declare -A VALUES=(
  [SERVER_LABEL]="$LABEL"
  [APP_SERVER_IP]="$IP"
  [PUBLIC_URL]="http://$IP:3006"
  [COMPOSE_PROFILES]="$PROFILES"
  [DB_HOST]="$DBH"
  [DB_PORT]="$DBP"
  [DB_PASSWORD]="$(alnum 40)"
  [APP_SECRET_KEY]="$(alnum 64)"
  [CREDENTIAL_ENCRYPTION_KEY]="$(openssl rand -base64 32)"
  [BOOTSTRAP_ADMIN_PASSWORD]="$(alnum 16)Aa1!"
)

umask 077
tmp="$(mktemp .env.XXXXXX)"
while IFS= read -r line || [ -n "$line" ]; do
  key="${line%%=*}"
  if [[ "$line" =~ ^[A-Z_]+= ]] && [ -n "${VALUES[$key]+x}" ]; then
    printf '%s=%s\n' "$key" "${VALUES[$key]}"
  else
    printf '%s\n' "$line"
  fi
done < .env.example > "$tmp"
mv "$tmp" .env
chmod 600 .env

cat <<EOF
.env created (permissions 600).

  Server        : $LABEL  ($IP)
  Portal URL    : http://$IP:3006      (API: http://$IP:8090/api/health)
  Database      : ${DBH}:${DBP} / tagid_infra_manager / user infra_manager_app
  First login   : admin / ${VALUES[BOOTSTRAP_ADMIN_PASSWORD]}   (you must change it at first login)

Next:
EOF
if [ "$EXTERNAL" -eq 0 ]; then
  echo "  1. docker compose up -d --build        (starts server-db on port $DBP too)"
else
  echo "  1. Put your PostgreSQL superuser password in DB_ADMIN_PASSWORD (nano .env)"
  echo "  2. ./scripts/setup-db.sh"
  echo "  3. docker compose up -d --build"
fi
echo
echo "Back up APP_SECRET_KEY and CREDENTIAL_ENCRYPTION_KEY from .env in a password manager."
