# Shared helper: load .env and expose a psql runner that works from any host with Docker.
# shellcheck shell=bash
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -f "$ROOT/.env" ] || { echo "Missing $ROOT/.env — copy .env.example first" >&2; exit 1; }
# Parse KEY=VALUE lines literally (no shell evaluation), like docker compose does
while IFS= read -r line || [ -n "$line" ]; do
  line="${line%$'\r'}"
  [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
  [[ "$line" == *=* ]] || continue
  key="${line%%=*}"; key="${key//[[:space:]]/}"; val="${line#*=}"
  if [[ "$val" =~ ^\"(.*)\"$ ]] || [[ "$val" =~ ^\'(.*)\'$ ]]; then val="${BASH_REMATCH[1]}"; fi
  [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] && export "$key=$val"
done < "$ROOT/.env"
unset line key val
DB_PORT="${DB_PORT:-5432}"
# From the host, "host.docker.internal" and the bundled container name are not resolvable
case "$DB_HOST" in
  host.docker.internal|localhost) PGHOST_FROM_HOST=127.0.0.1 ;;
  *) PGHOST_FROM_HOST="$DB_HOST" ;;
esac
PG_IMAGE="${PG_CLIENT_IMAGE:-postgres:18-alpine}"

bundled() { [ "$DB_HOST" = "server-db" ]; }

# pg <user> <password> <cmd...>   — runs a PostgreSQL client tool with the given credentials
pg() {
  local user="$1" pass="$2"; shift 2
  if bundled; then
    docker exec -i -e PGPASSWORD="$pass" server-db "$@" -U "$user" -h 127.0.0.1 -p "$DB_PORT"
  else
    docker run --rm -i --network host -e PGPASSWORD="$pass" -e PGSSLMODE="${DB_SSLMODE:-prefer}" \
      -e APP_DB="$DB_NAME" -e APP_USER="$DB_USER" -e APP_PASSWORD="$DB_PASSWORD" \
      "$PG_IMAGE" "$@" -U "$user" -h "$PGHOST_FROM_HOST" -p "$DB_PORT"
  fi
}
