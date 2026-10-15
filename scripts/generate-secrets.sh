#!/usr/bin/env bash
# Prints fresh random values to paste into .env. Nothing is written to disk.
set -euo pipefail
rand() { openssl rand -base64 64 | tr -d '\n/+=' | cut -c1-"$1"; }
echo "DB_PASSWORD=$(rand 40)"
echo "APP_SECRET_KEY=$(rand 64)"
echo "CREDENTIAL_ENCRYPTION_KEY=$(openssl rand -base64 32)"
echo "BOOTSTRAP_ADMIN_PASSWORD=$(rand 20)Aa1!"
