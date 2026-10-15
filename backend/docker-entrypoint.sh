#!/bin/sh
set -e
echo "Applying database migrations…"
alembic upgrade head
exec uvicorn app.main:app \
  --host "${APP_HOST:-0.0.0.0}" \
  --port "${APP_PORT:-8080}" \
  --workers "${APP_WORKERS:-2}" \
  --no-server-header \
  --no-access-log
