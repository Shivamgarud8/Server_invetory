#!/usr/bin/env bash
# Creates DB_NAME and DB_USER on the PostgreSQL server from .env, using DB_ADMIN_USER / DB_ADMIN_PASSWORD.
# Safe to re-run: it also resets DB_USER's password to DB_PASSWORD.
set -euo pipefail
. "$(dirname "$0")/_env.sh"

if bundled; then
  echo "DB_HOST=tagid-portal-postgres: the bundled container creates the database itself — nothing to do."
  exit 0
fi
: "${DB_ADMIN_PASSWORD:?Set DB_ADMIN_PASSWORD (PostgreSQL superuser password) in .env}"
: "${DB_PASSWORD:?Set DB_PASSWORD in .env}"

echo "Connecting to $PGHOST_FROM_HOST:$DB_PORT as ${DB_ADMIN_USER:-postgres}…"
pg "${DB_ADMIN_USER:-postgres}" "$DB_ADMIN_PASSWORD" psql -d postgres -q < "$ROOT/scripts/setup-db.sql"

echo "Testing login as $DB_USER…"
pg "$DB_USER" "$DB_PASSWORD" psql -d "$DB_NAME" -tAc "SELECT 'ok: connected to ' || current_database() || ' as ' || current_user"
echo "Done. You can now remove DB_ADMIN_PASSWORD from .env."
