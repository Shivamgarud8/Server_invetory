#!/usr/bin/env bash
# Prints fresh random values (nothing is written). ./scripts/init-env.sh fills them into .env for you.
set -euo pipefail
alnum() { openssl rand -base64 96 | tr -dc 'A-Za-z0-9' | cut -c1-"$1"; }
echo "DB_PASSWORD=$(alnum 40)"
echo "APP_SECRET_KEY=$(alnum 64)"
echo "CREDENTIAL_ENCRYPTION_KEY=$(openssl rand -base64 32)"
echo "BOOTSTRAP_ADMIN_PASSWORD=$(alnum 16)Aa1!"
