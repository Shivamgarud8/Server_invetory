#!/usr/bin/env bash
# Restore a dump made by backup.sh into the database configured in .env.
#   ./scripts/restore.sh /path/to/tagid_infra_manager-YYYYmmdd-HHMMSS.dump
# Stop the backend first:  docker compose stop tagid-portal-backend
set -euo pipefail
. "$(dirname "$0")/_env.sh"
DUMP="${1:?Usage: restore.sh <dump-file>}"
[ -f "$DUMP" ] || { echo "No such file: $DUMP" >&2; exit 1; }
echo "This REPLACES all data in '$DB_NAME' on $PGHOST_FROM_HOST:$DB_PORT."
read -r -p "Type the database name to continue: " ans
[ "$ans" = "$DB_NAME" ] || { echo "Aborted."; exit 1; }
pg "$DB_USER" "$DB_PASSWORD" pg_restore -d "$DB_NAME" --clean --if-exists --no-owner --no-privileges --single-transaction < "$DUMP"
echo "Restore complete. Start the backend: docker compose up -d"
