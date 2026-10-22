#!/usr/bin/env bash
# Restore the ready-made ProcureGuard demo: TideCloak (realm test1, roles, agent clients, Tide licence)
# plus the app's .env. The bundle is AES-256 encrypted; get the passphrase from the team (never in git).
#
# Usage: scripts/restore-demo.sh            (prompts for the passphrase)
#        PG_PASSPHRASE=... scripts/restore-demo.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUNDLE="$ROOT/demo-bundle/procureguard-demo.tar.gz.enc"
IMG="tideorg/tidecloak-dev@sha256:3f52d0bc3e4e3ae5153e172960003bbe94705cd40af6561fd4c7c4434aaa2708"
NAME="procureguard-tidecloak"

for cmd in docker openssl node npm curl; do
  command -v "$cmd" >/dev/null || { echo "missing: $cmd"; exit 1; }
done

if [ -z "${PG_PASSPHRASE:-}" ]; then
  read -r -s -p "Bundle passphrase: " PG_PASSPHRASE; echo
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
echo "1/5 Decrypting bundle"
PG_PASSPHRASE="$PG_PASSPHRASE" openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -pass env:PG_PASSPHRASE -in "$BUNDLE" \
  | tar -xzf - -C "$TMP" || { echo "wrong passphrase or corrupt bundle"; exit 1; }

echo "2/5 Writing .env"
install -m 600 "$TMP/procureguard.env" "$ROOT/.env"

echo "3/5 Starting TideCloak with the restored database (ports 8080/9000)"
docker pull -q "$IMG" >/dev/null
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker create --name "$NAME" --restart unless-stopped -p 8080:8080 -p 9000:9000 \
  -e KC_BOOTSTRAP_ADMIN_USERNAME=admin -e KC_BOOTSTRAP_ADMIN_PASSWORD=admin \
  -e KC_HEALTH_ENABLED=true -e KC_METRICS_ENABLED=true "$IMG" >/dev/null
docker cp "$TMP/h2/." "$NAME:/opt/keycloak/data/h2/"
docker start "$NAME" >/dev/null

echo "4/5 Installing app dependencies"
(cd "$ROOT" && npm run install:all >/dev/null)

echo "5/5 Waiting for TideCloak"
for _ in $(seq 60); do
  curl -s -m3 localhost:8080/realms/master/protocol/openid-connect/token \
    -d grant_type=password -d client_id=admin-cli -d username=admin -d password=admin | grep -q access_token && break
  sleep 3
done

cat <<EOF
Ready. Admin console: http://localhost:8080/admin/master/console/#/test1 (admin/admin)
Run (two terminals):
  cd $ROOT && set -a && . ./.env && set +a && cd server && AUTH_MODE=hybrid REALM=test1 API_BASE=http://localhost:4000 DB_PATH=./data/real.db npx tsx src/index.ts
  cd $ROOT/web && VITE_DEV_ROLES=proc.buyer,proc.auditor npx vite      # open http://localhost:5137
Data lives inside the container: 'docker stop/start $NAME' is safe, 'docker rm' wipes it (re-run this script).
EOF
