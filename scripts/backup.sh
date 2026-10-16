#!/usr/bin/env bash
# PostgreSQL dump (custom format) into BACKUP_DIR. Schedule from cron, e.g.:
#   15 2 * * * /opt/tagid-infra-manager/scripts/backup.sh >> /var/log/tagid-infra-backup.log 2>&1
# With VAULT_PROVIDER=local the dump is useless without CREDENTIAL_ENCRYPTION_KEY — back that key
# up SEPARATELY (password manager / sealed envelope), never next to the dumps.
set -euo pipefail
. "$(dirname "$0")/_env.sh"
BACKUP_DIR="${BACKUP_DIR:-backups}"
[[ "$BACKUP_DIR" = /* ]] || BACKUP_DIR="$ROOT/$BACKUP_DIR"   # relative paths are inside the project folder
mkdir -p "$BACKUP_DIR"
OUT="$BACKUP_DIR/${DB_NAME}-$(date +%Y%m%d-%H%M%S).dump"
pg "$DB_USER" "$DB_PASSWORD" pg_dump -d "$DB_NAME" --format=custom --no-owner --no-privileges > "$OUT"
chmod 600 "$OUT"
find "$BACKUP_DIR" -name "${DB_NAME}-*.dump" -mtime +"${BACKUP_RETENTION_DAYS:-30}" -delete
echo "$(date -Is) backup written: $OUT ($(du -h "$OUT" | cut -f1))"
