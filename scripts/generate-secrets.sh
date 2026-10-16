#!/usr/bin/env bash
# Prints a strong random DB_PASSWORD to paste into .env. Nothing is written to disk.
# (APP_SECRET_KEY and CREDENTIAL_ENCRYPTION_KEY are generated automatically on first start.)
set -euo pipefail
echo "DB_PASSWORD=$(openssl rand -base64 64 | tr -d '\n/+=' | cut -c1-40)"
