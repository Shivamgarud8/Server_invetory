#!/usr/bin/env bash
# Self-signed certificate for internal use. Replace with a certificate from your internal CA when available.
set -euo pipefail
HOST="${1:-infra.tagid.internal}"
DIR="$(cd "$(dirname "$0")/.." && pwd)/nginx/certs"
mkdir -p "$DIR"
openssl req -x509 -nodes -newkey rsa:3072 -days 825 \
  -keyout "$DIR/tls.key" -out "$DIR/tls.crt" \
  -subj "/CN=$HOST" -addext "subjectAltName=DNS:$HOST,DNS:localhost,IP:127.0.0.1"
chmod 644 "$DIR/tls.key"  # nginx container runs as non-root and must read it
echo "Wrote $DIR/tls.crt and $DIR/tls.key for $HOST"
