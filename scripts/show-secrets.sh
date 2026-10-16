#!/usr/bin/env bash
# Prints the auto-generated keys so you can back them up, or paste them into .env on a new server.
# Without CREDENTIAL_ENCRYPTION_KEY, stored passwords cannot be decrypted after a server move.
set -euo pipefail
cd "$(dirname "$0")/.."
docker compose exec -T tagid-portal-backend cat /app/secrets/generated.env | grep -v '^#'
